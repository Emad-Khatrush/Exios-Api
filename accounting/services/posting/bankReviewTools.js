const mongoose = require('mongoose');
const crypto = require('crypto');
const { BankStatementLine, SupplierBill, SupplierPayment } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const { fail } = require('./common');
const { addDays } = require('../dates');
const { logAudit } = require('../audit');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const native = (entry, accountId) => entry.lines.filter(l => String(l.accountId) === String(accountId))
  .reduce((sum, l) => sum + Number(l.amountCurrency ?? ((l.debit || 0) - (l.credit || 0))), 0);
async function lateExpense(billId) {
  if (!mongoose.isValidObjectId(billId)) throw fail('الفاتورة غير صالحة');
  const bill = await SupplierBill.findById(billId).lean();
  const payment = bill?.paymentId && await SupplierPayment.findOne({ _id: bill.paymentId, status: 'posted' }).lean();
  if (!payment?.fromAccountId) return { results: [] };
  const entries = await require('./bank').unmatchedMovements(payment.fromAccountId, { from: addDays(payment.day, -3), to: addDays(payment.day, 3) });
  const entry = entries.find(e => String(e._id) === String(payment.entryId));
  if (!entry) return { results: [] };
  const lines = await BankStatementLine.find({ accountId: payment.fromAccountId, lineStatus: 'unmatched', amount: entry.amount,
    duplicateReviewPending: { $ne: true }, purchaseReviewPending: { $ne: true }, movementKind: { $ne: 'purchase_refund' },
    day: { $gte: addDays(payment.day, -3), $lte: addDays(payment.day, 3) },
  }).sort({ day: 1 }).limit(30).lean();
  return { accountId: payment.fromAccountId, currency: payment.currency, entryId: payment.entryId,
    results: lines.filter(l => require('./alipayReconciliation').walletReady(l) && require('./bankEvidence').referenceCompatible(l, entry))
      .map(l => ({ _id: l._id, day: l.day, description: l.description, amount: l.amount,
        quality: require('./bankEvidence').quality(l, entry) })) };
}
async function integrity(accountId, { session } = {}) {
  if (!mongoose.isValidObjectId(accountId)) throw fail('اختر الحساب');
  const query = { accountId, lineStatus: { $in: ['matched', 'created_entry'] } };
  const lines = await BankStatementLine.find(query).sort({ day: -1, _id: 1 }).limit(2000).session(session || null).lean();
  const count = await BankStatementLine.countDocuments(query).session(session || null);
  const groupIds = [...new Set(lines.map(l => l.matchGroupId).filter(Boolean).map(String))];
  const siblings = groupIds.length ? await BankStatementLine.find({ accountId, matchGroupId: { $in: groupIds }, lineStatus: 'matched' }).session(session || null).lean() : [];
  const completeLines = [...new Map([...lines, ...siblings].map(l => [String(l._id), l])).values()];
  const ids = [...new Set(completeLines.flatMap(l => [l.entryId, ...(l.matchedEntryIds || [])].filter(Boolean).map(String)))];
  const entries = await JournalEntry.find({ _id: { $in: ids } }).session(session || null).lean();
  const byId = new Map(entries.map(e => [String(e._id), e]));
  const groups = new Map();
  for (const line of completeLines) {
    const key = String(line.matchGroupId || line._id); const group = groups.get(key) || []; group.push(line); groups.set(key, group);
  }
  const results = [];
  for (const rows of groups.values()) {
    const groupRows = rows;
    const links = [...new Set(groupRows.flatMap(l => [l.entryId, ...(l.matchedEntryIds || [])].filter(Boolean).map(String)))];
    const source = links.map(id => byId.get(id));
    const bad = !links.length || source.some(e => !e || e.status !== 'posted' || e.reversalOf);
    const statement = groupRows.reduce((s, l) => s + l.amount, 0);
    const ledger = source.filter(Boolean).reduce((s, e) => s + native(e, accountId), 0);
    const covered = groupRows.some(l => l.historicalCovered || l.partnerStatementIds?.length);
    if (!bad && (covered || statement === ledger)) continue;
    results.push({ lineId: rows[0]._id, groupId: rows[0].matchGroupId, day: rows[0].day, description: rows[0].description,
      issue: bad ? 'قيد مفقود أو ملغى' : 'مبلغ القيد لا يساوي الكشف', statement, ledger,
      canRelease: bad, fingerprint: hash([groupRows, source]) });
  }
  return { results, scanned: lines.length, hasMore: count > lines.length, total: count };
}
async function releaseInvalid(input, { session, req }) {
  await require('../periodLock').lockPeriod(session);
  if (String(input.reason || '').trim().length < 10) throw fail('اكتب سبب فك الربط');
  const check = await integrity(input.accountId, { session });
  const issue = check.results.find(i => String(i.lineId) === String(input.lineId) && i.fingerprint === input.fingerprint && i.canRelease);
  if (!issue) throw fail('تغيرت المطابقة أو تحتاج مراجعة المبلغ؛ حدّث الفحص');
  const line = await BankStatementLine.findById(issue.lineId).session(session).lean();
  if (line.matchGroupId) await require('./bankGroups').unmatch(line._id, { session, req, reason: input.reason.trim() });
  else {
    const ids = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean);
    await JournalEntry.updateMany({ _id: { $in: ids } }, { $pull: { bankMatchedAccounts: line.accountId } }, { session });
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { lineStatus: 'unmatched', matchedEntryIds: [],
      historyEntryIds: [...new Set([...(line.historyEntryIds || []), ...ids].map(String))] },
      $unset: { entryId: 1, paymentId: 1, receiptId: 1, customerRefundId: 1 } }, { session });
  }
  await logAudit({ req, action: 'bank.invalidMatchReleased', model: 'AccountingBankStatementLine', docId: line._id,
    after: { reason: input.reason.trim(), issue } }, session);
  return { released: true };
}
module.exports = { lateExpense, integrity, releaseInvalid };
