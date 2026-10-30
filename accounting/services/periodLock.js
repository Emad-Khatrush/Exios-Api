const { AccountingSettings } = require('../models');
const { assertInTransaction } = require('./transaction');

// Posting, outbox writes and closing share this gate. A concurrent close forces
// the other transaction to retry and read the committed period boundary.
async function lockPeriod(session) {
  assertInTransaction(session);
  return AccountingSettings.findOneAndUpdate(
    { key: 'main' }, { $inc: { periodVersion: 1 } }, { new: true, session },
  ).lean();
}

module.exports = { lockPeriod };
