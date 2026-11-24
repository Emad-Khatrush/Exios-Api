// Invite a friend (spec 2026-11-20-referrals-design.md). A customer shares their code; a new
// customer who signs up with it gets a welcome gift. Once the friend has paid $200 of shipping or
// purchases in total (over any number of orders) the inviter gets a big reward, then 10 points for
// every $50 the friend pays, for 12 months. Steps (3 friends and $2,000 paid by friends, 5 and
// $5,000, 10 and $10,000 with the title «سفير إكسيوس») add more. "Paid" is read from the friend's earns: 1 point before the
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
const WELCOME_POINTS = 300; // the friend, at sign-up
// Every new account without an inviter, at sign-up (owner, 2026-11-20). Invited: WELCOME_POINTS in all, never both
const SIGNUP_POINTS = 100;
const FIRST_POINTS = 500; // the inviter, once the friend has paid QUALIFY_USD in total
const QUALIFY_USD = 200;
const SHARE_POINTS = 10; // the inviter's share: SHARE_POINTS for every SHARE_PER_USD the friend pays
// An ambassador (the step with `ambassador`) earns this instead, on what friends pay from then on (owner, 2026-11-20)
const AMBASSADOR_SHARE_POINTS = 15;
const AMBASSADOR_TITLE = 'سفير إكسيوس';
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
// The inviter's own pages (their friends, their record) show the friend's full name (owner, 2026-11-20)
const fullName = (u) => [u?.firstName, u?.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || 'صديقك';
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
    { projection: { firstName: 1, lastName: 1, roles: 1, loyaltyOff: 1, termsAcceptance: 1 }, session });
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
    { projection: { firstName: 1, lastName: 1, roles: 1, referral: 1, createdAt: 1, loyaltyOff: 1, termsAcceptance: 1 }, session });
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
  // Signs that the friend may be the inviter, or the inviter's family shipping under another name: the
  // rewards from this friend then wait for staff to approve them (owner, 2026-11-20)
  const flags = suspicionFlags(inviter, friend);
  const res = await users().updateOne({ _id: friend._id, 'referral.by': { $exists: false } }, {
    $set: {
      'referral.by': inviter._id, 'referral.at': now, 'referral.source': source, ...(by && { 'referral.setBy': oid(by) }),
      ...(flags.length && { 'referral.flags': flags, 'referral.review': { status: 'pending' } }),
    },
  }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'هذا العميل مسجّل بدعوة من قبل');
  // A new account's gift already given (staff set the inviter later): the welcome tops it up to WELCOME_POINTS
  const signup = await LoyaltyPoint.findOne({ eventKey: keys.signup(friend._id) }).select('points').session(session).lean();
  const welcome = friend.loyaltyOff?.at ? null : await loyalty().grantGift({
    userId: friend._id, points: WELCOME_POINTS - (signup?.points || 0), reason: 'هدية الانضمام بدعوة صديق', eventKey: keys.welcome(friend._id), now,
  }, session);
  return { inviterId: String(inviter._id), inviterName: shortName(inviter), friendName: shortName(friend), welcome: welcome ? WELCOME_POINTS : 0 };
}

// ---- Suspicious referrals (owner, 2026-11-20) ----

// A family name as written in either alphabet, for comparing: lower case, no spaces or marks, the
// Arabic article and letter variants folded
const familyKey = (name) => String(name || '').trim().toLowerCase()
  .replace(/^(ال|al[-\s]?|el[-\s]?)/, '').replace(/[\u064B-\u0652\s'’.-]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
const signups = (u) => (u?.termsAcceptance || []).filter((t) => t.ip);

// Why a referral looks like one person (or one family) on both sides. A shared network alone is not
// a sign in Libya (mobile networks put many people behind one address): the same address AND the
// same browser is.
function suspicionFlags(inviter, friend) {
  const flags = [];
  const mine = signups(inviter);
  const theirs = signups(friend);
  if (theirs.some((f) => mine.some((i) => i.ip === f.ip && i.userAgent && i.userAgent === f.userAgent))) {
    flags.push({ code: 'same-device', detail: 'سجّل من نفس الجهاز والشبكة التي سجّل منها الداعي' });
  }
  const a = familyKey(inviter?.lastName);
  if (a.length >= 3 && a === familyKey(friend?.lastName)) flags.push({ code: 'same-family', detail: 'نفس اسم العائلة' });
  return flags;
}

// Why a reward waits (not given yet, not cancelled), or null
async function waitReason(reward, session) {
  if (reward.kind === 'step') return reward.approvedAt ? null : 'review';
  const friend = await users().findOne({ _id: reward.friend }, { projection: { 'passportVerification.status': 1, 'referral.review': 1 }, session });
  if (friend?.referral?.review?.status === 'pending') return 'review';
  if (friend?.passportVerification?.status !== 'verified') return 'passport';
  return null;
}

// What staff review: referrals that look suspicious, and the big step rewards (always), oldest first
async function reviewQueue() {
  const flagged = await users().find({ 'referral.review.status': 'pending' },
    { projection: { firstName: 1, lastName: 1, customerId: 1, referral: 1, passportVerification: 1, createdAt: 1 } }).sort({ 'referral.at': 1 }).limit(200).toArray();
  const steps = await ReferralReward.find({ kind: 'step', status: 'pending', approvedAt: { $exists: false } }).sort({ createdAt: 1 }).limit(200).lean();
  const ids = [...new Set([...flagged.map((f) => String(f.referral.by)), ...steps.map((s) => String(s.inviter))])];
  const people = new Map((await users().find({ _id: { $in: ids.map(oid) } }, { projection: { firstName: 1, lastName: 1, customerId: 1 } }).toArray())
    .map((u) => [String(u._id), u]));
  const who = (u) => (u ? { id: String(u._id), name: [u.firstName, u.lastName].filter(Boolean).join(' '), customerId: u.customerId } : null);
  const paid = await paidUsdOf(flagged.map((f) => f._id));
  const held = new Map();
  for (const r of await ReferralReward.find({ friend: { $in: flagged.map((f) => f._id) }, status: 'pending' }).select('friend points').lean()) {
    held.set(String(r.friend), (held.get(String(r.friend)) || 0) + r.points);
  }
  const friendCounts = new Map();
  for (const s of steps) {
    const key = String(s.inviter);
    if (!friendCounts.has(key)) {
      friendCounts.set(key, { qualified: await qualifiedCount(key), paidUsd: await activeFriendsPaid(key) });
    }
  }
  return {
    referrals: flagged.map((f) => ({
      friend: who(f), inviter: who(people.get(String(f.referral.by))), at: f.referral.at, flags: f.referral.flags || [],
      passport: f.passportVerification?.status || null, paidUsd: paid.get(String(f._id)) || 0, heldPoints: held.get(String(f._id)) || 0,
    })),
    steps: steps.map((s) => ({ id: String(s._id), inviter: who(people.get(String(s.inviter))), friends: s.step?.friends, usd: s.step?.usd,
      points: s.points, ambassador: !!s.step?.ambassador, at: s.createdAt, ...friendCounts.get(String(s.inviter)) })),
  };
}

// Staff approve a suspicious referral: its rewards go on as usual
async function approveReferral({ friendId, by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const res = await users().updateOne({ _id: oid(friendId), 'referral.review.status': 'pending' },
    { $set: { 'referral.review': { status: 'approved', at: now, ...(by && { by: oid(by) }) } } }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'لا توجد دعوة تنتظر المراجعة لهذا العميل');
  return { approved: true };
}

// Staff reject it: the referral is cancelled and every reward still waiting from it with it
async function rejectReferral({ friendId, reason, by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب رفض الدعوة');
  const res = await users().updateOne({ _id: oid(friendId), 'referral.review.status': 'pending' },
    { $set: { 'referral.review': { status: 'rejected', at: now, note: why, ...(by && { by: oid(by) }) } } }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'لا توجد دعوة تنتظر المراجعة لهذا العميل');
  await cancel({ friendId, reason: why, by, now }, session);
  await ReferralReward.updateMany({ friend: oid(friendId), status: 'pending' }, { $set: { status: 'canceled', canceledAt: now, cancelReason: why } }, { session });
  return { rejected: true };
}

// Staff approve a step reward (always reviewed: they are the big ones); the hourly job then gives it
async function approveStep({ rewardId, by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const res = await ReferralReward.updateOne({ _id: oid(rewardId), kind: 'step', status: 'pending', approvedAt: { $exists: false } },
    { $set: { approvedAt: now, ...(by && { approvedBy: oid(by) }) } }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'لا توجد مكافأة تنتظر الموافقة');
  return { approved: true };
}
// …or refuse it, for good (its key stays taken, so it is not offered again)
async function rejectStep({ rewardId, reason, by, now = new Date() } = {}, session) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب رفض المكافأة');
  const res = await ReferralReward.updateOne({ _id: oid(rewardId), kind: 'step', status: 'pending' },
    { $set: { status: 'canceled', canceledAt: now, cancelReason: why, ...(by && { approvedBy: oid(by) }) } }, { session });
  if (!res.modifiedCount) throw new ErrorHandler(400, 'لا توجد مكافأة تنتظر الموافقة');
  return { rejected: true };
}

// Referrals staff set by hand, by staff member: how many, and the latest ones
async function manualReport({ limit = 100 } = {}) {
  const rows = await users().find({ 'referral.source': 'staff' },
    { projection: { firstName: 1, lastName: 1, customerId: 1, referral: 1 } }).sort({ 'referral.at': -1 }).limit(2000).toArray();
  const staffIds = [...new Set(rows.map((r) => String(r.referral.setBy || '')).filter(Boolean))];
  const inviterIds = [...new Set(rows.map((r) => String(r.referral.by)))];
  const names = new Map((await users().find({ _id: { $in: [...staffIds, ...inviterIds].map(oid) } }, { projection: { firstName: 1, lastName: 1, customerId: 1 } }).toArray())
    .map((u) => [String(u._id), u]));
  const nameOf = (id) => { const u = names.get(String(id)); return u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '—'; };
  const byStaff = new Map();
  for (const r of rows) {
    const key = String(r.referral.setBy || '');
    const row = byStaff.get(key) || { staff: { id: key || null, name: key ? nameOf(key) : 'غير معروف' }, count: 0, inviters: new Set() };
    row.count += 1;
    row.inviters.add(String(r.referral.by));
    byStaff.set(key, row);
  }
  return {
    byStaff: [...byStaff.values()].map((r) => ({ staff: r.staff, count: r.count, inviters: r.inviters.size })).sort((a, b) => b.count - a.count),
    latest: rows.slice(0, limit).map((r) => ({
      friend: { id: String(r._id), name: [r.firstName, r.lastName].filter(Boolean).join(' '), customerId: r.customerId },
      inviter: { id: String(r.referral.by), name: nameOf(r.referral.by), customerId: names.get(String(r.referral.by))?.customerId },
      staff: r.referral.setBy ? nameOf(r.referral.setBy) : 'غير معروف', at: r.referral.at, canceled: !!r.referral.canceledAt,
    })),
  };
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

// Friends who reached $200, whose passport is verified and whose referral is not waiting for or refused by staff
const qualifiedCount = (inviterId, session) => users().countDocuments({
  'referral.by': oid(inviterId), 'referral.qualifiedAt': { $exists: true }, 'referral.canceledAt': { $exists: false },
  'passportVerification.status': 'verified', 'referral.review.status': { $nin: ['pending', 'rejected'] },
}, { session });

// The friend's orders that no longer count: cancelled, deleted or marked "no points"
async function deadOrders(orderIds, session) {
  if (!orderIds.length) return new Set();
  const dead = await Order.find({ _id: { $in: orderIds }, $or: [{ isCanceled: true }, { isDeleted: true }, { 'loyalty.noPoints': true }] })
    .setOptions({ withDeleted: true }).select('_id').session(session || null).lean();
  return new Set(dead.map((o) => String(o._id)));
}

// What some customers paid in total, in dollars, by user id: their earns that still stand as they were
// made (the order not cancelled, no payment cancelled and nothing changed since: earnStillValid)
async function paidUsdOf(userIds, session) {
  const result = new Map(userIds.map((id) => [String(id), 0]));
  if (!userIds.length) return result;
  const earns = await LoyaltyPoint.find({ user: { $in: userIds.map(oid) }, kind: 'earn' })
    .select('user basePoints points orderId').session(session || null).lean();
  const dead = await deadOrders([...new Set(earns.map((e) => String(e.orderId)).filter(Boolean))].map(oid), session);
  for (const e of earns) {
    if (dead.has(String(e.orderId)) || !await loyalty().earnStillValid(e._id, session)) continue;
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
  let waiting = 0;
  let failed = 0;
  for (const { _id } of due) {
    try {
      const out = await runInTransaction(async (session) => {
        const reward = await ReferralReward.findOne({ _id, status: 'pending' }).session(session).lean();
        if (!reward) return null;
        const problem = await holdProblem(reward, session);
        if (problem) { await cancelHeld(reward, problem, now, session); return { canceled: true }; }
        // Still standing, but waiting for the friend's passport to be verified or for staff: next run
        if (await waitReason(reward, session)) return { waiting: true };
        const lot = await loyalty().grantGift({ userId: reward.inviter, points: reward.points, reason: reward.reason, eventKey: reward.eventKey,
          ...(reward.levelPoints > 0 && { levelPoints: reward.levelPoints }), now }, session);
        await ReferralReward.updateOne({ _id: reward._id }, { $set: { status: 'granted', grantedAt: now, ...(lot && { lotId: lot._id }) } }, { session });
        if (reward.kind === 'step' && reward.step?.ambassador) {
          await users().updateOne({ _id: reward.inviter, 'referral.ambassadorAt': { $exists: false } }, { $set: { 'referral.ambassadorAt': now } }, { session });
        }
        const moved = reward.levelPoints > 0 ? await require('./levels').refreshLevel(reward.inviter, { now, session }) : null;
        const friend = reward.friend ? await users().findOne({ _id: reward.friend }, { projection: { firstName: 1, lastName: 1 }, session }) : null;
        return { reward, friendName: shortName(friend), movedTo: moved?.to || null, gift: moved?.gift || 0 };
      });
      if (!out) continue;
      if (out.canceled) { canceled += 1; continue; }
      if (out.waiting) { waiting += 1; continue; }
      granted += 1;
      const key = String(out.reward.inviter);
      const theirs = told.get(key) || { firsts: [], share: 0, steps: [], level: null, gift: 0 };
      if (out.reward.kind === 'first') theirs.firsts.push(out.friendName);
      if (out.reward.kind === 'share') theirs.share += out.reward.points;
      if (out.reward.kind === 'step') theirs.steps.push({ ...out.reward.step, points: out.reward.points });
      if (out.movedTo) theirs.level = out.movedTo;
      theirs.gift += out.gift || 0;
      told.set(key, theirs);
    } catch (error) {
      failed += 1;
      console.error(`[referrals] ${_id}: ${error.message}`);
    }
  }
  const customerPush = require('../../../utils/customerPush');
  for (const [inviterId, got] of told) await customerPush.referralRewards(inviterId, got);
  return { granted, canceled, waiting, failed };
}

// The hourly job: a reward given whose friend's order was cancelled (or deleted, or marked "no
// points") is taken back. A big reward is taken back only when the friend no longer reaches $200.
const validPaidUsd = async (friendId, session) => (await paidUsdOf([friendId], session)).get(String(friendId)) || 0;

// Given rewards are checked for a year and a little more: past that the share has ended anyway
const TAKE_BACK_DAYS = SHARE_DAYS + 35;
async function takeBackDue({ now = new Date() } = {}) {
  const { runInTransaction } = require('../transaction');
  const given = await ReferralReward.find({ status: 'granted', sourceOrder: { $exists: true }, grantedAt: { $gte: new Date(now.getTime() - TAKE_BACK_DAYS * DAY_MS) } })
    .select('_id sourceOrder sourceEarn').lean();
  const dead = await deadOrders([...new Set(given.map((r) => String(r.sourceOrder)))].map(oid));
  const givenFull = await ReferralReward.find({ _id: { $in: given.map((r) => r._id) } }).select('_id friend sourceOrder').lean();
  const orderOwner = new Map((await Order.find({ _id: { $in: givenFull.map((r) => r.sourceOrder) } }).select('user').lean()).map((o) => [String(o._id), String(o.user)]));
  const movedAway = new Set(givenFull.filter((r) => r.friend && orderOwner.has(String(r.sourceOrder)) && orderOwner.get(String(r.sourceOrder)) !== String(r.friend)).map((r) => String(r._id)));
  // Its order cancelled, or the friend's earn behind it no longer stands: a payment cancelled, the
  // invoice repriced or written off (owner, 2026-11-20: any change or cancellation takes it back)
  const due = [];
  for (const r of given) {
    if (dead.has(String(r.sourceOrder))) due.push({ _id: r._id, why: 'أُلغيت طلبية الصديق' });
    else if (movedAway.has(String(r._id))) due.push({ _id: r._id, why: 'نُقلت طلبية الصديق لعميل آخر' });
    else if (!await loyalty().earnStillValid(r.sourceEarn)) due.push({ _id: r._id, why: 'عُدّلت طلبية الصديق أو أُلغيت دفعتها' });
  }
  let revoked = 0;
  let failed = 0;
  for (const { _id, why } of due) {
    try {
      const done = await runInTransaction(async (session) => {
        const reward = await ReferralReward.findOne({ _id, status: 'granted' }).session(session).lean();
        if (!reward) return false;
        // A big reward stays while the friend still reaches $200 on what stands
        if (reward.kind === 'first' && await validPaidUsd(reward.friend, session) >= QUALIFY_USD) return false;
        if (reward.lotId) {
          await loyalty().takeBackLot(reward.lotId, 'revoke', session);
          // What the inviter had spent of it comes off the rest of their points (owner, 2026-11-21)
          await loyalty().clawBackSpent(reward.lotId, session);
        }
        await ReferralReward.updateOne({ _id: reward._id }, { $set: { status: 'revoked', canceledAt: new Date(), cancelReason: why } }, { session });
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

// A friend whose big reward did not stand (taken back, or cancelled while it waited) and who paid
// again: once what stands reaches $200 again, the big reward waits again (a new key, its 24 hours).
// A new earn does this by itself (afterEarn); paying an order again does not earn again, so this does.
async function requalifyDue({ now = new Date() } = {}) {
  const { runInTransaction } = require('../transaction');
  const friends = await users().find({ 'referral.by': { $exists: true }, 'referral.round': { $gte: 1 }, 'referral.qualifiedAt': { $exists: false },
    'referral.canceledAt': { $exists: false } }, { projection: { _id: 1 } }).toArray();
  let held = 0;
  for (const { _id } of friends) {
    try {
      const done = await runInTransaction(async (session) => {
        const friend = await users().findOne({ _id, 'referral.qualifiedAt': { $exists: false } }, { projection: { firstName: 1, lastName: 1, referral: 1 }, session });
        if (!friend || await loyalty().isOff(friend.referral.by, session)) return false;
        if (await validPaidUsd(friend._id, session) < QUALIFY_USD) return false;
        const earns = await LoyaltyPoint.find({ user: friend._id, kind: 'earn' }).sort({ earnedAt: -1, _id: -1 }).select('_id orderId').session(session).lean();
        let source = null;
        for (const e of earns) if (await loyalty().earnStillValid(e._id, session)) { source = e; break; }
        if (!source) return false;
        await users().updateOne({ _id: friend._id }, { $set: { 'referral.qualifiedAt': now } }, { session });
        return hold({ inviter: friend.referral.by, friend: friend._id, sourceEarn: source._id, sourceOrder: source.orderId, kind: 'first', points: FIRST_POINTS,
          reason: `مكافأة دعوة: ${shortName(friend)} دفع ${QUALIFY_USD}$`, eventKey: keys.first(friend._id, friend.referral.round) }, now, session);
      });
      if (done) held += 1;
    } catch (error) {
      console.error(`[referrals] requalify ${_id}: ${error.message}`);
    }
  }
  return { held };
}

// For the hourly loyalty jobs: take back, then qualify again, then release
async function runDue(options) {
  const back = await takeBackDue(options);
  await requalifyDue(options);
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
// ---- The inviter's record of every reward (owner, 2026-11-20) ----

const HISTORY_SIZE = 30;
// The reasons the system writes are shown to the customer; anything else is a staff note
const SHOWN_REASONS = ['نُقلت طلبية الصديق لعميل آخر', 'عُدّلت طلبية الصديق أو أُلغيت دفعتها', 'نقاط الداعي موقوفة', 'لم تعد شروط المكافأة متحققة', 'أُلغيت الدعوة', 'عُدّلت طلبية الصديق أو أُلغيت', 'أُلغيت طلبية الصديق', `لم يعد مجموع ما دفعه الصديق ${QUALIFY_USD}$`];
const STATUS_FILTER = { granted: ['granted'], pending: ['pending'], canceled: ['canceled', 'revoked'] };

// Where a reward stands, in the customer's words
async function rowState(r, friend, now) {
  if (r.status === 'granted') return { state: 'granted', note: null };
  // Given, then taken back: told apart from one cancelled before it was given
  if (r.status === 'revoked') return { state: 'canceled', revoked: true, note: r.cancelReason || 'أُلغيت طلبية الصديق' };
  if (r.status === 'canceled') return { state: 'canceled', note: SHOWN_REASONS.includes(r.cancelReason) ? r.cancelReason : 'ألغاها المكتب' };
  if (new Date(r.releaseAt) > now) return { state: 'pending', note: 'hold', releaseAt: r.releaseAt };
  if (r.kind === 'step') return { state: 'pending', note: r.approvedAt ? 'soon' : 'review' };
  if (friend?.referral?.review?.status === 'pending') return { state: 'pending', note: 'review' };
  if (friend?.passportVerification?.status !== 'verified') return { state: 'pending', note: 'passport' };
  return { state: 'pending', note: 'soon' };
}

// The inviter's rewards, newest first, all of them or one friend's, with each one's order, what the
// friend paid on it, and where it stands; and (for one friend) a summary of that friend
async function historyOf(inviterId, { friendId, status, page = 1, now = new Date() } = {}) {
  if (await loyalty().isOff(inviterId)) return { off: true };
  const filter = { inviter: oid(inviterId) };
  let friendDoc = null;
  if (friendId) {
    if (!mongoose.isValidObjectId(friendId)) throw new ErrorHandler(400, 'حدد الصديق');
    friendDoc = await users().findOne({ _id: oid(friendId), 'referral.by': oid(inviterId) },
      { projection: { firstName: 1, lastName: 1, referral: 1, createdAt: 1, 'passportVerification.status': 1 } });
    if (!friendDoc) throw new ErrorHandler(404, 'هذا الصديق ليس من دعوتك');
    filter.friend = friendDoc._id;
  }
  const all = await ReferralReward.find(filter).sort({ createdAt: -1, _id: -1 }).lean();
  const friendIds = [...new Set(all.map((r) => String(r.friend || '')).filter(Boolean))];
  const friends = new Map((await users().find({ _id: { $in: friendIds.map(oid) } },
    { projection: { firstName: 1, lastName: 1, referral: 1, 'passportVerification.status': 1 } }).toArray()).map((f) => [String(f._id), f]));
  const rows = [];
  for (const r of all) rows.push({ r, ...(await rowState(r, friends.get(String(r.friend)), now)) });
  const totals = { granted: 0, pending: 0, canceled: 0 };
  for (const row of rows) totals[row.state] += row.r.points;
  const shown = status && STATUS_FILTER[status] ? rows.filter((row) => row.state === (status === 'canceled' ? 'canceled' : status)) : rows;
  const pages = Math.max(Math.ceil(shown.length / HISTORY_SIZE), 1);
  const at = Math.min(Math.max(Number(page) || 1, 1), pages);
  const slice = shown.slice((at - 1) * HISTORY_SIZE, at * HISTORY_SIZE);
  const orders = new Map((await Order.find({ _id: { $in: slice.map((s) => s.r.sourceOrder).filter(Boolean) } }).setOptions({ withDeleted: true })
    .select('orderId').lean()).map((o) => [String(o._id), o.orderId]));
  const items = slice.map(({ r, state, note, releaseAt, revoked }) => ({
    id: String(r._id),
    kind: r.kind,
    points: r.points,
    countsForLevel: r.levelPoints > 0,
    state,
    revoked: !!revoked,
    note,
    releaseAt: releaseAt || null,
    at: r.createdAt,
    grantedAt: r.grantedAt || null,
    canceledAt: r.canceledAt || null,
    friend: r.friend ? { id: String(r.friend), name: fullName(friends.get(String(r.friend))) } : null,
    orderNumber: r.sourceOrder ? orders.get(String(r.sourceOrder)) || null : null,
    step: r.kind === 'step' ? { friends: r.step?.friends, usd: r.step?.usd, title: r.step?.title || null } : null,
  }));
  let friend = null;
  if (friendDoc) {
    const ref = friendDoc.referral;
    friend = {
      id: String(friendDoc._id),
      name: fullName(friendDoc),
      joinedAt: ref.at || friendDoc.createdAt,
      status: friendStatus(ref, now),
      // What the friend brought the inviter (given), never what the friend paid: that is the friend's own business
      points: totals.granted,
      qualifiedAt: ref.qualifiedAt || null,
      shareEndsAt: shareEndsAt(ref.qualifiedAt),
      // Orders that brought something that stands (given or waiting), not what was cancelled or taken back
      orders: new Set(rows.filter((row) => row.state !== 'canceled').map((row) => String(row.r.sourceOrder || '')).filter(Boolean)).size,
      waiting: ref.review?.status === 'pending' ? 'review' : friendDoc.passportVerification?.status !== 'verified' ? 'passport' : null,
    };
  }
  return { off: false, items, page: at, pages, total: shown.length, totals, friend, holdHours: HOLD_HOURS, qualifyUsd: QUALIFY_USD };
}

async function mine(userId, { now = new Date() } = {}) {
  if (await loyalty().isOff(userId)) return { off: true };
  const code = await codeOf(userId);
  const ambassadorAt = (await users().findOne({ _id: oid(userId) }, { projection: { 'referral.ambassadorAt': 1 } }))?.referral?.ambassadorAt;
  const friends = await users().find({ 'referral.by': oid(userId) },
    { projection: { firstName: 1, lastName: 1, referral: 1, createdAt: 1, 'passportVerification.status': 1 } }).sort({ 'referral.at': -1 }).limit(200).toArray();
  const { given: points, held } = await pointsByFriend(userId, friends.map((f) => f._id));
  const paid = await paidUsdOf(friends.map((f) => f._id));
  const friendsPaidUsd = friends.filter((f) => !f.referral.canceledAt).reduce((sum, f) => sum + (paid.get(String(f._id)) || 0), 0);
  const steps = await ReferralReward.find({ inviter: oid(userId), kind: 'step', status: 'granted' }).select('points').lean();
  const heldTotal = (await ReferralReward.find({ inviter: oid(userId), status: 'pending' }).select('points').lean()).reduce((sum, r) => sum + r.points, 0);
  const qualified = friends.filter((f) => f.referral.qualifiedAt && !f.referral.canceledAt).length;
  const rows = friends.map((f) => ({
    id: String(f._id),
    name: fullName(f),
    joinedAt: f.referral.at || f.createdAt,
    status: friendStatus(f.referral, now),
    qualifiedAt: f.referral.qualifiedAt || null,
    shareEndsAt: shareEndsAt(f.referral.qualifiedAt),
    points: points.get(String(f._id)) || 0,
    heldPoints: held.get(String(f._id)) || 0,
    // Why this friend's rewards wait beyond the 24 hours: their passport, or the office's review
    waiting: f.referral.review?.status === 'pending' ? 'review' : f.passportVerification?.status !== 'verified' ? 'passport' : null,
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
    // What all friends paid together, shown only from the first step's number of friends: with one or two
    // friends the total would tell what each of them paid
    friendsPaidUsd: qualified >= STEPS[0].friends ? friendsPaidUsd : null,
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
    flags: ref.flags || [],
    review: ref.review ? { status: ref.review.status, at: ref.review.at || null, note: ref.review.note || null } : null,
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
  SIGNUP_POINTS, keys, normalizeCode, shortName, codeOf, check, attach, signupGift, cancel, afterEarn, releaseDue, takeBackDue, requalifyDue, runDue, mine, historyOf, staffInfo,
  suspicionFlags, reviewQueue, approveReferral, rejectReferral, approveStep, rejectStep, manualReport,
};
