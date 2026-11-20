// Passport numbers for accounts opened before sign-up asked for one (owner, 2026-11-20): their stored
// passport photo is read once (Google Cloud Vision, utils/passportNumber.js). A number confirmed by
// its check digit is saved as the account's number; any other read is kept for staff to confirm when
// they review the passport. Two accounts with the same passport are both marked (numberConflict) for
// staff to decide: neither gets the number. Run by scripts/backfillPassportNumbers.js.
const User = require('../models/user');

// Accounts with a stored photo, no number and not tried yet
const candidatesFilter = {
  'roles.isClient': true,
  'passportVerification.imageUrl': { $exists: true, $nin: [null, ''] },
  'passportVerification.number': { $exists: false },
  'passportVerification.numberTriedAt': { $exists: false },
};

// Reads one account's photo and saves what it gave. `read(buffer)` and `download(url)` are injected
// (Vision and the bucket in the script, stubs in tests). Returns what happened.
async function backfillOne(user, { read, download, now = new Date() }) {
  const buffer = await download(user.passportVerification.imageUrl);
  const result = buffer ? await read(buffer) : null;
  const set = { 'passportVerification.numberTriedAt': now };
  if (!result?.number || !result.passport) {
    await User.updateOne({ _id: user._id }, { $set: set });
    return { outcome: buffer ? 'unread' : 'no-file' };
  }
  const number = result.number;
  set['passportVerification.numberRead'] = number;
  const others = await User.find({ _id: { $ne: user._id }, $or: [{ 'passportVerification.number': number }, { 'passportVerification.numberRead': number }] })
    .select('_id').lean();
  if (others.length) {
    await User.updateOne({ _id: user._id }, { $set: set, $addToSet: { 'passportVerification.numberConflict': { $each: others.map((o) => o._id) } } });
    await User.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $addToSet: { 'passportVerification.numberConflict': user._id } });
    return { outcome: 'conflict', number, with: others.map((o) => String(o._id)) };
  }
  if (result.checked) {
    set['passportVerification.number'] = number;
    set['passportVerification.numberSource'] = 'backfill';
  }
  await User.updateOne({ _id: user._id }, { $set: set });
  return { outcome: result.checked ? 'saved' : 'to-confirm', number };
}

async function backfill({ read, download, limit = Infinity, onEach = () => {} }) {
  const totals = { saved: 0, 'to-confirm': 0, conflict: 0, unread: 0, 'no-file': 0, failed: 0 };
  const conflicts = [];
  const cursor = User.find(candidatesFilter).select('_id customerId passportVerification.imageUrl').sort({ createdAt: 1 }).lean().cursor();
  let done = 0;
  for await (const user of cursor) {
    if (done >= limit) break;
    done += 1;
    try {
      const out = await backfillOne(user, { read, download });
      totals[out.outcome] += 1;
      if (out.outcome === 'conflict') conflicts.push({ customerId: user.customerId, with: out.with });
      onEach(user, out);
    } catch (error) {
      totals.failed += 1;
      onEach(user, { outcome: 'failed', error: error.message });
    }
  }
  return { done, totals, conflicts };
}

module.exports = { candidatesFilter, backfillOne, backfill };
