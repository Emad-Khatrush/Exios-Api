const { JournalEntry } = require('../../models');
const { BankStatementLine } = require('../../models/documents');
const { logAudit } = require('../audit');

// Reopen the whole match if any constituent is cancelled. Release even the surviving
// entries so they can participate in a corrected grouping. Called within the reversal
// transaction; a bank-line correction owns its own loaded line and is excluded here.
async function releaseReversedMatches(reversedIds, { session, req, reason, fromBankLineId, canceledModel, canceledId }) {
  if (!reversedIds.length) return;
  const linked = await BankStatementLine.find({ lineStatus: { $in: ['matched', 'created_entry'] },
    $or: [{ entryId: { $in: reversedIds } }, { matchedEntryIds: { $in: reversedIds } }],
    ...(fromBankLineId && { _id: { $ne: fromBankLineId } }),
  }).session(session);
  for (const line of linked) {
    const ids = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean);
    await JournalEntry.updateMany({ _id: { $in: ids } }, { $pull: { bankMatchedAccounts: line.accountId } }, { session });
    line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...ids.map(String)])];
    line.lineStatus = 'unmatched'; line.matchedEntryIds = []; line.entryId = undefined;
    line.matchGroupId = undefined;
    line.financialActionId = undefined;
    line.postingAttempt = (line.postingAttempt || 0) + 1;
    if (canceledModel === 'AccountingSupplierPayment') {
      line.paymentId = undefined;
      if (line.billId) line.billCreatedFromStatement = false;
    }
    await line.save({ session });
    if (line.sourceProvider === 'alipay') require('./alipayValuation').queue(session, line.accountId, req?.user);
    await logAudit({ req, action: 'bank.matchReopened', model: 'AccountingBankStatementLine', docId: line._id,
      after: { reason, canceledModel, canceledId, entryIds: ids } }, session);
  }
}
module.exports = { releaseReversedMatches };
