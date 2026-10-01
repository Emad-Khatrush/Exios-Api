const { Counter } = require('../models');

// Incremented inside the caller's transaction: an aborted transaction gives its number back,
// so sequences have no gaps and no duplicates.
async function nextSeq(key, session) {
  const counter = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return counter.seq;
}

module.exports = { nextSeq };
