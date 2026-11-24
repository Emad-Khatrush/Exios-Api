// Giving back part of what a customer paid on an order to their wallet, with a description (owner
// 2026-11-25). The purchase invoice lowered after it was paid (200$ paid, now 180$), or a package
// re-priced lower after its shipping was paid: the extra goes back without cancelling the payment.
// Before this the only way was to cancel the whole payment and pay again, which left two strange
// lines in the customer's statement.
//
// In the currency the customer paid in, never more than they paid in it (owner 2026-11-25): dollars
// paid come back as dollars, dinars paid as dinars, at the rate those dinars were counted at (their
// average when paid at several rates), so they are worth what they paid. The books carry the dollar
// value. Old invoice payments known to the books only (no order payment) count as dollars.
// One entry, Cr the wallet, and the debit from where the extra money sits, in this order:
// 1. the credit left on the order's claims of that part (the invoice, or the packages' shipping)
// 2. the dollar overpayment of that part kept as other revenue at payment time (rule 119: paid more
//    than was owed). A dinar margin (fx_gain_loss) is the exchange profit charged on purpose: never
//    given back.
// 3. the invoice only: the rest from its claim, owed again by that much (the order page says so).
//    Shipping is paid at delivery: only its extra goes back, never more.
// Nothing billed changes (not a REFUND, which lowers what is billed). The wallet line is made
// here, linked to the document, so it is not posted twice. Cancelled with the generic document
// cancel (rule AccountingPaymentReturn in services/cancel.js), which reverses the entry.
//
// Never more than the money paid on that part, less what was given back before. Points paid on
// it are not counted: they come back as points, cancelled on the order page.
const mongoose = require('mongoose');
const { PaymentReturn, CustomerRefund } = require('../../models/documents');
const Order = require('../../../models/order');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const { postEntry } = require('../ledger');
const { today } = require('../dates');
const { logAudit } = require('../audit');
const { fail, nextDocNumber, findExisting, resolveAccount, toCurrencyMinor, moneyLine } = require('./common');
const { moveWallet } = require('./people');
const { openBalances, resolveClaimKeys, OVERPAID_LABEL } = require('./operations');
const { walletRole } = require('../roles');
const { JournalEntry } = require('../../models');

const CATEGORIES = ['invoice', 'receivedGoods'];
const KIND = { invoice: 'PUR', receivedGoods: 'SHP' };
const NAMES = { invoice: 'فاتورة الشراء', receivedGoods: 'الشحن' };
const oidOf = (value) => new mongoose.Types.ObjectId(String(value));

// The money paid on one part of the order, in USD cents (dinars at the rate each was taken at).
// The invoice also counts old payments known to the books only (customerRefund.paidOnInvoice).
async function moneyPaid(orderId, category, session) {
  if (category === 'invoice') return require('./customerRefund').paidOnInvoice(orderId, session);
  const payments = await OrderPaymentHistory.find({ order: orderId, category }).select('receivedAmount currency rate').session(session || null).lean();
  return Math.round(payments.reduce((sum, p) => {
    const amount = Number(p.receivedAmount || 0);
    if (p.currency === 'USD') return sum + amount;
    return Number(p.rate) > 0 ? sum + amount / Number(p.rate) : sum;
  }, 0) * 100);
}

// The returns of one part (posted), in USD cents, and what of them came from the overpayment kept
async function returnedOn(orderId, category, session) {
  const rows = await PaymentReturn.find({ orderId, status: 'posted', category }).select('usd fromProfit').session(session || null).lean();
  return { usd: rows.reduce((sum, r) => sum + (r.usd || 0), 0), fromProfit: rows.reduce((sum, r) => sum + (r.fromProfit || 0), 0) };
}
// Kept for the supplier refunds' limit (customerRefund.js): what went back from the invoice
const returnedOnInvoice = async (orderId, session) => (await returnedOn(orderId, 'invoice', session)).usd;

// The dollar overpayment of one part of an order kept as other revenue (cents), net of what returns
// took back, and its office. A payment entry's part is the claims it paid (PUR or SHP).
async function overpaidProfitOf(orderId, category, accountId, session) {
  const entries = await JournalEntry.find({ status: { $in: ['posted', 'reversed'] }, eventKey: { $not: /PAYMENT_RETURN/ }, 'lines.label': OVERPAID_LABEL, 'lines.orderId': orderId })
    .select('lines').session(session || null).lean();
  let net = 0;
  let office;
  for (const entry of entries) {
    const part = (entry.lines.find((l) => l.arKey && /^(PUR|SHP):/.test(l.arKey))?.arKey || '').slice(0, 3);
    if (part !== KIND[category]) continue;
    for (const line of entry.lines) {
      if (line.label !== OVERPAID_LABEL || String(line.accountId) !== String(accountId) || String(line.orderId) !== String(orderId)) continue;
      net += (line.credit || 0) - (line.debit || 0);
      office = line.office || office;
    }
  }
  const taken = (await returnedOn(orderId, category, session)).fromProfit;
  return { cents: Math.max(net - taken, 0), office };
}

// What can still go back in each currency, for one part of the order. Dinars paid without a rate
// cannot be valued and are left out. Supplier refunds (to the dollar wallet) come off the dollars.
async function byCurrency(orderId, category, refunds, session) {
  const payments = await OrderPaymentHistory.find({ order: orderId, category }).select('receivedAmount currency rate').session(session || null).lean();
  let usdPaid = 0; let lydPaid = 0; let lydPaidUsd = 0;
  // The dollars the dinars counted for, unrounded: the rate is worked from them (2026-11-25: from the
  // rounded cents, 105 LYD at 10.32 came back at 10.3245)
  let lydExactUsd = 0;
  for (const p of payments) {
    const amount = Number(p.receivedAmount || 0);
    if (p.currency === 'USD') usdPaid += Math.round(amount * 100);
    else if (p.currency === 'LYD' && Number(p.rate) > 0) { lydPaid += amount; lydPaidUsd += Math.round((amount / Number(p.rate)) * 100); lydExactUsd += amount / Number(p.rate); }
  }
  // Old invoice payments the books know of but the order does not: dollars
  if (category === 'invoice') usdPaid += Math.max((await moneyPaid(orderId, category, session)) - usdPaid - lydPaidUsd, 0);
  const rows = await PaymentReturn.find({ orderId, status: 'posted', category }).select('currency amount usd').session(session || null).lean();
  const usdBack = rows.filter((r) => (r.currency || 'USD') === 'USD').reduce((sum, r) => sum + (r.usd || 0), 0);
  const lydBack = rows.filter((r) => r.currency === 'LYD').reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const rate = lydPaid > 0 && lydExactUsd > 0 ? Math.round((lydPaid / lydExactUsd) * 10000) / 10000 : 0;
  return {
    USD: { paid: usdPaid, available: Math.max(usdPaid - usdBack - refunds, 0) },
    LYD: { paid: Math.round(lydPaid * 1000) / 1000, available: Math.max(Math.round((lydPaid - lydBack) * 1000) / 1000, 0), rate },
  };
}

// Where the money of a return can come from, for one part of the order (all in USD cents):
// credits: the claims paid beyond what they bill; profit: the overpayment kept; left: the money
// paid, less supplier refunds (invoice) and earlier returns; max: what may go back now
async function roomOf(orderId, category, session) {
  const keys = await resolveClaimKeys({ orderId, category }, session);
  const open = await openBalances(keys, session);
  const credits = keys.map((key) => ({ key, cents: Math.max(-(open.get(key) || 0), 0) })).filter((c) => c.cents > 0);
  const creditCents = credits.reduce((sum, c) => sum + c.cents, 0);
  const profitAccount = await resolveAccount('revenue_other');
  const profit = await overpaidProfitOf(oidOf(orderId), category, profitAccount._id, session);
  const paid = await moneyPaid(orderId, category, session);
  const refunds = category === 'invoice'
    ? (await CustomerRefund.find({ orderId, status: 'posted' }).select('walletUsd legacyWalletUsd').session(session || null).lean())
      .reduce((sum, r) => sum + (r.walletUsd || 0) + (r.legacyWalletUsd || 0), 0)
    : 0;
  const returned = (await returnedOn(orderId, category, session)).usd;
  const left = Math.max(paid - refunds - returned, 0);
  const extra = Math.min(left, creditCents + profit.cents);
  const max = category === 'invoice' ? left : extra;
  const points = category === 'invoice' ? (await require('../loyalty').redeemedByPart(orderId)).invoice || 0 : 0;
  const currencies = await byCurrency(orderId, category, refunds, session);
  return { keys, credits, profit, profitAccount, paid, refunds, returned, left, extra, max, points, currencies };
}

async function createPaymentReturn(input, { session, req }) {
  const existing = await findExisting(PaymentReturn, input.idempotencyKey, session);
  if (existing) return existing;
  if (!mongoose.isValidObjectId(input.orderId)) throw fail('الطلب غير موجود');
  const category = CATEGORIES.includes(input.category) ? input.category : 'invoice';
  const order = await Order.findById(input.orderId).select('orderId user isPayment isCanceled').session(session).lean();
  if (!order || !order.user) throw fail('الطلب غير موجود');
  if (category === 'invoice' && !order.isPayment) throw fail('هذا الطلب ليس له فاتورة شراء');
  if (order.isCanceled) throw fail('الطلب ملغى وأُرجع للعميل كامل المدفوع');
  const currency = input.currency === 'LYD' ? 'LYD' : 'USD';
  const amount = Math.round(Number(input.amount) * 1000) / 1000;
  if (!Number.isFinite(amount) || amount <= 0) throw fail('اكتب المبلغ المراد إرجاعه');
  const day = today();
  const description = String(input.description || '').trim();
  if (!description) throw fail('اكتب بيان الإرجاع (سببه)');
  if (description.length > 300) throw fail('البيان 300 حرف على الأكثر');
  // One at a time per order (as supplier refunds): two returns at once cannot pass the limit together
  const locked = await Order.updateOne({ _id: order._id }, { $inc: { customerRefundVersion: 1 } }, { session });
  if (locked.modifiedCount !== 1) throw fail('الطلب غير متاح للإرجاع الآن');
  const room = await roomOf(order._id, category, session);
  // Back in the currency paid, never more than was paid in it
  const own = room.currencies[currency];
  const name = currency === 'USD' ? 'بالدولار' : 'بالدينار';
  if (!(own.paid > 0)) {
    throw fail(`العميل لم يدفع ${name} على ${NAMES[category]}؛ يُرجع المبلغ بالعملة التي دفع بها`);
  }
  if (currency === 'USD' ? Math.round(amount * 100) > own.available : amount > own.available + 1e-9) {
    const left = currency === 'USD' ? `${own.available / 100}$` : `${own.available} د.ل`;
    const points = room.points > 0 ? `. ودفع ${room.points / 100}$ بالنقاط: النقاط لا تُرجع فلوساً، ألغِها من نقاط الطلبية فترجع لرصيد نقاطه` : '';
    throw fail(`أقصى ما يُرجع ${name} من ${NAMES[category]} ${left}، وهو ما دفعه ${name} ولم يُرجع له${points}`);
  }
  // Dinars at the rate they were paid at: worth what the customer paid
  const rate = currency === 'LYD' ? own.rate : 0;
  const usd = currency === 'USD' ? Math.round(amount * 100) : Math.round((amount / rate) * 100);
  if (!(usd > 0)) throw fail('المبلغ صغير جداً بعد التحويل');
  if (usd > room.max) {
    const before = room.refunds + room.returned ? `، وأُرجع له قبل ${(room.refunds + room.returned) / 100}$` : '';
    const points = room.points > 0 ? `. ودفع ${room.points / 100}$ بالنقاط: النقاط لا تُرجع فلوساً، ألغِها من نقاط الطلبية فترجع لرصيد نقاطه` : '';
    const why = category === 'receivedGoods' ? ` (الشحن يُرجع منه الزائد فقط: ${room.extra / 100}$)` : ` (دفع ${room.paid / 100}$ فلوساً${before})`;
    throw fail(`أقصى ما يُرجع لمحفظة العميل من ${NAMES[category]} ${room.max / 100}$${why}${points}`);
  }

  // Where the money comes from (see the top of the file)
  const receivable = await resolveAccount('customer_receivable');
  const lines = [];
  let rest = usd;
  for (const credit of room.credits) {
    if (rest <= 0) break;
    const take = Math.min(rest, credit.cents);
    lines.push({ accountId: receivable._id, debit: take, partnerId: order.user, orderId: order._id, arKey: credit.key, label: 'يُرجع من المدفوع على الطلب' });
    rest -= take;
  }
  const fromProfit = Math.min(rest, room.profit.cents);
  if (fromProfit > 0) {
    lines.push({ accountId: room.profitAccount._id, debit: fromProfit, partnerId: order.user, orderId: order._id, label: OVERPAID_LABEL, ...(room.profit.office && { office: room.profit.office }) });
    rest -= fromProfit;
  }
  const reopened = rest;
  if (reopened > 0 && !room.keys.length) throw fail('لا توجد مطالبة على هذه الفاتورة بعد؛ لا يُرجع أكثر من الزائد');
  if (reopened > 0) {
    // The invoice only (shipping never goes past its extra, checked above)
    const [key] = room.keys;
    lines.push({ accountId: receivable._id, debit: reopened, partnerId: order.user, orderId: order._id, arKey: key, label: 'يُرجع من المدفوع على الفاتورة' });
  }
  const wallet = await resolveAccount(walletRole(currency));
  const minor = currency === 'USD' ? usd : await toCurrencyMinor(amount, 'LYD');
  lines.push(moneyLine(wallet, 'credit', minor, usd, { partnerId: order.user, label: 'أُضيف لمحفظة العميل' }));

  const [doc] = await PaymentReturn.create([{
    day, orderId: order._id, partnerId: order.user, category, currency, amount, rate, usd, fromProfit, reopened, description,
    number: await nextDocNumber('RET', day, session), createdBy: req?.user?._id, idempotencyKey: input.idempotencyKey,
  }], { session });
  const shown = currency === 'USD' ? `${amount}$` : `${amount} د.ل`;
  const entry = await postEntry({
    eventType: 'PAYMENT_RETURN', eventKey: `PAYMENT_RETURN:${doc._id}`, date: day,
    description: `إرجاع ${shown} من مدفوع ${NAMES[category]} للطلب ${order.orderId} للمحفظة: ${description}`,
    source: { model: 'AccountingPaymentReturn', id: doc._id }, lines,
  }, { session, user: req?.user });
  const statement = await moveWallet({ userId: order.user, currency, amount, description: `إرجاع مبلغ من دفعة الطلبية ${order.orderId}: ${description}`,
    note: doc.number, createdBy: req?.user?._id, source: { model: 'AccountingPaymentReturn', id: doc._id } }, session);
  await UserStatement.updateOne({ _id: statement._id }, { $set: { actionType: 'refund', ...(currency === 'LYD' && { rate }) } }, { session });
  doc.entryId = entry._id;
  doc.userStatementId = statement._id;
  await doc.save({ session });
  await logAudit({ req, action: 'order.paymentReturn', model: 'AccountingPaymentReturn', docId: doc._id, after: { category, currency, amount, rate, usd, description } }, session);
  return doc;
}

// The returns of an order, with what can still go back from each part (for the order page)
async function listPaymentReturns(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلب غير موجود');
  const results = await PaymentReturn.find({ orderId }).sort({ createdAt: -1 }).populate('createdBy', 'firstName lastName').lean();
  const parts = {};
  for (const category of CATEGORIES) {
    const room = await roomOf(orderId, category);
    parts[category] = {
      maxUsd: room.max / 100, extraUsd: room.extra / 100, pointsUsd: room.points / 100,
      // In each currency: what was paid in it and what can still go back in it (dinars at `rate`)
      currencies: {
        USD: { paid: room.currencies.USD.paid / 100, available: room.currencies.USD.available / 100 },
        LYD: { paid: room.currencies.LYD.paid, available: room.currencies.LYD.available, rate: room.currencies.LYD.rate },
      },
    };
  }
  return {
    results, parts,
    // Kept for the order page before shipping returns (the invoice's figures)
    returnableUsd: parts.invoice.maxUsd, extraUsd: parts.invoice.extraUsd, pointsUsd: parts.invoice.pointsUsd,
  };
}

// A payment taken off the order (deleted, or its delivery invoice cancelled) gives all of it back to
// the wallet. When money was already given back from that currency (2026-11-25: a 105 LYD payment
// deleted after 105 LYD were given back paid the customer twice), the returns must be cancelled
// first: refused when what stays paid in the currency would be less than what was given back in it.
async function assertReturnsStayCovered({ orderId, category, currency, removing }, session) {
  const rows = await PaymentReturn.find({ orderId, status: 'posted', category: category || 'invoice', currency: currency === 'LYD' ? 'LYD' : { $in: ['USD', null] } })
    .select('number amount usd currency').session(session || null).lean();
  if (!rows.length) return;
  const own = (await byCurrency(orderId, category || 'invoice', 0, session))[currency === 'LYD' ? 'LYD' : 'USD'];
  const back = currency === 'LYD' ? rows.reduce((sum, r) => sum + Number(r.amount || 0), 0) : rows.reduce((sum, r) => sum + (r.usd || 0), 0) / 100;
  const paid = currency === 'LYD' ? own.paid : own.paid / 100;
  if (paid - Number(removing || 0) < back - 0.005) {
    const unit = currency === 'LYD' ? 'د.ل' : '$';
    throw fail(`أُرجع للعميل من دفعات هذه العملة ${Math.round(back * 100) / 100} ${unit} (${rows.map((r) => r.number).join('، ')}). ألغِ الإرجاع أولاً من صفحة الطلبية، ثم احذف الدفعة، حتى لا يأخذ المبلغ مرتين.`);
  }
}

// The order cancelled: every payment goes back to the wallet, so what was already given back from
// them is taken back from the wallet (each return cancelled) and the customer gets what they paid once
async function cancelOrderReturns(order, user, session) {
  const rows = await PaymentReturn.find({ orderId: order._id, status: 'posted' }).select('_id number currency amount usd').session(session).lean();
  const { cancelDocument } = require('../cancel');
  for (const row of rows) {
    await cancelDocument('AccountingPaymentReturn', row._id, { session, req: { user }, reason: `إلغاء الطلب ${order.orderId}`, confirmNegative: true, cascaded: true });
  }
  return rows.map((r) => ({ amount: -(r.currency === 'LYD' ? Number(r.amount) : r.usd / 100), currency: r.currency || 'USD', paymentType: 'returnTakenBack', number: r.number }));
}

module.exports = { createPaymentReturn, listPaymentReturns, returnedOnInvoice, assertReturnsStayCovered, cancelOrderReturns };
