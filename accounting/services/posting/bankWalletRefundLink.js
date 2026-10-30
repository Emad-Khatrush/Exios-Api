const mongoose = require('mongoose');
const { BankStatementLine } = require('../../models/documents');
const UserStatement = require('../../../models/userStatement');
const { listUnlinked } = require('./legacyWalletRefunds');
const { fail } = require('./common');
const { logAudit } = require('../audit');

// Association only: a bank receipt and a wallet credit are different financial movements.
// Neither the wallet balance nor the journal is changed by this link.
async function link(lineId, input, { session, req }) {
  if (!mongoose.isValidObjectId(input.legacyWalletStatementId) || input.confirmSameRefund !== true)
    throw fail('اختر حركة المحفظة السابقة وأكد أنها تخص نفس الاسترداد');
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.amount <= 0 || line.movementKind === 'card_payment' || line.customerRefundId || line.receiptId
    || !['unmatched', 'created_entry'].includes(line.lineStatus)) throw fail('هذا السطر غير متاح لربط حركة المحفظة السابقة');
  if (line.legacyWalletStatementId) {
    if (String(line.legacyWalletStatementId) === String(input.legacyWalletStatementId)) return { linked: true, associationOnly: true, lineId, statementId: line.legacyWalletStatementId };
    throw fail('السطر مرتبط بحركة أخرى؛ فك الربط أولًا');
  }
  const result = await listUnlinked({ statementId: input.legacyWalletStatementId });
  const selected = result.results[0];
  if (!selected) throw fail('الحركة السابقة لم تعد متاحة؛ حدّث القائمة');
  // Recheck the ledger/source inside this transaction before reserving the statement.
  const current = await UserStatement.findById(selected._id).session(session).lean();
  const entry = await require('../../models').JournalEntry.findById(selected.entryId).session(session).lean();
  if (!current || !entry || entry.status !== 'posted' || current.amount !== selected.amount || current.currency !== selected.currency
    || String(current.user) !== String(selected.partnerId) || require('../dates').toDay(current.createdAt) !== selected.day
    || !['refund', 'compensation'].includes(current.actionType)) throw fail('تغيرت حركة المحفظة؛ حدّث القائمة');
  if (await require('../../models').AccountingEvent.exists({ refId: current._id, type: { $in: ['statement', 'statementUpdated', 'statementDeleted'] },
    status: { $in: ['pending', 'failed'] } }).session(session)) throw fail('حركة المحفظة تنتظر ترحيلًا أو تصحيحًا؛ راجعها أولًا');
  if (line.sourceProvider === 'alipay' && line.walletImpact === 'unknown') {
    if (input.confirmWalletImpact !== true) throw fail('أكد وصول المبلغ إلى رصيد Alipay');
    line.walletImpact = 'confirmed';
  }
  require('./alipayReconciliation').assertWallet(line);
  const claimed = await UserStatement.updateOne({ _id: selected._id, linkedCustomerRefundId: { $exists: false }, linkedBankRefundLineId: { $exists: false } },
    { $set: { linkedBankRefundLineId: line._id } }, { session });
  if (claimed.modifiedCount !== 1) throw fail('الحركة مرتبطة باسترداد آخر؛ حدّث القائمة');
  line.legacyWalletStatementId = selected._id;
  line.legacyWalletEntryId = selected.entryId;
  line.legacyWalletUsd = selected.usd;
  await line.save({ session });
  await logAudit({ req, action: 'bank.linkPreviousWalletRefund', model: 'AccountingBankStatementLine', docId: line._id,
    after: { statementId: selected._id, entryId: selected.entryId, walletUsd: selected.usd, associationOnly: true,
      confirmWalletImpact: input.confirmWalletImpact === true, reason: 'أكد المستخدم أن استرداد المورد يخص إضافة المحفظة السابقة؛ دون قيد مالي جديد' } }, session);
  return { linked: true, associationOnly: true, lineId: line._id, statementId: selected._id };
}

async function unlink(lineId, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line?.legacyWalletStatementId) throw fail('لا يوجد ربط بحركة محفظة سابقة');
  const statementId = line.legacyWalletStatementId;
  await UserStatement.updateOne({ _id: statementId, linkedBankRefundLineId: line._id }, { $unset: { linkedBankRefundLineId: 1 } }, { session });
  line.legacyWalletStatementId = undefined; line.legacyWalletEntryId = undefined; line.legacyWalletUsd = undefined;
  await line.save({ session });
  await logAudit({ req, action: 'bank.unlinkPreviousWalletRefund', model: 'AccountingBankStatementLine', docId: line._id,
    before: { statementId }, after: { associationOnly: true } }, session);
  return { unlinked: true };
}
module.exports = { link, unlink };
