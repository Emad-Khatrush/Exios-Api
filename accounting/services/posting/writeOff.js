// Writing off a customer's claim on a delivered package or a purchase invoice (spec 19.7, owner's
// decision 67). Only what is still owed is written off; the paid part becomes revenue and the
// whole cost is recognised (syncOrder does both), so the order shows its real loss. A payment
// made later takes the write-off back by the same amount and raises the revenue with it.
const mongoose = require('mongoose');
const { ClaimWriteOff } = require('../../models/documents');
const Order = require('../../../models/order');
const { postEntry } = require('../ledger');
const { isDay } = require('../dates');
const { logAudit } = require('../audit');
const { fail, nextDocNumber, findExisting, resolveAccount } = require('./common');
const { parseKey } = require('../claims/keys');
const { lockClaimAllocation } = require('../claims/locks');

// The open debts of the order that stand for this very claim: the purchase invoice's, or the
// shipping of this package (a debt naming another package is left alone)
async function closeReminderDebts(orderId, key, arKey, doc, session) {
  const Balance = require('../../../models/balance');
  const debts = await Balance.find({ order: orderId, balanceType: 'debt', status: { $in: ['open', 'overdue'] },
    debtType: key.kind === 'purchase' ? 'invoice' : 'receivedGoods', 'source.kind': { $nin: ['cash', 'partner'] } }).session(session);
  const closed = [];
  for (const debt of debts) {
    if (key.kind === 'shipment') {
      const keys = (debt.deliveryClaimKeys || []).map(String);
      const named = debt.deliveryPackageId || keys.length;
      if (named && String(debt.deliveryPackageId) !== String(key.packageId) && !keys.includes(arKey)) continue;
    }
    closed.push({ balanceId: debt._id, status: debt.status });
    debt.status = 'closed';
    debt.notes = `${debt.notes || ''} — أُقفل بشطب ${doc.number}: ${doc.reason}`.trim();
    await debt.save({ session });
  }
  return closed;
}

// Cancelling the write-off: its debts are owed again, as they were (unless changed since)
async function reopenDebts(writeOff, session) {
  const Balance = require('../../../models/balance');
  for (const { balanceId, status } of writeOff.closedDebts || []) {
    await Balance.updateOne({ _id: balanceId, status: 'closed' }, { $set: { status: status || 'open' } }, { session });
  }
}

async function createWriteOff(input, { session, req }) {
  const existing = await findExisting(ClaimWriteOff, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  if (!String(input.reason || '').trim()) throw fail('سبب الشطب مطلوب');
  const key = parseKey(input.arKey);
  if (!['purchase', 'shipment'].includes(key.kind)) throw fail('اختر مطالبة طرد أو فاتورة شراء (الدين العام يُشطب من شاشة الديون)');
  const order = await Order.findById(key.orderId).select('orderId user isCanceled paymentList._id paymentList.status').session(session).lean();
  if (!order || order.isCanceled) throw fail('الطلب غير موجود أو ملغى');
  if (key.kind === 'shipment') {
    const pkg = (order.paymentList || []).find((p) => String(p._id) === String(key.packageId));
    // An undelivered package is not written off: it is cancelled or removed instead (E19)
    if (!pkg?.status?.received) throw fail('الطرد لم يُسلَّم؛ الشطب للطرود المسلَّمة فقط. ألغِ الطرد أو أزله من الطلب بدل شطبه.');
  }

  const { operations } = { operations: require('./operations') };
  await lockClaimAllocation(input.arKey, session);
  const open = (await operations.openBalances([input.arKey], session)).get(input.arKey) || 0;
  if (open <= 0) throw fail('لا شيء مستحق على هذه المطالبة');
  const amount = input.amountUsd ? Math.round(Number(input.amountUsd)) : open;
  if (!(amount > 0) || amount > open) throw fail(`المبلغ يجب أن يكون بين 0.01 و${open / 100}$`);

  const receivable = await resolveAccount('customer_receivable');
  const deferred = await resolveAccount(key.kind === 'shipment' ? 'deferred_shipping_revenue' : 'deferred_purchase_revenue');
  const partnerId = order.user;
  const [doc] = await ClaimWriteOff.create([{
    day: input.day, arKey: input.arKey, orderId: order._id, partnerId, amountUsd: amount, reason: String(input.reason).trim(),
    note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('WO', input.day, session),
  }], { session });
  const dims = { arKey: input.arKey, orderId: order._id, ...(key.packageId && mongoose.isValidObjectId(key.packageId) && { packageId: new mongoose.Types.ObjectId(String(key.packageId)) }) };
  const entry = await postEntry({
    eventType: 'CLAIM_WRITEOFF', eventKey: `CLAIM_WRITEOFF:${doc._id}`, date: input.day,
    description: `شطب ${doc.number} - طلب ${order.orderId}: ${doc.reason}`, source: { model: 'AccountingClaimWriteOff', id: doc._id },
    lines: [
      { accountId: deferred._id, debit: amount, label: 'الجزء غير المسدد', ...dims },
      { accountId: receivable._id, credit: amount, partnerId, label: 'شطب المطالبة', ...dims },
    ],
  }, { session, user: req?.user, onLocked: 'reject' });
  doc.entryId = entry._id;
  // Nothing is owed on the claim any more: the debts on the order that only reminded of it are
  // closed with it (a debt from a cash box or a partner is real money lent, and stays)
  if (amount === open) doc.closedDebts = await closeReminderDebts(order._id, key, input.arKey, doc, session);
  await doc.save({ session });
  // The paid part becomes revenue and the whole cost is recognised
  await require('../claims/sync').syncOrder(order._id, { session, user: req?.user, date: input.day });
  await logAudit({ req, action: 'claim.writeOff', model: 'AccountingClaimWriteOff', docId: doc._id, after: doc }, session);
  return doc;
}

module.exports = { createWriteOff, reopenDebts };
