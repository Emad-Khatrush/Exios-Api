const crypto = require('crypto');
const mongoose = require('mongoose');
const { Account, JournalEntry } = require('../../models');
const { BankStatementLine, SupplierPayment, SupplierBill, YuanPurchase, Vendor } = require('../../models/documents');
const { getBalance } = require('../carrying');
const { getConfig } = require('../config');
const { logAudit } = require('../audit');
const { fail } = require('./common');
const id = value => String(value?._id || value || '');
const distance = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Explicit correction of a statement expense duplicated by an order batch payment.
// Preview is read-only; amount/date are candidates, never automatic approval.
async function preview(accountId, { session } = {}) {
  require('./batchPaymentTrial').assertTrial();
  if (!mongoose.isValidObjectId(accountId)) throw fail('اختر حساب البنك');
  const account = await Account.findById(accountId).session(session || null).lean();
  if (!account?.isCash || account.currency !== 'USD') throw fail('التسوية التجريبية تدعم حسابات الدفع بالدولار');
  const { count } = await getConfig();
  const lines = await BankStatementLine.find({ accountId, lineStatus: 'created_entry', amount: { $lt: 0 }, paymentId: { $ne: null },
    ...(count && { day: { $gt: count.day } }) }).session(session || null).lean();
  const batches = await SupplierPayment.find({ fromAccountId: accountId, status: 'posted', batchTrial: true }).session(session || null).lean();
  const candidates = [];
  for (const line of lines) {
    if (line.tripCostSettlementId || line.billCreatedFromStatement !== true || line.historicalSettlementPaymentId || (line.groupPaymentIds || []).length) continue;
    const oldPayment = await SupplierPayment.findById(line.paymentId).session(session || null).lean();
    const oldBill = line.billId && await SupplierBill.findById(line.billId).session(session || null).lean();
    if (!oldPayment || oldPayment.status !== 'posted' || oldPayment.batchTrial || oldPayment.currency !== 'USD'
      || id(oldPayment.fromAccountId) !== id(accountId) || id(oldPayment.entryId) !== id(line.entryId)
      || oldPayment.allocations.length !== 1 || id(oldPayment.allocations[0].billId) !== id(oldBill)
      || Math.round(oldPayment.amount * 100) !== -line.amount || oldPayment.allocations[0].amountUsd !== -line.amount
      || !oldBill || oldBill.status !== 'posted' || oldBill.isCreditNote || oldBill.currency !== 'USD' || oldBill.totalUsd !== -line.amount
      || oldBill.lines.length !== 1 || oldBill.lines[0].target !== 'expense'
      || !String(oldBill.idempotencyKey || '').startsWith(`BANK_LINE_BILL:${line._id}`)) continue;
    const otherLines = await BankStatementLine.exists({ _id: { $ne: line._id }, billId: oldBill._id, lineStatus: { $in: ['matched', 'created_entry'] } }).session(session || null);
    const otherPayments = await SupplierPayment.exists({ _id: { $ne: oldPayment._id }, status: 'posted', 'allocations.billId': oldBill._id }).session(session || null);
    if (otherLines || otherPayments) continue;
    for (const batch of batches.filter(p => Math.round(p.amount * 100) === -line.amount && distance(p.day, line.day) <= 7)) {
      const entry = await JournalEntry.findById(batch.entryId).session(session || null).lean();
      const oldEntry = await JournalEntry.findById(oldPayment.entryId).session(session || null).lean();
      if (!entry || entry.status !== 'posted' || entry.reversalOf || !oldEntry || oldEntry.status !== 'posted') continue;
      const bankAmount = entry.lines.filter(l => id(l.accountId) === id(accountId)).reduce((sum, l) => sum + l.debit - l.credit, 0);
      if (bankAmount !== line.amount || (entry.bankMatchedAccounts || []).some(a => id(a) === id(accountId))) continue;
      if (await BankStatementLine.exists({ accountId, lineStatus: { $in: ['matched', 'created_entry'] },
        $or: [{ entryId: entry._id }, { matchedEntryIds: entry._id }, { paymentId: batch._id }] }).session(session || null)) continue;
      const bills = await SupplierBill.find({ _id: { $in: batch.allocations.map(a => a.billId) } }).session(session || null).lean();
      if (!bills.length || bills.length !== batch.allocations.length || bills.some(b => b.status !== 'posted' || b.isCreditNote || b.lines.some(l => l.target !== 'order'))) continue;
      const purchases = await YuanPurchase.find({ fundedFromPaymentId: batch._id, status: 'posted' }).session(session || null).lean();
      const vendors = await Vendor.find({ _id: { $in: [oldPayment.vendorId, batch.vendorId] } }).select('name').session(session || null).lean();
      const name = vendorId => vendors.find(v => id(v) === id(vendorId))?.name || '';
      candidates.push({ key: `${line._id}:${batch._id}`, lineId: line._id, paymentId: batch._id,
        fingerprint: hash([line, oldPayment, oldBill, oldEntry, batch, entry, bills, purchases]), amount: -line.amount,
        statementDay: line.day, description: line.description, oldPayment: oldPayment.number, oldEntry: oldEntry.number,
        oldBill: oldBill.number, oldVendor: name(oldPayment.vendorId), paymentNumber: batch.number, paymentDay: batch.day,
        vendor: name(batch.vendorId), vendorDiffers: id(oldPayment.vendorId) !== id(batch.vendorId),
        retainedBills: bills.map(b => ({ id: b._id, number: b.number, usd: b.totalUsd })),
        retainedPurchases: purchases.map(p => ({ number: p.number, usd: p.usd, cny: p.cnyReceived || p.cnyExpected, arrived: p.arrived })),
      });
    }
  }
  candidates.sort((a, b) => distance(a.statementDay, a.paymentDay) - distance(b.statementDay, b.paymentDay));
  return { account: { id: account._id, name: account.name }, balance: (await getBalance(accountId, { session })).usd, candidates };
}

async function apply(input, { session, req }) {
  const reason = String(input.reason || '').trim();
  if (input.confirmSameOperation !== true || reason.length < 10) throw fail('أكد أنها نفس الحوالة واكتب سبب التصحيح');
  const items = input.items || [];
  if (!Array.isArray(items) || !items.length || items.length > 50
    || items.some(i => !i || !mongoose.isValidObjectId(i.lineId) || !mongoose.isValidObjectId(i.paymentId) || typeof i.fingerprint !== 'string')
    || new Set(items.map(i => id(i.lineId))).size !== items.length
    || new Set(items.map(i => id(i.paymentId))).size !== items.length) throw fail('اختر سطوراً ودفعات مختلفة؛ لا تستخدم نفس الدفعة مرتين');
  await require('../periodLock').lockPeriod(session);
  const before = await preview(input.accountId, { session });
  const chosen = items.map(item => before.candidates.find(c => id(c.lineId) === id(item.lineId) && id(c.paymentId) === id(item.paymentId) && c.fingerprint === item.fingerprint));
  if (chosen.some(c => !c)) throw fail('تغيرت القيود أو تمت تسويتها؛ حدّث المعاينة قبل التأكيد');
  const bank = require('./bank');
  for (const candidate of chosen) {
    await bank.cancelLineEntry(candidate.lineId, { session, req, reason: `تسوية تكرار مع ${candidate.paymentNumber}: ${reason}` });
    const payment = await SupplierPayment.findById(candidate.paymentId).session(session).lean();
    await bank.manualMatch(candidate.lineId, [payment.entryId], { session, req });
    await BankStatementLine.updateOne({ _id: candidate.lineId, lineStatus: 'matched' }, { $set: { paymentId: payment._id } }, { session });
  }
  await logAudit({ req, action: 'bank.settleDuplicates', model: 'AccountingAccount', docId: input.accountId,
    after: { reason, items: chosen, balanceBefore: before.balance, balanceAfter: (await getBalance(input.accountId, { session })).usd } }, session);
  return { settled: chosen.length, balance: (await getBalance(input.accountId, { session })).usd };
}
module.exports = { preview, apply };
