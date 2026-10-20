const mongoose = require('mongoose');
const crypto = require('crypto');
const { BankStatementLine } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const { fail } = require('./common');
const { logAudit } = require('../audit');
const id = value => String(value?._id || value);
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(String(host || '').toLowerCase());
function available(req) {
  const options = mongoose.connection.getClient()?.options;
  const localDatabase = mongoose.connection.readyState === 1 && !options?.srvHost
    && options?.hosts?.length > 0 && options.hosts.every(h => loopback(h.host));
  return !!localDatabase && process.env.EXIOS_QA !== '1' && process.env.NODE_ENV !== 'production'
    && !process.env.RENDER && !process.env.DYNO && !process.env.K_SERVICE
    && loopback(req?.hostname) && loopback(req?.socket?.remoteAddress);
}
function assertLocal(req) {
  if (!available(req)) throw fail('إعادة تجربة الكشف متاحة فقط من localhost على قاعدة MongoDB محلية، وليست QA أو قاعدة سحابية');
}
async function preview(input, { session, req } = {}) {
  assertLocal(req);
  if (!mongoose.isValidObjectId(input.accountId) || !Array.isArray(input.lineIds) || !input.lineIds.length || input.lineIds.length > 500
    || input.lineIds.some(v => !mongoose.isValidObjectId(v)) || new Set(input.lineIds.map(String)).size !== input.lineIds.length)
    throw fail('اختر من 1 إلى 500 سطر مختلف من الحساب');
  const chosen = await BankStatementLine.find({ _id: { $in: input.lineIds }, accountId: input.accountId }).session(session || null).lean();
  if (chosen.length !== input.lineIds.length) throw fail('بعض السطور تغيرت أو لا تنتمي للحساب المختار');
  const settlementIds = [...new Set(chosen.map(l => l.tripCostSettlementId).filter(Boolean).map(String))];
  const settlements = settlementIds.length ? await require('../../models/TripCostSettlement').find({ _id: { $in: settlementIds }, status: 'posted' }).session(session || null).lean() : [];
  const expandedIds = [...new Set([...input.lineIds.map(String), ...settlements.flatMap(s => s.sourceLineIds.map(String))])];
  const lines = await BankStatementLine.find({ accountId: input.accountId, $or: [{ _id: { $in: expandedIds } }, { duplicateResolvedToId: { $in: expandedIds } }] })
    .sort({ _id: 1 }).session(session || null).lean();
  if (lines.length > 1000) throw fail('المجموعة المرتبطة كبيرة؛ ألغِ التسويات الكبيرة أولًا ثم حدد دفعات أصغر');
  const groupIds = [...new Set(lines.map(l => l.matchGroupId).filter(Boolean).map(String))];
  const groupMembers = groupIds.length ? await BankStatementLine.find({ matchGroupId: { $in: groupIds }, accountId: input.accountId }).sort({ _id: 1 }).session(session || null).lean() : [];
  const entryIds = [...new Set([...lines, ...groupMembers].flatMap(l => [l.entryId, ...(l.matchedEntryIds || [])].filter(Boolean).map(String)))];
  const entries = await JournalEntry.find({ _id: { $in: entryIds } }).sort({ _id: 1 }).session(session || null).lean();
  const otherMatches = entryIds.length ? await BankStatementLine.find({ _id: { $nin: lines.map(l => l._id) }, lineStatus: 'matched', matchedEntryIds: { $in: entryIds } }).sort({ _id: 1 }).session(session || null).lean() : [];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([lines, settlements, groupMembers, entries, otherMatches])).digest('hex');
  return { accountId: input.accountId, requested: chosen.length, deletedCount: lines.length,
    canceledLines: lines.filter(l => l.lineStatus === 'created_entry').length,
    matchedLines: lines.filter(l => l.lineStatus === 'matched').length,
    settlementCount: settlements.length, additionalLines: lines.length - chosen.length,
    relatedMatches: otherMatches.length, fingerprint,
    rows: lines.map(l => ({ _id: l._id, day: l.day, description: l.description, amount: l.amount, status: l.lineStatus })),
    // Internal snapshot used by the transaction; never expose database connection options.
    settlementIds: settlements.map(s => s._id), otherMatchIds: otherMatches.map(l => l._id) };
}
async function reset(input, { session, req }) {
  assertLocal(req);
  if (input.confirm !== true || String(input.reason || '').trim().length < 10) throw fail('أكد حذف سطور التجربة واكتب السبب');
  await require('../periodLock').lockPeriod(session);
  const current = await preview(input, { session, req });
  if (current.fingerprint !== input.fingerprint) throw fail('تغيرت السطور أو القيود؛ حدّث المعاينة قبل الحذف');
  const reason = `إعادة تجربة محلية: ${input.reason.trim()}`;
  const bank = require('./bank');
  // Release matches first, including another account's statement for a shared transfer.
  // Independent pre-existing journals are retained, so a reimport can match them again.
  for (const lineId of [...current.otherMatchIds, ...current.rows.map(l => l._id)]) {
    const line = await BankStatementLine.findById(lineId).session(session).lean();
    if (line?.lineStatus === 'matched') await bank.setIgnored(line._id, false, { session, req });
  }
  for (const settlementId of current.settlementIds) await require('../tripCostSettlement').cancel(settlementId, { session, req, reason });
  for (const row of current.rows) {
    const line = await BankStatementLine.findById(row._id).session(session).lean();
    if (line?.lineStatus === 'created_entry') await bank.cancelLineEntry(line._id, { session, req, reason });
    // Historical covered partner lines may have generated grouped payments on ignore.
    if (line?.lineStatus === 'ignored' && line.groupPaymentIds?.length) await bank.setIgnored(line._id, false, { session, req });
  }
  const deleted = await BankStatementLine.find({ _id: { $in: current.rows.map(l => l._id) } }).session(session).lean();
  const aliases = [...new Set(deleted.flatMap(l => [l.fingerprint, ...(l.fingerprintAliases || [])]).filter(Boolean))];
  await BankStatementLine.updateMany({ _id: { $nin: deleted.map(l => l._id) }, accountId: input.accountId },
    { $pull: { fingerprintAliases: { $in: aliases } } }, { session });
  await BankStatementLine.deleteMany({ _id: { $in: deleted.map(l => l._id) }, accountId: input.accountId }, { session });
  await logAudit({ req, action: 'bank.localReset', model: 'AccountingBankStatementLine', after: { reason, deleted,
    settlementIds: current.settlementIds, releasedOtherMatches: current.otherMatchIds } }, session);
  return { deleted: deleted.length, canceledLines: current.canceledLines, settlements: current.settlementCount, releasedMatches: current.matchedLines + current.relatedMatches };
}
module.exports = { available, preview, reset };
