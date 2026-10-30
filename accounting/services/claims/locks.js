const { JournalEntry } = require('../../models');

// Serialize operations that allocate, settle, or write off the same receivable claim.
async function lockClaimAllocation(arKey, session) {
  const entry = await JournalEntry.findOne({ 'lines.arKey': arKey }).sort({ _id: 1 }).select('_id').session(session).lean();
  if (!entry) return false;
  const result = await JournalEntry.updateOne({ _id: entry._id }, { $inc: { claimAllocationVersion: 1 } }, { session });
  if (result.modifiedCount !== 1) throw new Error('Claim allocation changed concurrently; retry the transaction');
  return true;
}

async function lockClaimAllocations(arKeys, session) {
  for (const arKey of [...new Set(arKeys)].sort()) await lockClaimAllocation(arKey, session);
}

module.exports = { lockClaimAllocation, lockClaimAllocations };
