// Giving back part of what a customer paid on a purchase invoice (owner 2026-11-25). The invoice was
// lowered after it was paid (200$ paid, now 180$): the 20$ goes back to the wallet with a
// description, and the 200$ payment stays as it was. Before this the only way was to cancel the
// whole payment and pay 180$ again, which left two strange lines in the customer's statement.
//
// One entry, Cr wallet_usd, and the debit from where the extra money sits, in this order:
// 1. the credit left on the invoice's claim (the invoice lowered after it was paid)
// 2. the dollar overpayment of this order taken as other revenue at payment time (rule 119: paid
//    more than the invoice; the same label, so what is left of it is the sum of those lines).
//    A dinar margin (fx_gain_loss) is the exchange profit charged on purpose: never given back.
// 3. the rest from the claim: the invoice is owed again by that much (the order page says so)
// The invoice's value is not touched (not a REFUND, which lowers what is billed). The wallet line
// is made here, linked to the document, so it is not posted twice. Cancelled with the generic
// document cancel (rule AccountingPaymentReturn in services/cancel.js), which reverses the entry.
//
// Never more than the money paid on the invoice, less what refunds and earlier returns gave back.
// Points paid on it are not counted: they come back as points, cancelled on the order page.
const mongoose = require('mongoose');
const { PaymentReturn, CustomerRefund } = require('../../models/documents');
const Order = require('../../../models/order');
const UserStatement = require('../../../models/userStatement');
const { postEntry } = require('../ledger');
const { today } = require('../dates');
const { logAudit } = require('../audit');
const { purchaseKey } = require('../claims/keys');
const { fail, nextDocNumber, findExisting, resolveAccount } = require('./common');
const { moveWallet } = require('./people');
const { openBalances, OVERPAID_LABEL } = require('./operations');
const { JournalEntry } = require('../../models');

// What is left of the dollar overpayment of an order taken as other revenue (cents), and its office
async function overpaidProfitOf(orderId, accountId, session) {
  const rows = await JournalEntry.aggregate([
    { $match: { status: { $in: ['posted', 'reversed'] }, 'lines.label': OVERPAID_LABEL, 'lines.orderId': orderId } }, { $unwind: '$lines' },
    { $match: { 'lines.label': OVERPAID_LABEL, 'lines.orderId': orderId, 'lines.accountId': accountId } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } }, office: { $last: '$lines.office' } } },
  ]).session(session || null);
  return { cents: Math.max(rows[0]?.net || 0, 0), office: rows[0]?.office };
}

// What can still go back to the wallet from the invoice, in USD cents
async function returnableOnInvoice(orderId, session) {
  const { paidOnInvoice, pointsOnInvoice } = require('./customerRefund');
  const paid = await paidOnInvoice(orderId, session);
  const refunds = (await CustomerRefund.find({ orderId, status: 'posted' }).select('walletUsd legacyWalletUsd').session(session || null).lean())
    .reduce((sum, r) => sum + (r.walletUsd || 0) + (r.legacyWalletUsd || 0), 0);
  const returned = await returnedOnInvoice(orderId, session);
  return { paid, refunds, returned, left: Math.max(paid - refunds - returned, 0), points: await pointsOnInvoice(orderId) };
}
async function returnedOnInvoice(orderId, session) {
  return (await PaymentReturn.find({ orderId, status: 'posted' }).select('usd').session(session || null).lean()).reduce((sum, r) => sum + (r.usd || 0), 0);
}

async function createPaymentReturn(input, { session, req }) {
  const existing = await findExisting(PaymentReturn, input.idempotencyKey, session);
  if (existing) return existing;
  if (!mongoose.isValidObjectId(input.orderId)) throw fail('الطلب غير موجود');
  const order = await Order.findById(input.orderId).select('orderId user isPayment isCanceled').session(session).lean();
  if (!order || !order.user) throw fail('الطلب غير موجود');
  if (!order.isPayment) throw fail('الإرجاع لفواتير الشراء فقط');
  if (order.isCanceled) throw fail('الطلب ملغى وأُرجع للعميل كامل المدفوع');
  const usd = Math.round(Number(input.amount) * 100);
  if (!Number.isFinite(usd) || usd <= 0) throw fail('اكتب المبلغ المراد إرجاعه');
  const description = String(input.description || '').trim();
  if (!description) throw fail('اكتب بيان الإرجاع (سببه)');
  if (description.length > 300) throw fail('البيان 300 حرف على الأكثر');
  // One at a time per order (as supplier refunds): two returns at once cannot pass the limit together
  const locked = await Order.updateOne({ _id: order._id }, { $inc: { customerRefundVersion: 1 } }, { session });
  if (locked.modifiedCount !== 1) throw fail('الطلب غير متاح للإرجاع الآن');
  const room = await returnableOnInvoice(order._id, session);
  if (usd > room.left) {
    const points = room.points > 0 ? `. ودفع ${room.points / 100}$ بالنقاط: النقاط لا تُرجع فلوساً، ألغِها من نقاط الطلبية فترجع لرصيد نقاطه` : '';
    throw fail(`أقصى ما يُرجع لمحفظة العميل من هذه الفاتورة ${room.left / 100}$ (دفع ${room.paid / 100}$ فلوساً${room.refunds + room.returned ? `، وأُرجع له قبل ${(room.refunds + room.returned) / 100}$` : ''})${points}`);
  }

  // Where the money comes from (see the top of the file)
  const key = purchaseKey(order._id);
  const open = (await openBalances([key], session)).get(key) || 0;
  const fromCredit = Math.min(usd, Math.max(-open, 0));
  const profitAccount = await resolveAccount('revenue_other');
  const profit = await overpaidProfitOf(order._id, profitAccount._id, session);
  const fromProfit = Math.min(usd - fromCredit, profit.cents);
  const fromClaim = usd - fromCredit - fromProfit;

  const day = today();
  const [doc] = await PaymentReturn.create([{
    day, orderId: order._id, partnerId: order.user, category: 'invoice', usd, fromProfit, reopened: fromClaim, description, number: await nextDocNumber('RET', day, session),
    createdBy: req?.user?._id, idempotencyKey: input.idempotencyKey,
  }], { session });
  const entry = await postEntry({
    eventType: 'PAYMENT_RETURN', eventKey: `PAYMENT_RETURN:${doc._id}`, date: day,
    description: `إرجاع ${usd / 100}$ من دفعات الطلب ${order.orderId} للمحفظة: ${description}`,
    source: { model: 'AccountingPaymentReturn', id: doc._id },
    lines: [
      ...(fromCredit + fromClaim > 0 ? [{ accountId: (await resolveAccount('customer_receivable'))._id, debit: fromCredit + fromClaim, partnerId: order.user, orderId: order._id, arKey: key, label: 'يُرجع من المدفوع على الفاتورة' }] : []),
      ...(fromProfit > 0 ? [{ accountId: profitAccount._id, debit: fromProfit, partnerId: order.user, orderId: order._id, label: OVERPAID_LABEL, ...(profit.office && { office: profit.office }) }] : []),
      { accountId: (await resolveAccount('wallet_usd'))._id, credit: usd, currency: 'USD', amountCurrency: -usd, partnerId: order.user, label: 'أُضيف لمحفظة العميل' },
    ],
  }, { session, user: req?.user });
  const statement = await moveWallet({ userId: order.user, currency: 'USD', amount: usd / 100, description: `إرجاع مبلغ من دفعة الطلبية ${order.orderId}: ${description}`,
    note: doc.number, createdBy: req?.user?._id, source: { model: 'AccountingPaymentReturn', id: doc._id } }, session);
  await UserStatement.updateOne({ _id: statement._id }, { $set: { actionType: 'refund' } }, { session });
  doc.entryId = entry._id;
  doc.userStatementId = statement._id;
  await doc.save({ session });
  await logAudit({ req, action: 'order.paymentReturn', model: 'AccountingPaymentReturn', docId: doc._id, after: { usd, description } }, session);
  return doc;
}

// The returns of an order, with what can still go back (for the order page)
async function listPaymentReturns(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلب غير موجود');
  const results = await PaymentReturn.find({ orderId }).sort({ createdAt: -1 }).populate('createdBy', 'firstName lastName').lean();
  const room = await returnableOnInvoice(orderId);
  // What a return takes without the invoice being owed again: the credit on it and the overpayment kept
  const key = purchaseKey(orderId);
  const open = (await openBalances([key])).get(key) || 0;
  const profit = await overpaidProfitOf(new mongoose.Types.ObjectId(String(orderId)), (await resolveAccount('revenue_other'))._id);
  const extraUsd = Math.min(room.left, Math.max(-open, 0) + profit.cents) / 100;
  return { results, returnableUsd: room.left / 100, extraUsd, pointsUsd: room.points / 100 };
}

module.exports = { createPaymentReturn, listPaymentReturns, returnableOnInvoice, returnedOnInvoice };
