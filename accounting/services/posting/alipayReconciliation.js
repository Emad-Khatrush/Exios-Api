const { JournalEntry } = require('../../models');
const { BankStatementLine } = require('../../models/documents');
const { fail } = require('./common');
const { addDays } = require('../dates');

const referenceOf = value => String(value || '').trim();
const walletReady = line => line.sourceProvider !== 'alipay' || ['balance', 'confirmed'].includes(line.walletImpact);
function assertWallet(line) {
  if (!walletReady(line)) throw fail('طريقة الاستلام غير مذكورة في كشف Alipay؛ أكد وصول المبلغ إلى رصيد Alipay من تفاصيل السطر قبل المطابقة أو الترحيل');
}
// Only a full, explicitly recorded transaction ID proves an automatic Alipay match. Amount/date
// remain review candidates, even when only one candidate happens to exist today.
function exactMatch(line, movement, accountId) {
  return walletReady(line) && movement.amount === line.amount && referenceOf(line.sourceTransactionId)
    && referenceOf(movement.bankSourceReference) === referenceOf(line.sourceTransactionId)
    && String(movement.bankSourceAccountId) === String(accountId);
}
async function beforeRecording(accountId, minor, day, reference, session) {
  const ref = referenceOf(reference);
  if (ref && (ref.length > 160 || /\s|[eE][+-]?\d+$/.test(ref))) throw fail('أدخل رقم عملية Alipay كاملًا كما يظهر في الكشف');
  const rows = await BankStatementLine.find({ accountId, amount: minor, day: { $gte: addDays(day, -7), $lte: addDays(day, 7) },
    lineStatus: { $in: ['created_entry', 'matched'] } }).session(session).lean();
  if (rows.some(row => !ref || !row.sourceTransactionId || row.sourceTransactionId === ref)) throw fail('توجد حركة بنفس المبلغ مسجلة من كشف هذا الحساب؛ راجع ربطها بالطلبية أو عملية شراء اليوان قبل تسجيل حركة ثانية');
  if (ref) {
    if (await JournalEntry.exists({ bankSourceAccountId: accountId, bankSourceReference: ref, status: 'posted' }).session(session)) {
      throw fail('رقم عملية Alipay مسجل مسبقًا؛ طابق الكشف مع القيد الموجود بدل تسجيله مرة ثانية');
    }
    const line = await BankStatementLine.findOne({ accountId, sourceProvider: 'alipay', sourceTransactionId: ref }).session(session).lean();
    if (line && ['created_entry', 'matched'].includes(line.lineStatus)) throw fail('رقم عملية Alipay مرتبط بحركة مرحّلة مسبقًا؛ لا تسجلها مرة ثانية');
    if (line && line.amount !== minor) throw fail('رقم عملية Alipay موجود في الكشف بمبلغ أو اتجاه مختلف');
    if (line) assertWallet(line);
  }
  return ref;
}
async function afterRecording(entryId, accountId, reference, { session, req }) {
  const ref = referenceOf(reference);
  if (!ref) return;
  await JournalEntry.updateOne({ _id: entryId }, { $set: { bankSourceAccountId: accountId, bankSourceReference: ref } }, { session });
  await require('./bank').autoMatch(accountId, { session, req });
}
async function releaseDocumentMatches(model, id, { session, fromBankLineId }) {
  const entries = await JournalEntry.find({ 'source.model': model, 'source.id': id, reversalOf: { $exists: false } }).select('_id').session(session).lean();
  const ids = entries.map(entry => entry._id);
  const lines = await BankStatementLine.find({ sourceProvider: 'alipay', lineStatus: { $in: ['matched', 'created_entry'] },
    $or: [{ entryId: { $in: ids } }, { matchedEntryIds: { $in: ids } }] }).session(session);
  for (const line of lines) {
    if (String(line._id) === String(fromBankLineId || '')) continue;
    const linked = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean);
    await JournalEntry.updateMany({ _id: { $in: linked } }, { $pull: { bankMatchedAccounts: line.accountId } }, { session });
    line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...linked.map(String)])];
    line.lineStatus = 'unmatched'; line.matchedEntryIds = []; line.entryId = undefined;
    line.paymentId = undefined; line.billId = undefined; line.orderId = undefined;
    line.postingAttempt = (line.postingAttempt || 0) + 1;
    await line.save({ session });
  }
}
module.exports = { referenceOf, walletReady, assertWallet, exactMatch, beforeRecording, afterRecording, releaseDocumentMatches };
