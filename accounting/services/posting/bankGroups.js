const mongoose = require('mongoose');
const crypto = require('crypto');
const { BankStatementLine } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const { fail } = require('./common');
const { logAudit } = require('../audit');
const ids = value => {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => !mongoose.isValidObjectId(v))
    || new Set(value.map(String)).size !== value.length) throw fail('اختر من 1 إلى 100 سطر أو قيد مختلف');
  return value.map(String);
};
async function preview(input, { session } = {}) {
  const lineIds = ids(input.lineIds), entryIds = ids(input.entryIds);
  const lines = await BankStatementLine.find({ _id: { $in: lineIds } }).sort({ _id: 1 }).session(session || null).lean();
  if (lines.length !== lineIds.length || lines.some(l => l.lineStatus !== 'unmatched' || l.duplicateReviewPending || l.purchaseReviewPending))
    throw fail('بعض السطور غير متاحة أو تحتاج مراجعة التكرار أو المشتريات أولًا');
  const accountId = lines[0].accountId;
  if (lines.some(l => String(l.accountId) !== String(accountId))) throw fail('اختر سطورًا من نفس الحساب');
  if (lines.some(l => l.sourceProvider === 'alipay' || l.movementKind === 'purchase_refund' || l.pendingRefund || l.unidentified))
    throw fail('استردادات المشتريات وعمليات Alipay الموثقة تُربط من مسارها الأصلي؛ اختر حركات بنكية عادية لهذه المجموعة');
  if (lines.some(l => Math.sign(l.amount) !== Math.sign(lines[0].amount))) throw fail('لا تجمع الوارد والصادر لإخفاء فرق؛ اختر نفس اتجاه الحركة');
  const bank = require('./bank');
  const movements = await bank.unmatchedMovements(accountId, { session });
  const chosen = movements.filter(e => entryIds.includes(String(e._id))).sort((a, b) => String(a._id).localeCompare(String(b._id)));
  if (chosen.length !== entryIds.length || chosen.some(e => Math.sign(e.amount) !== Math.sign(lines[0].amount)))
    throw fail('بعض القيود مستخدمة أو ملغاة أو اتجاهها مختلف');
  const statementTotal = lines.reduce((s, l) => s + l.amount, 0), ledgerTotal = chosen.reduce((s, e) => s + e.amount, 0);
  const account = await require('../../models').Account.findById(accountId).session(session || null).lean();
  const config = await require('../config').getConfig();
  const transfer = require('./bankTransferHints');
  for (const line of lines) {
    const hint = transfer.describe(line, account, [...config.accountsById.values()]);
    if (hint?.semanticTransfer && !transfer.matchesMovement({ ...line, amount: statementTotal }, hint,
      { ledgerLines: chosen.flatMap(e => e.ledgerLines || []) })) throw fail('الحساب المقابل للتحويل لا يتفق مع القيود المحددة');
    if (chosen.some(e => e.bankSourceReference && String(e.bankSourceAccountId) === String(accountId)
      && !lines.some(l => require('./bankEvidence').ref(l.reference) === require('./bankEvidence').ref(e.bankSourceReference))))
      throw fail('مرجع مسجل في القيد غير موجود ضمن السطور المختارة');
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([lines, chosen])).digest('hex');
  return { accountId, currency: account.currency || 'USD', statementTotal, ledgerTotal, difference: statementTotal - ledgerTotal,
    lines: lines.map(l => ({ _id: l._id, day: l.day, description: l.description, amount: l.amount, reference: l.reference })),
    entries: chosen.map(e => ({ _id: e._id, number: e.number, day: e.day, description: e.description, amount: e.amount })), fingerprint };
}
async function match(input, { session, req }) {
  await require('../periodLock').lockPeriod(session);
  if (input.confirmReviewed !== true || String(input.reason || '').trim().length < 10) throw fail('راجع المجموعة وأدخل بيان الربط قبل الاعتماد');
  const current = await preview(input, { session });
  if (current.fingerprint !== input.fingerprint) throw fail('تغيرت السطور أو القيود؛ حدّث المعاينة');
  if (current.difference !== 0) throw fail('مجموع الكشف والقيود غير متساوٍ؛ فسّر الفرق وسجله قبل المطابقة');
  await require('./bank').reserveMatchedEntries(current.accountId, current.entries.map(e => e._id), session);
  const groupId = new mongoose.Types.ObjectId();
  await BankStatementLine.updateMany({ _id: { $in: current.lines.map(l => l._id) }, lineStatus: 'unmatched' },
    { $set: { lineStatus: 'matched', matchGroupId: groupId, matchedEntryIds: current.entries.map(e => e._id), coveredNote: input.reason.trim() } }, { session });
  await logAudit({ req, action: 'bank.groupMatched', model: 'AccountingBankStatementLine', docId: current.lines[0]._id,
    after: { groupId, ...current, reason: input.reason.trim() } }, session);
  return { groupId, lineCount: current.lines.length, entryCount: current.entries.length };
}
async function unmatch(lineId, { session, req, reason = 'فك مطابقة المجموعة' }) {
  await require('../periodLock').lockPeriod(session);
  const original = await BankStatementLine.findById(lineId).session(session).lean();
  if (!original?.matchGroupId || original.lineStatus !== 'matched') throw fail('المجموعة لم تعد مطابقة');
  const lines = await BankStatementLine.find({ accountId: original.accountId, matchGroupId: original.matchGroupId, lineStatus: 'matched' }).session(session);
  const allIds = [...new Set(lines.flatMap(l => l.matchedEntryIds.map(String)))];
  await JournalEntry.updateMany({ _id: { $in: allIds } }, { $pull: { bankMatchedAccounts: original.accountId } }, { session });
  for (const line of lines) {
    line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...line.matchedEntryIds.map(String)])];
    line.lineStatus = 'unmatched'; line.matchedEntryIds = []; line.matchGroupId = undefined; line.coveredNote = undefined;
    await line.save({ session });
  }
  await logAudit({ req, action: 'bank.groupUnmatched', model: 'AccountingBankStatementLine', docId: original._id,
    after: { groupId: original.matchGroupId, lineIds: lines.map(l => l._id), reason } }, session);
  return BankStatementLine.findById(lineId).session(session);
}
module.exports = { preview, match, unmatch };
