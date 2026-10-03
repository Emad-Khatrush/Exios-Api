// A refund for a customer from the order page (spec 19.6, phase C2). The supplier gave money back
// on a purchase (Alibaba returned 30$, received in lira at a bank); the company adds what it
// decides to the customer's wallet (29$, keeping 1$ as a margin).
//
// One entry: the money that came in lowers the order's purchase cost, and the amount given to the
// wallet lowers what the customer is billed (syncOrder takes it off the claim and the deferred or
// recognised sale). Result: sale 171$, cost 150$, profit 21$ on a 200$ invoice that cost 180$.
// The wallet line in the system is created here, linked to this document, so it is not posted twice.
const mongoose = require('mongoose');
const { CustomerRefund } = require('../../models/documents');
const Order = require('../../../models/order');
const UserStatement = require('../../../models/userStatement');
const { postEntry } = require('../ledger');
const { isDay } = require('../dates');
const { logAudit } = require('../audit');
const { purchaseKey } = require('../claims/keys');
const { fail, currencyOf, getAccount, toCurrencyMinor, moneyLine, nextDocNumber, findExisting, resolveAccount, RateBook } = require('./common');
const { moveWallet } = require('./people');

// What the customer paid on the purchase invoice, in USD cents: the larger of the order's own
// payments (the Payments tab, dinars at the rate each was taken at; a payment just made may still
// be waiting for live posting) and what the books credited to the invoice (old payments that are
// a wallet line only)
async function paidOnInvoice(orderId, session) {
  const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
  const { JournalEntry } = require('../../models');
  const { CLAIM_EVENTS } = require('../claims/keys');
  const payments = await OrderPaymentHistory.find({ order: orderId, category: { $ne: 'receivedGoods' } }).select('receivedAmount currency rate').session(session || null).lean();
  const system = payments.reduce((sum, p) => {
    const amount = Number(p.receivedAmount || 0);
    if (p.currency === 'USD') return sum + amount;
    return Number(p.rate) > 0 ? sum + amount / Number(p.rate) : sum;
  }, 0);
  const receivable = await resolveAccount('customer_receivable');
  const key = purchaseKey(orderId);
  const [row] = await JournalEntry.aggregate([
    { $match: { 'lines.arKey': key, eventType: { $nin: [...CLAIM_EVENTS, 'REFUND', 'CLAIM_WRITEOFF', 'WRITEOFF_RECOVERY', 'ROUNDING'] } } }, { $unwind: '$lines' },
    { $match: { 'lines.arKey': key, 'lines.accountId': receivable._id } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null);
  return Math.max(Math.round(system * 100), row?.net || 0, 0);
}

async function createCustomerRefund(input, { session, req }) {
  const existing = await findExisting(CustomerRefund, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  if (!mongoose.isValidObjectId(input.orderId)) throw fail('الطلب غير موجود');
  const order = await Order.findById(input.orderId).select('orderId user isPayment isCanceled placedAt').session(session).lean();
  if (!order) throw fail('الطلب غير موجود');
  // A cancelled order gave the customer everything back already: what the supplier returns only
  // lowers the cost left on the order (settling it), nothing more goes to the wallet
  if (order.isCanceled && Number(input.walletUsd || 0) > 0) throw fail('الطلب ملغى وأُرجع للعميل كامل المدفوع. ما أعاده المورد يخفض تكلفة الطلب فقط: اجعل المضاف للمحفظة صفراً.');
  if (!order.isPayment) throw fail('الريفاند لفواتير الشراء فقط (مبلغ أعاده المورد على مشتريات الطلب)');
  const to = await getAccount(input.accountId, 'الحساب الذي دخل فيه المال');
  if (!to.isCash) throw fail('اختر الخزينة أو البنك الذي دخل فيه المال');
  const currency = currencyOf(to);
  const minor = await toCurrencyMinor(input.amount, currency);
  if (!minor) throw fail('المبلغ المستلم مطلوب');
  // Its dollars: the amount itself on a dollar account, else the day's rate (owner's decision: the
  // amount received and what goes to the wallet are enough; a dollar value may still be given)
  const rates = new RateBook(session);
  const usd = currency === 'USD' ? minor
    : Number(input.usdValue) > 0 ? Math.round(Number(input.usdValue) * 100) : await rates.toUsd(minor, currency, input.day);
  if (!(usd > 0)) throw fail('تعذّر تقييم المبلغ بالدولار؛ أدخل سعر اليوم لهذه العملة');
  const walletUsd = Math.round(Number(input.walletUsd || 0) * 100);
  if (walletUsd < 0) throw fail('المبلغ المضاف للمحفظة غير صالح');
  // The wallet gets back at most what the customer paid on the invoice, less what earlier refunds
  // gave already (order 2770-4993: 70.26$ paid, 143$ refunded, 2026-10-04)
  if (walletUsd > 0) {
    const paid = await paidOnInvoice(order._id, session);
    const earlier = (await CustomerRefund.find({ orderId: order._id, status: 'posted' }).select('walletUsd').session(session).lean())
      .reduce((sum, r) => sum + (r.walletUsd || 0), 0);
    const left = Math.max(paid - earlier, 0);
    if (walletUsd > left) {
      const before = earlier ? ` وأُرجع له بالريفاند ${earlier / 100}$` : '';
      throw fail(`العميل دفع على الفاتورة ${paid / 100}$${before}؛ أقصى ما يُضاف لمحفظته الآن ${left / 100}$`);
    }
  }

  const [doc] = await CustomerRefund.create([{
    day: input.day, orderId: order._id, partnerId: order.user, accountId: to._id, currency, amount: Number(input.amount), usd, walletUsd,
    note: input.note, attachments: input.attachments, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('RF', input.day, session),
  }], { session });

  const label = `ريفاند ${doc.number} - طلب ${order.orderId}`;
  const office = order.placedAt;
  const lines = [
    moneyLine(to, 'debit', minor, usd, { label }),
    { accountId: (await resolveAccount('purchase_cost_wip'))._id, credit: usd, orderId: order._id, office, label: 'مبلغ أعاده المورد' },
  ];
  if (walletUsd > 0) {
    lines.push(
      { accountId: (await resolveAccount('customer_receivable'))._id, debit: walletUsd, partnerId: order.user, orderId: order._id, arKey: purchaseKey(order._id), label: 'يُخصم من فاتورة العميل' },
      { accountId: (await resolveAccount('wallet_usd'))._id, credit: walletUsd, currency: 'USD', amountCurrency: -walletUsd, partnerId: order.user, label: 'أُضيف لمحفظة العميل' },
    );
  }
  const entry = await postEntry({
    eventType: 'REFUND', eventKey: `CUSTOMER_REFUND:${doc._id}`, date: input.day, description: label,
    source: { model: 'AccountingCustomerRefund', id: doc._id }, fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;

  if (walletUsd > 0) {
    const statement = await moveWallet({
      userId: order.user, currency: 'USD', amount: walletUsd / 100, description: `ريفاند على الطلب ${order.orderId}`, note: doc.number,
      createdBy: req?.user?._id, source: { model: 'AccountingCustomerRefund', id: doc._id },
    }, session);
    await UserStatement.updateOne({ _id: statement._id }, { $set: { actionType: 'refund' } }, { session });
    doc.userStatementId = statement._id;
  }
  await doc.save({ session });
  // The claim, the sale and the cost follow (the cost moved back out of cost of sales if recognised)
  await require('../claims/sync').syncOrder(order._id, { session, user: req?.user, date: input.day });
  await logAudit({ req, action: 'customer.refund', model: 'AccountingCustomerRefund', docId: doc._id, after: doc }, session);
  return doc;
}

module.exports = { createCustomerRefund };
