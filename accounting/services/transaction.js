const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');

const NO_TRANSACTIONS = 'Accounting needs MongoDB transactions: the database must run as a replica set (Atlas does; a local server needs replSetName in mongod.cfg and rs.initiate()).';

// Runs fn(session) in one MongoDB transaction: the operation and its journal entry are saved
// together or not at all. fn may be retried on transient errors, so it must not have side
// effects outside the database.
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const valuation = require('./posting/alipayValuation');
      valuation.reset(session); // withTransaction can retry the callback after an aborted attempt.
      result = await require('./migration/bankTrial').transact(session, async () => {
        const value = await fn(session);
        await valuation.flush(session);
        return value;
      });
    });
    return result;
  } catch (error) {
    if (error.code === 20 || /replica set member or mongos/i.test(error.message || '')) {
      throw new ErrorHandler(500, NO_TRANSACTIONS);
    }
    throw error;
  } finally {
    require('./posting/alipayValuation').reset(session);
    await session.endSession();
  }
}

function assertInTransaction(session) {
  if (!session || !session.inTransaction()) {
    throw new Error('Journal entries can only be written inside runInTransaction');
  }
}

module.exports = { runInTransaction, assertInTransaction };
