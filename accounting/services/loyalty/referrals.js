// Invite a friend (spec 2026-11-20-referrals-design.md). A customer shares their code; a new
// customer who signs up with it gets a welcome gift. Once the friend has paid $200 of shipping or
// purchases in total (over any number of orders) the inviter gets a big reward, then 10 points for
// every $50 the friend pays, for 12 months. Steps (3 friends and $2,000 paid by friends, 5 and
// $5,000, 10 and $10,000 with the title «سفير Exios») add more. "Paid" is read from the friend's earns: 1 point before the
// multiplier per $2 of shipping or purchases (an Alipay transfer earns half, so counts half). The inviter's
// rewards count toward their level (owner, 2026-11-20); the friend's welcome gift does not.
// Every reward is a loyalty add through grantGift, so it has its entry and happens once (eventKey).
const crypto = require('crypto');
const mongoose = require('mongoose');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
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
  first: (friendId) => `REFERRAL_FIRST:${friendId}`,
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

// What some customers paid in total, in dollars, by user id (from their earns)
async function paidUsdOf(userIds, session) {
  const result = new Map(userIds.map((id) => [String(id), 0]));
  if (!userIds.length) return result;
  const rows = await LoyaltyPoint.aggregate([
    { $match: { user: { $in: userIds.map(oid) }, kind: 'earn' } },
    { $group: { _id: '$user', base: { $sum: { $ifNull: ['$basePoints', '$points'] } } } },
  ]).session(session || null);
  for (const row of rows) result.set(String(row._id), row.base * USD_PER_BASE_POINT);
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

// Right after a friend's earn, in its transaction: qualifies the friend at $200 paid in total (the
// big reward), gives the inviter their share while the 12 months last, and the steps once both the
// friends and the dollars are reached. Returns what to tell the inviter ({ inviterId, friendName,
// first, share, step, movedTo }) or null.
async function afterEarn(earn, { now = new Date(), session } = {}) {
  assertInTransaction(session);
  const friend = await users().findOne({ _id: oid(earn.user) },
    { projection: { firstName: 1, lastName: 1, referral: 1 }, session });
  const ref = friend?.referral;
  if (!ref?.by || ref.canceledAt) return null;
  const inviterId = String(ref.by);
  let { qualifiedAt } = ref;
  let qualifiedNow = false;
  if (!qualifiedAt) {
    if (((await paidUsdOf([friend._id], session)).get(String(friend._id)) || 0) < QUALIFY_USD) return null;
    qualifiedAt = now;
    qualifiedNow = true;
    await users().updateOne({ _id: friend._id, 'referral.qualifiedAt': { $exists: false } }, { $set: { 'referral.qualifiedAt': now } }, { session });
  }
  const result = { inviterId, friendName: shortName(friend), first: 0, share: 0, step: null, movedTo: null };
  if (await loyalty().isOff(inviterId, session)) return null;
  const grant = (points, reason, eventKey) => loyalty().grantGift({ userId: inviterId, points, reason, eventKey, levelPoints: points, now }, session);
  if (qualifiedNow && await grant(FIRST_POINTS, `مكافأة دعوة: ${result.friendName} دفع ${QUALIFY_USD}$`, keys.first(friend._id))) {
    result.first = FIRST_POINTS;
  }
  const earnedAt = new Date(earn.earnedAt || now);
  const inviter = await users().findOne({ _id: oid(inviterId) }, { projection: { 'referral.ambassadorAt': 1 }, session });
  const ambassador = isAmbassadorAt(inviter?.referral?.ambassadorAt, earnedAt);
  const share = shareOf(Number.isFinite(earn.basePoints) ? earn.basePoints : earn.points, ambassador ? AMBASSADOR_SHARE_POINTS : SHARE_POINTS);
  if (share > 0 && earnedAt < shareEndsAt(qualifiedAt) && await grant(share, `حصتك من شحن صديقك ${result.friendName}`, keys.share(earn._id))) {
    result.share = share;
  }
  // Every earn of a friend adds to the dollars, so the steps are checked each time
  const count = await qualifiedCount(inviterId, session);
  if (count >= STEPS[0].friends) {
    const paid = await activeFriendsPaid(inviterId, session);
    for (const step of STEPS.filter((s) => s.friends <= count && s.usd <= paid)) {
      if (await grant(step.points, `مكافأة ${step.friends} أصدقاء`, keys.step(inviterId, step.friends))) {
        result.step = step;
        if (step.ambassador) {
          await users().updateOne({ _id: oid(inviterId), 'referral.ambassadorAt': { $exists: false } }, { $set: { 'referral.ambassadorAt': now } }, { session });
        }
      }
    }
  }
  if (!result.first && !result.share && !result.step) return null;
  const moved = await require('./levels').refreshLevel(inviterId, { now, session });
  result.movedTo = moved?.to || null;
  return result;
}

// Points each friend brought the inviter, by friend id
async function pointsByFriend(inviterId, friendIds) {
  const result = new Map(friendIds.map((id) => [String(id), 0]));
  const firstKeys = friendIds.map((id) => keys.first(id));
  const rows = await LoyaltyPoint.find({ user: oid(inviterId), kind: 'add', $or: [{ eventKey: { $in: firstKeys } }, { eventKey: /^REFERRAL_SHARE:/ }] })
    .select('eventKey points').lean();
  const shareIds = rows.filter((r) => r.eventKey.startsWith('REFERRAL_SHARE:')).map((r) => r.eventKey.split(':')[1]).filter((id) => mongoose.isValidObjectId(id));
  const earnOwner = new Map((await LoyaltyPoint.find({ _id: { $in: shareIds.map(oid) } }).select('user').lean()).map((e) => [String(e._id), String(e.user)]));
  for (const row of rows) {
    const [kind, id] = row.eventKey.split(':');
    const friend = kind === 'REFERRAL_FIRST' ? id : earnOwner.get(id);
    if (friend && result.has(friend)) result.set(friend, result.get(friend) + row.points);
  }
  return result;
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
  const points = await pointsByFriend(userId, friends.map((f) => f._id));
  const paid = await paidUsdOf(friends.map((f) => f._id));
  const friendsPaidUsd = friends.filter((f) => !f.referral.canceledAt).reduce((sum, f) => sum + (paid.get(String(f._id)) || 0), 0);
  const steps = await LoyaltyPoint.find({ user: oid(userId), eventKey: { $regex: `^REFERRAL_STEP:${userId}:` } }).select('points').lean();
  const qualified = friends.filter((f) => f.referral.qualifiedAt && !f.referral.canceledAt).length;
  const rows = friends.map((f) => ({
    id: String(f._id),
    name: shortName(f),
    joinedAt: f.referral.at || f.createdAt,
    status: friendStatus(f.referral, now),
    qualifiedAt: f.referral.qualifiedAt || null,
    shareEndsAt: shareEndsAt(f.referral.qualifiedAt),
    points: points.get(String(f._id)) || 0,
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
  WELCOME_POINTS, FIRST_POINTS, QUALIFY_USD, SHARE_POINTS, AMBASSADOR_SHARE_POINTS, AMBASSADOR_TITLE, SHARE_PER_USD, SHARE_DAYS, STAFF_SET_DAYS, STEPS, CODE_LENGTH,
  SIGNUP_POINTS, keys, normalizeCode, shortName, codeOf, check, attach, signupGift, cancel, afterEarn, mine, staffInfo,
};
