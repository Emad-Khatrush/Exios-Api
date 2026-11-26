// node scripts/holdLaunchGifts.js [--apply]
//
// From 2026-11-27 the sign-up gift (100) and the invite welcome (300) wait for the customer's first
// order paid in full (accounting/services/loyalty, GIFT_HOLD_DAYS). Gifts given as points before that
// (the launch day) are put on hold the same way, so the books show no liability for customers who
// never ship: each such lot, still unspent, of a customer with no paid order is taken back (a revoke
// with its reversing entry) and becomes a hold of the same points, lapsing GIFT_HOLD_DAYS (90) days after the gift.
// A lot already spent, or of a customer who has a paid order, is left as it is (listed).
// Without --apply it only lists what would change. Safe to run again.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const LoyaltyPoint = require('../models/loyaltyPoint');
const LoyaltyGiftHold = require('../models/loyaltyGiftHold');
const { runInTransaction } = require('../accounting/services/transaction');
const { lockWalletOwner } = require('../utils/walletLock');

const apply = process.argv.includes('--apply');
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;
const HELD_REASON = 'هدية تنتظر أول طلبية مدفوعة';

(async () => {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  const loyalty = require('../accounting/services/loyalty');
  const lots = await LoyaltyPoint.find({ kind: 'add', eventKey: { $regex: /^(SIGNUP_GIFT|REFERRAL_WELCOME):[0-9a-f]{24}$/ } }).sort({ _id: 1 }).lean();
  const rows = [];
  for (const lot of lots) {
    const why = await (async () => {
      if (await LoyaltyGiftHold.exists({ eventKey: lot.eventKey })) return 'already held';
      if (lot.remaining !== lot.points) return `spent ${lot.points - lot.remaining} of ${lot.points}: left as it is`;
      const earn = await LoyaltyPoint.findOne({ user: lot.user, kind: 'earn' }).select('_id').lean();
      if (earn && await loyalty.earnStillValid(earn._id)) return 'has a paid order: left as it is';
      return null;
    })();
    rows.push({ user: String(lot.user), gift: lot.eventKey.split(':')[0], points: lot.points, at: lot.createdAt, action: why || (apply ? 'held' : 'would be held') });
    if (why || !apply) continue;
    await runInTransaction(async (session) => {
      await lockWalletOwner(lot.user, session);
      const taken = await loyalty.takeBackLot(lot._id, 'revoke', session, { reason: HELD_REASON });
      if (!taken) throw new Error(`lot ${lot._id} changed; run again`);
      await LoyaltyGiftHold.create([{
        user: lot.user, points: lot.points, reason: lot.reason || 'هدية', eventKey: lot.eventKey,
        expiresAt: new Date(new Date(lot.createdAt || Date.now()).getTime() + loyalty.GIFT_HOLD_DAYS * 24 * 60 * 60 * 1000),
      }], { session });
    });
  }
  console.table(rows);
  console.log(apply ? 'Done.' : 'Dry run: nothing changed. Run again with --apply.');
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
