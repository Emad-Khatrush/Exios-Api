// Invite a friend (spec 2026-11-20-referrals-design.md). A customer shares their code; a new
// customer who signs up with it gets a welcome gift. Once the friend has paid $200 of shipping or
// purchases in total (over any number of orders) the inviter gets a big reward, then 10 points for
// every $50 the friend pays, for 12 months. Steps (3 friends and $2,000 paid by friends, 5 and
// $5,000, 10 and $10,000 with the title «سفير Exios») add more. "Paid" is read from the friend's earns: 1 point before the
// multiplier per $2 of shipping or purchases (an Alipay transfer earns half, so counts half). The inviter's
// share counts toward their level (owner, 2026-11-20); the big reward, the steps and the friend's gift do not.
// Every reward of the inviter waits 24 hours (models/referralReward.js) and is cancelled when the friend's
// order behind it changes or is cancelled meanwhile; given, it is taken back if that order is cancelled later.
// Every reward is a loyalty add through grantGift, so it has its entry and happens once (eventKey).
const crypto = require('crypto');
const mongoose = require('mongoose');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const ReferralReward = require('../../../models/referralReward');
const Order = require('../../../models/order');
const ErrorHandler = require('../../../utils/errorHandler');
const { assertInTransaction } = require('../transaction');

// ---- The rules (owner may tune them here) ----
const WELCOME_POINTS = 500; // the friend, at sign-up
// Every new account without an inviter, at sign-up (owner, 2026-11-20). Invited: WELCOME_POINTS in all, never both
const SIGNUP_POINTS = 100;
const FIRST_POINTS = 1000; // the inviter, once the friend has paid QUALIFY_USD in total
const QUALIFY_USD = 200;
const SHARE_POINTS = 10; // the inviter's share: SHARE_POINTS for every SHARE_PER_USD the friend pays
// An ambassador (the step with `ambassador`) earns this instead, on what friends pay from then on (owner, 2026-11-20)
const AMBASSADOR_SHARE_POINTS = 15;
const AMBASSADOR_TITLE = 'سفير Exios';
const SHARE_PER_USD = 50;
const USD_PER_BASE_POINT = 2; // 10 points per $20 before any multiplier
const SHARE_DAYS = 365; // from the moment the friend qualified
const STAFF_SET_DAYS = 7; // staff may give a new account its inviter within this many days
// Every reward of the inviter waits this long; a changed or cancelled order cancels it (owner, 2026-11-20)
const HOLD_HOURS = 24;
// Each step needs both: that many friends who reached QUALIFY_USD, and that much paid by all friends
const STEPS = [
  { friends: 3, usd: 2000, points: 1000 },
  { friends: 5, usd: 5000, points: 2000 },
  { friends: 10, usd: 10000, points: 5000, title: AMBASSADOR_TITLE, ambassador: true },
];
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const users = () => mongoose.connection.collection('users');
const loyalty = () => require('./index');

const keys = {
  welcome: (friendId) => `REFERRAL_WELCOME:${friendId}`,
  signup: (userId) => `SIGNUP_GIFT:${userId}`,
  first: (friendId, round) => `REFERRAL_FIRST:${friendId}${round ? `:${round}` : ''}`,
  share: (earnId) => `REFERRAL_SHARE:${earnId}`,
  step: (inviterId, friends) => `REFERRAL_STEP:${inviterId}:${friends}`,
};

const normalizeCode = (code) => String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
// A first name and the initial of the last one: what other customers see of a person
const shortName = (u) => [u?.firstName, u?.lastName ? `${String(u.lastName).trim().charAt(0)}.` : ''].filter(Boolean).join(' ').trim() || 'صديقك';
const isStaff = (u) => !!(u?.roles?.isAdmin || u?.roles?.isEmployee || u?.roles?.isAccountant);
const shareEndsAt = (qualifiedAt) => (qualifiedAt ? new Date(new Date(qualifiedAt).getTime() + SHARE_DAYS * DAY_MS) : null);

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

// The customer's own code, made the first time it is asked for (unique: retried on a clash)
async function codeOf(userId) {
  const user = await users().findOne({ _id: oid(userId) }, { projection: { 'referral.code': 1 } });
  if (!user) throw new ErrorHandler(404, 'العميل غير موجود');
  if (user.referral?.code) return user.referral.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomCode();
    try {
      const res = await users().updateOne({ _id: user._id, 'referral.code': { $exists: false } }, { $set: { 'referral.code': code } });
      if (res.modifiedCount) return code;
      return (await users().findOne({ _id: user._id }, { projection: { 'referral.code': 1 } })).referral.code;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new ErrorHandler(500, 'تعذر إنشاء كود الدعوة، حاول مرة أخرى');
}

// The customer who owns a code, when they can invite (a customer, not staff), else null
async function inviterOf(code, session) {
  const clean = normalizeCode(code);
  if (clean.length !== CODE_LENGTH) return null;
  const user = await users().findOne({ 'referral.code': clean },
    { projection: { firstName: 1, lastName: 1, roles: 1, loyaltyOff: 1 }, session });
  if (!user || !user.roles?.isClient || isStaff(user)) return null;
  return user;
}

// The sign-up page checks a code before sending: { ok, name, welcomePoints }
async function check(code) {
  const inviter = await inviterOf(code);
  if (!inviter || inviter.loyaltyOff?.at) return { ok: false };
  return { ok: true, name: shortName(inviter), welcomePoints: WELCOME_POINTS };
}

// Gives a new customer their inviter, once ever, and the welcome gift. Throws a 400 with the reason
// when the code cannot be used. Returns { inviterId, inviterName, friendName, welcome } for the
// notifications, sent by the caller after the transaction.
async function attach({ friendId, code, source = 'code', by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const friend = await users().findOne({ _id: oid(friendId) },
    { projection: { firstName: 1, lastName: 1, roles: 1, referral: 1, createdAt: 1, loyaltyOff: 1 }, session });
  if (!friend) throw new ErrorHandler(404, 'العميل غير موجود');
  if (!friend.roles?.isClient || isStaff(friend)) throw new ErrorHandler(400, 'الدعوة للعملاء فقط');
  if (friend.referral?.by) throw new ErrorHandler(400, 'هذا العميل مسجّل بدعوة من قبل');
  if (source === 'staff' && friend.createdAt && now.getTime() - new Date(friend.createdAt).getTime() > STAFF_SET_DAYS * DAY_MS) {
    throw new ErrorHandler(400, `تُضاف الدعوة خلال ${STAFF_SET_DAYS} أيام من إنشاء الحساب فقط`);
  }
  const inviter = await inviterOf(code, session);
  if (!inviter) throw new ErrorHandler(400, 'كود الدعوة غير صحيح');
  if (String(inviter._id) === String(friend._id)) throw new ErrorHandler(400, 'لا يمكنك استعمال كود دعوتك');
  if (inviter.loyaltyOff?.at) throw new ErrorHandler(400, 'كود الدعوة غير متاح');
  const res = await users().updateOne({ _id: friend._id, 'referral.by': { $exists: false } }, {
    $set: { 'referral.by': inviter._id, 'referral.at': now, 'referral.source': source, ...(by && { 'referral.setBy': oid(by) }) },
  }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'هذا العميل مسجّل بدعوة من قبل');
  // A new account's gift already given (staff set the inviter later): the welcome tops it up to WELCOME_POINTS
  const signup = await LoyaltyPoint.findOne({ eventKey: keys.signup(friend._id) }).select('points').session(session).lean();
  const welcome = friend.loyaltyOff?.at ? null : await loyalty().grantGift({
    userId: friend._id, points: WELCOME_POINTS - (signup?.points || 0), reason: 'هدية الانضمام بدعوة صديق', eventKey: keys.welcome(friend._id), now,
  }, session);
  return { inviterId: String(inviter._id), inviterName: shortName(inviter), friendName: shortName(friend), welcome: welcome ? WELCOME_POINTS : 0 };
}

// A new account without an inviter: SIGNUP_POINTS once ever (not when it was invited)
async function signupGift({ userId, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const user = await users().findOne({ _id: oid(userId) }, { projection: { 'referral.by': 1, roles: 1, loyaltyOff: 1 }, session });
  if (!user || user.referral?.by || !user.roles?.isClient || isStaff(user) || user.loyaltyOff?.at) return 0;
  const lot = await loyalty().grantGift({ userId: user._id, points: SIGNUP_POINTS, reason: 'هدية فتح الحساب', eventKey: keys.signup(user._id), now }, session);
  return lot ? SIGNUP_POINTS : 0;
}

// Staff stop the rewards from one friend (what was given stays)
async function cancel({ friendId, reason, by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب إلغاء الدعوة');
  const res = await users().updateOne({ _id: oid(friendId), 'referral.by': { $exists: true }, 'referral.canceledAt': { $exists: false } },
    { $set: { 'referral.canceledAt': now, 'referral.cancelReason': why, ...(by && { 'referral.canceledBy': oid(by) }) } }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'لا توجد دعوة قائمة لهذا العميل');
  return { canceled: true };
}

const qualifiedCount = (inviterId, session) => users().countDocuments({
  'referral.by': oid(inviterId), 'referral.qualifiedAt': { $exists: true }, 'referral.canceledAt': { $exists: false },
}, { session });

// The friend's orders that no longer count: cancelled, deleted or marked "no points"
async function deadOrders(orderIds, session) {
  if (!orderIds.length) return new Set();
  const dead = await Order.find({ _id: { $in: orderIds }, $or: [{ isCanceled: true }, { isDeleted: true }, { 'loyalty.noPoints': true }] })
    .setOptions({ withDeleted: true }).select('_id').session(session || null).lean();
  return new Set(dead.map((o) => String(o._id)));
}

// What some customers paid in total, in dollars, by user id: their earns on orders that still count
async function paidUsdOf(userIds, session) {
  const result = new Map(userIds.map((id) => [String(id), 0]));
  if (!userIds.length) return result;
  const earns = await LoyaltyPoint.find({ user: { $in: userIds.map(oid) }, kind: 'earn' })
    .select('user basePoints points orderId').session(session || null).lean();
  const dead = await deadOrders([...new Set(earns.map((e) => String(e.orderId)).filter(Boolean))].map(oid), session);
  for (const e of earns) {
    if (dead.has(String(e.orderId))) continue;
    const key = String(e.user);
    result.set(key, result.get(key) + (Number.isFinite(e.basePoints) ? e.basePoints : e.points) * USD_PER_BASE_POINT);
  }
  return result;
}
// What the inviter's friends whose referral stands paid together
async function activeFriendsPaid(inviterId, session) {
  const ids = (await users().find({ 'referral.by': oid(inviterId), 'referral.canceledAt': { $exists: false } },
    { projection: { _id: 1 }, session }).toArray()).map((f) => f._id);
  return [...(await paidUsdOf(ids, session)).values()].reduce((sum, v) => sum + v, 0);
}
const shareOf = (basePoints, perShare = SHARE_POINTS) => Math.floor((basePoints * USD_PER_BASE_POINT * perShare) / SHARE_PER_USD);
// An ambassador's share applies to friends' earns made from the moment they became one
const isAmbassadorAt = (ambassadorAt, at) => !!ambassadorAt && new Date(at) >= new Date(ambassadorAt);
const baseOf = (earn) => (Number.isFinite(earn.basePoints) ? earn.basePoints : earn.points);

// Puts a reward on hold for HOLD_HOURS (once per eventKey). Returns true when it was queued.
async function hold(row, now, session) {
  if (await ReferralReward.exists({ eventKey: row.eventKey }).session(session)) return false;
  await ReferralReward.create([{ ...row, releaseAt: new Date(now.getTime() + HOLD_HOURS * 3600 * 1000) }], { session });
  return true;
}

// Right after a friend's earn, in its transaction: qualifies the friend at $200 paid in total (the
// big reward), the inviter's share while the 12 months last, and the steps once both the friends and
// the dollars are reached. Nothing is given here: every reward waits 24 hours (releaseDue).
async function afterEarn(earn, { now = new Date(), session } = {}) {
  assertInTransaction(session);
  const friend = await users().findOne({ _id: oid(earn.user) },
    { projection: { firstName: 1, lastName: 1, referral: 1 }, session });
  const ref = friend?.referral;
  if (!ref?.by || ref.canceledAt) return null;
  const inviterId = String(ref.by);
  if (await loyalty().isOff(inviterId, session)) return null;
  const name = shortName(friend);
  const base = { inviter: oid(inviterId), friend: friend._id, sourceEarn: earn._id, sourceOrder: earn.orderId };
  let { qualifiedAt } = ref;
  if (!qualifiedAt) {
    if (((await paidUsdOf([friend._id], session)).get(String(friend._id)) || 0) < QUALIFY_USD) return null;
    qualifiedAt = now;
    await users().updateOne({ _id: friend._id, 'referral.qualifiedAt': { $exists: false } }, { $set: { 'referral.qualifiedAt': now } }, { session });
    // The big reward does not count toward the level (owner, 2026-11-20)
    await hold({ ...base, kind: 'first', points: FIRST_POINTS, reason: `مكافأة دعوة: ${name} دفع ${QUALIFY_USD}$`,
      eventKey: keys.first(friend._id, ref.round) }, now, session);
  }
  const earnedAt = new Date(earn.earnedAt || now);
  const inviter = await users().findOne({ _id: oid(inviterId) }, { projection: { 'referral.ambassadorAt': 1 }, session });
  const share = shareOf(baseOf(earn), isAmbassadorAt(inviter?.referral?.ambassadorAt, earnedAt) ? AMBASSADOR_SHARE_POINTS : SHARE_POINTS);
  if (share > 0 && earnedAt < shareEndsAt(qualifiedAt)) {
    // Only the share counts toward the level
    await hold({ ...base, kind: 'share', points: share, levelPoints: share, reason: `حصتك من شحن صديقك ${name}`, eventKey: keys.share(earn._id) }, now, session);
  }
  // Every earn of a friend adds to the dollars, so the steps are checked each time (again when given)
  for (const step of await stepsReached(inviterId, session)) {
    await hold({ inviter: oid(inviterId), kind: 'step', points: step.points, reason: `مكافأة ${step.friends} أصدقاء`,
      step: { friends: step.friends, usd: step.usd, title: step.title, ambassador: !!step.ambassador }, eventKey: keys.step(inviterId, step.friends) }, now, session);
  }
  return null;
}

async function stepsReached(inviterId, session) {
  const count = await qualifiedCount(inviterId, session);
  if (count < STEPS[0].friends) return [];
  const paid = await activeFriendsPaid(inviterId, session);
  return STEPS.filter((s) => s.friends <= count && s.usd <= paid);
}

// Why a reward on hold can no longer be given, or null when it still can
async function holdProblem(reward, session) {
  if (await loyalty().isOff(reward.inviter, session)) return 'نقاط الداعي موقوفة';
  if (reward.kind === 'step') {
    const still = (await stepsReached(reward.inviter, session)).some((s) => s.friends === reward.step?.friends);
    return still ? null : 'لم تعد شروط المكافأة متحققة';
  }
  const friend = await users().findOne({ _id: reward.friend }, { projection: { referral: 1 }, session });
  if (!friend?.referral?.by || friend.referral.canceledAt) return 'أُلغيت الدعوة';
  // Changed (repriced, written off, owed again) or cancelled since it was earned
  if (!await loyalty().earnStillValid(reward.sourceEarn, session)) return 'عُدّلت طلبية الصديق أو أُلغيت';
  if (reward.kind === 'first' && ((await paidUsdOf([reward.friend], session)).get(String(reward.friend)) || 0) < QUALIFY_USD) {
    return `لم يعد مجموع ما دفعه الصديق ${QUALIFY_USD}$`;
  }
  return null;
}

// A first reward that did not stand: the friend can qualify again later (a new round, a new eventKey)
async function requalify(friendId, session) {
  await users().updateOne({ _id: oid(friendId) }, { $unset: { 'referral.qualifiedAt': 1 }, $inc: { 'referral.round': 1 } }, { session });
}
async function cancelHeld(reward, why, now, session) {
  await ReferralReward.updateOne({ _id: reward._id, status: 'pending' }, {
    $set: { status: 'canceled', canceledAt: now, cancelReason: why, eventKey: `${reward.eventKey}:canceled:${reward._id}` },
  }, { session });
  if (reward.kind === 'first') await requalify(reward.friend, session);
}

// The hourly job: rewards whose 24 hours are over are given when nothing changed, else cancelled.
// One notification per inviter for what was given.
async function releaseDue({ now = new Date() } = {}) {
  const { runInTransaction } = require('../transaction');
  const due = await ReferralReward.find({ status: 'pending', releaseAt: { $lte: now } }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
  const told = new Map(); // inviterId -> { firsts, share, steps, level }
  let granted = 0;
  let canceled = 0;
  let failed = 0;
  for (const { _id } of due) {
    try {
      const out = await runInTransaction(async (session) => {
        const reward = await ReferralReward.findOne({ _id, status: 'pending' }).session(session).lean();
        if (!reward) return null;
        const problem = await holdProblem(reward, session);
        if (problem) { await cancelHeld(reward, problem, now, session); return { canceled: true }; }
        const lot = await loyalty().grantGift({ userId: reward.inviter, points: reward.points, reason: reward.reason, eventKey: reward.eventKey,
          ...(reward.levelPoints > 0 && { levelPoints: reward.levelPoints }), now }, session);
        await ReferralReward.updateOne({ _id: reward._id }, { $set: { status: 'granted', grantedAt: now, ...(lot && { lotId: lot._id }) } }, { session });
        if (reward.kind === 'step' && reward.step?.ambassador) {
          await users().updateOne({ _id: reward.inviter, 'referral.ambassadorAt': { $exists: false } }, { $set: { 'referral.ambassadorAt': now } }, { session });
        }
        const moved = reward.levelPoints > 0 ? await require('./levels').refreshLevel(reward.inviter, { now, session }) : null;
        const friend = reward.friend ? await users().findOne({ _id: reward.friend }, { projection: { firstName: 1, lastName: 1 }, session }) : null;
        return { reward, friendName: shortName(friend), movedTo: moved?.to || null };
      });
      if (!out) continue;
      if (out.canceled) { canceled += 1; continue; }
      granted += 1;
      const key = String(out.reward.inviter);
      const theirs = told.get(key) || { firsts: [], share: 0, steps: [], level: null };
      if (out.reward.kind === 'first') theirs.firsts.push(out.friendName);
      if (out.reward.kind === 'share') theirs.share += out.reward.points;
      if (out.reward.kind === 'step') theirs.steps.push({ ...out.reward.step, points: out.reward.points });
      if (out.movedTo) theirs.level = out.movedTo;
      told.set(key, theirs);
    } catch (error) {
      failed += 1;
      console.error(`[referrals] ${_id}: ${error.message}`);
    }
  }
  const customerPush = require('../../../utils/customerPush');
  for (const [inviterId, got] of told) await customerPush.referralRewards(inviterId, got);
  return { granted, canceled, failed };
}

// The hourly job: a reward given whose friend's order was cancelled (or deleted, or marked "no
// points") is taken back. A big reward is taken back only when the friend no longer reaches $200.
async function takeBackDue() {
  const { runInTransaction } = require('../transaction');
  const given = await ReferralReward.find({ status: 'granted', sourceOrder: { $exists: true } }).select('_id sourceOrder').lean();
  const dead = await deadOrders([...new Set(given.map((r) => String(r.sourceOrder)))].map(oid));
  let revoked = 0;
  let failed = 0;
  for (const { _id } of given.filter((r) => dead.has(String(r.sourceOrder)))) {
    try {
      const done = await runInTransaction(async (session) => {
        const reward = await ReferralReward.findOne({ _id, status: 'granted' }).session(session).lean();
        if (!reward) return false;
        if (reward.kind === 'first' && ((await paidUsdOf([reward.friend], session)).get(String(reward.friend)) || 0) >= QUALIFY_USD) return false;
        if (reward.lotId) await loyalty().takeBackLot(reward.lotId, 'revoke', session);
        await ReferralReward.updateOne({ _id: reward._id }, { $set: { status: 'revoked', canceledAt: new Date(), cancelReason: 'أُلغيت طلبية الصديق' } }, { session });
        if (reward.kind === 'first') await requalify(reward.friend, session);
        return true;
      });
      if (done) revoked += 1;
    } catch (error) {
      failed += 1;
      console.error(`[referrals] take back ${_id}: ${error.message}`);
    }
  }
  return { revoked, failed };
}

// Both, for the hourly loyalty jobs: take back first, then release
async function runDue(options) {
  const back = await takeBackDue(options);
  const released = await releaseDue(options);
  return { ...released, revoked: back.revoked, failed: released.failed + back.failed };
}

// Points each friend brought the inviter (given, and still on hold), by friend id
async function pointsByFriend(inviterId, friendIds) {
  const given = new Map(friendIds.map((id) => [String(id), 0]));
  const held = new Map(friendIds.map((id) => [String(id), 0]));
  const rows = await ReferralReward.find({ inviter: oid(inviterId), friend: { $in: friendIds.map(oid) }, status: { $in: ['granted', 'pending'] } })
    .select('friend points status').lean();
  for (const r of rows) {
    const map = r.status === 'granted' ? given : held;
    map.set(String(r.friend), (map.get(String(r.friend)) || 0) + r.points);
  }
  return { given, held };
}

const friendStatus = (ref, now) => {
  if (ref.canceledAt) return 'canceled';
  if (!ref.qualifiedAt) return 'joined';
  return now < shareEndsAt(ref.qualifiedAt) ? 'sharing' : 'ended';
};

// The invite page: the code, the rules, the steps and every friend with where they stand
async function mine(userId, { now = new Date() } = {}) {
  if (await loyalty().isOff(userId)) return { off: true };
  const code = await codeOf(userId);
  const ambassadorAt = (await users().findOne({ _id: oid(userId) }, { projection: { 'referral.ambassadorAt': 1 } }))?.referral?.ambassadorAt;
  const friends = await users().find({ 'referral.by': oid(userId) },
    { projection: { firstName: 1, lastName: 1, referral: 1, createdAt: 1 } }).sort({ 'referral.at': -1 }).limit(200).toArray();
  const { given: points, held } = await pointsByFriend(userId, friends.map((f) => f._id));
  const paid = await paidUsdOf(friends.map((f) => f._id));
  const friendsPaidUsd = friends.filter((f) => !f.referral.canceledAt).reduce((sum, f) => sum + (paid.get(String(f._id)) || 0), 0);
  const steps = await ReferralReward.find({ inviter: oid(userId), kind: 'step', status: 'granted' }).select('points').lean();
  const heldTotal = (await ReferralReward.find({ inviter: oid(userId), status: 'pending' }).select('points').lean()).reduce((sum, r) => sum + r.points, 0);
  const qualified = friends.filter((f) => f.referral.qualifiedAt && !f.referral.canceledAt).length;
  const rows = friends.map((f) => ({
    id: String(f._id),
    name: shortName(f),
    joinedAt: f.referral.at || f.createdAt,
    status: friendStatus(f.referral, now),
    qualifiedAt: f.referral.qualifiedAt || null,
    shareEndsAt: shareEndsAt(f.referral.qualifiedAt),
    points: points.get(String(f._id)) || 0,
    heldPoints: held.get(String(f._id)) || 0,
    paidUsd: paid.get(String(f._id)) || 0,
    // What is left to pay before the inviter's big reward (0 once reached)
    leftUsd: f.referral.qualifiedAt ? 0 : Math.max(QUALIFY_USD - (paid.get(String(f._id)) || 0), 0),
  }));
  return {
    off: false,
    code,
    path: `/r/${code}`, // the app puts its own address before it (QA or production)
    welcomePoints: WELCOME_POINTS,
    firstPoints: FIRST_POINTS,
    qualifyUsd: QUALIFY_USD,
    sharePoints: SHARE_POINTS,
    ambassadorSharePoints: AMBASSADOR_SHARE_POINTS,
    ambassadorTitle: AMBASSADOR_TITLE,
    // When the customer became an ambassador (their share is AMBASSADOR_SHARE_POINTS since), or null
    ambassadorAt: ambassadorAt || null,
    sharePerUsd: SHARE_PER_USD,
    months: Math.round(SHARE_DAYS / 30.4),
    qualified,
    friendsPaidUsd,
    steps: STEPS.map((s) => ({ ...s, reached: qualified >= s.friends && friendsPaidUsd >= s.usd })),
    friends: rows,
    totalPoints: rows.reduce((sum, r) => sum + r.points, 0) + steps.reduce((sum, s) => sum + s.points, 0),
    // Rewards waiting their 24 hours
    heldPoints: heldTotal,
    holdHours: HOLD_HOURS,
  };
}

// What staff see on a customer: who invited them and whom they invited
async function staffInfo(userId) {
  const user = await users().findOne({ _id: oid(userId) }, { projection: { referral: 1, createdAt: 1 } });
  if (!user) throw new ErrorHandler(404, 'العميل غير موجود');
  const ref = user.referral || {};
  const inviter = ref.by ? await users().findOne({ _id: ref.by }, { projection: { firstName: 1, lastName: 1, customerId: 1 } }) : null;
  const [invited, qualified] = await Promise.all([
    users().countDocuments({ 'referral.by': user._id }),
    qualifiedCount(user._id),
  ]);
  const canSetUntil = user.createdAt ? new Date(new Date(user.createdAt).getTime() + STAFF_SET_DAYS * DAY_MS) : null;
  return {
    code: ref.code || null,
    by: inviter ? { id: String(inviter._id), name: [inviter.firstName, inviter.lastName].filter(Boolean).join(' '), customerId: inviter.customerId } : null,
    at: ref.at || null,
    source: ref.source || null,
    qualifiedAt: ref.qualifiedAt || null,
    shareEndsAt: shareEndsAt(ref.qualifiedAt),
    canceledAt: ref.canceledAt || null,
    cancelReason: ref.cancelReason || null,
    canSet: !ref.by && !!canSetUntil && Date.now() <= canSetUntil.getTime(),
    canSetUntil,
    invited,
    qualified,
    qualifyUsd: QUALIFY_USD,
    ambassadorAt: ref.ambassadorAt || null,
  };
}

module.exports = {
  WELCOME_POINTS, FIRST_POINTS, HOLD_HOURS, QUALIFY_USD, SHARE_POINTS, AMBASSADOR_SHARE_POINTS, AMBASSADOR_TITLE, SHARE_PER_USD, SHARE_DAYS, STAFF_SET_DAYS, STEPS, CODE_LENGTH,
  SIGNUP_POINTS, keys, normalizeCode, shortName, codeOf, check, attach, signupGift, cancel, afterEarn, releaseDue, takeBackDue, runDue, mine, staffInfo,
};
