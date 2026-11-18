// Loyalty levels (owner's request 2026-11-17): what a customer's level is, reaching the next one,
// the yearly review, staff setting a level by hand and the staff report. Everyone
// starts at the first level: only orders from LOYALTY_START_DATE on count. The rules live in ./tiers.js.
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const ErrorHandler = require('../../../utils/errorHandler');
const { runInTransaction, assertInTransaction } = require('../transaction');
const { lockWalletOwner } = require('../../../utils/walletLock');
const { TZ } = require('../dates');
const tiers = require('./tiers');

const DAY_MS = 24 * 60 * 60 * 1000;
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const users = () => mongoose.connection.collection('users');
const HISTORY_KEEP = 50;

// ---- Level points ----

// The level points of some customers at `now`, by user id: the points each EARNED in the last 365
// days before any multiplier (an earn lot later taken back with its cancelled order does not
// count).
async function levelPointsOf(userIds, { now = new Date(), session } = {}) {
  const ids = [...new Set(userIds.map(String))].filter((id) => mongoose.isValidObjectId(id)).map(oid);
  const result = new Map(ids.map((id) => [String(id), 0]));
  if (!ids.length) return result;
  const since = new Date(now.getTime() - tiers.WINDOW_DAYS * DAY_MS);
  const lots = await LoyaltyPoint.find({ user: { $in: ids }, kind: 'earn', earnedAt: { $gt: since, $lte: now } })
    .select('_id user points basePoints').session(session || null).lean();
  const revoked = new Set((await LoyaltyPoint.find({ kind: 'revoke', 'sources.lotId': { $in: lots.map((lot) => lot._id) } })
    .select('sources.lotId').session(session || null).lean()).flatMap((m) => (m.sources || []).map((s) => String(s.lotId))));
  for (const lot of lots) {
    if (revoked.has(String(lot._id))) continue;
    const key = String(lot.user);
    result.set(key, result.get(key) + (Number.isFinite(lot.basePoints) ? lot.basePoints : lot.points));
  }
  return result;
}

const levelPoints = async (userId, options) => (await levelPointsOf([userId], options)).get(String(userId)) || 0;

const historyRow = (from, to, why, extra = {}) => ({ from: from || tiers.TIERS[0].key, to, at: extra.at || new Date(), why, ...extra });

// Saves a new level (and its history row) for one customer
async function saveLevel(userId, { level, now, why, reason, by, keepSince = false }, current, session) {
  const set = {
    'loyaltyTier.level': level,
    'loyaltyTier.reviewAt': new Date(now.getTime() + tiers.REVIEW_DAYS * DAY_MS),
    ...(keepSince ? {} : { 'loyaltyTier.since': now }),
    ...(why === 'manual' ? { 'loyaltyTier.manual': { reason, by, at: now } } : {}),
  };
  const row = historyRow(current, level, why, { at: now, ...(reason && { reason }), ...(by && { by }) });
  await users().updateOne({ _id: oid(userId) }, { $set: set, $push: { 'loyaltyTier.history': { $each: [row], $slice: -HISTORY_KEEP } } }, { session });
}

// The gift of a level, given once ever per customer and level
const giftKey = (userId, level) => `LOYALTY_TIER_GIFT:${userId}:${level}`;
async function giveUpgradeGift(userId, level, now, session) {
  const tier = tiers.tierOf(level);
  if (!(tier.upgradeGift > 0)) return null;
  return require('./index').grantGift({ userId, points: tier.upgradeGift, reason: `هدية الترقية إلى مستوى ${tier.name}`, eventKey: giftKey(userId, level), now }, session);
}

// ---- Reaching the next level (right after an earn, in its transaction) ----

// Moves the customer up when their level points reach a higher level: the new level from now for a
// year, and its gift (once ever). Never moves anyone down. Returns { from, to } or null.
async function refreshLevel(userId, { now = new Date(), session } = {}) {
  assertInTransaction(session);
  const user = await users().findOne({ _id: oid(userId) }, { projection: { 'loyaltyTier.level': 1 }, session });
  if (!user) return null;
  const current = user.loyaltyTier?.level || tiers.TIERS[0].key;
  const reached = tiers.qualifyingTier(await levelPoints(userId, { now, session }));
  if (reached.rank <= tiers.rankOf(current)) return null;
  await saveLevel(userId, { level: reached.key, now, why: 'upgrade' }, current, session);
  // The gift of every level passed on the way (a big order can pass two), each once ever
  for (let rank = tiers.rankOf(current) + 1; rank <= reached.rank; rank += 1) await giveUpgradeGift(userId, tiers.TIERS[rank].key, now, session);
  return { from: current, to: reached.key };
}

// ---- What a customer sees of their level ----

// { level, name, rank, color, multiplier, expiryMonths, perks, since, reviewAt, points (level
// points), next: { key, name, min, remaining } | null, keep: { min, remaining } | null (the points
// that keep the level at the yearly review), review: { at, keeps, needed } | null,
// celebrate: the level to celebrate in the app (reached and not seen yet) | null, manual, history }
async function levelOf(userId, { now = new Date(), withHistory = false } = {}) {
  const user = await users().findOne({ _id: oid(userId) }, { projection: { loyaltyTier: 1 } });
  const saved = user?.loyaltyTier || {};
  const tier = tiers.tierOf(saved.level);
  const points = await levelPoints(userId, { now });
  const next = tiers.nextTier(tier.key);
  const keepMin = tiers.keepMin(tier.key);
  const reviewAt = saved.reviewAt ? new Date(saved.reviewAt) : null;
  const warnFrom = reviewAt ? reviewAt.getTime() - tiers.WARN_DAYS * DAY_MS : Infinity;
  const pub = tiers.publicTiers()[tier.rank];
  return {
    level: tier.key,
    name: tier.name,
    nameEn: tier.nameEn,
    rank: tier.rank,
    color: tier.color,
    multiplier: pub.multiplier,
    expiryMonths: pub.expiryMonths,
    perks: tier.perks,
    since: saved.since || null,
    reviewAt,
    points,
    next: next ? { key: next.key, name: next.name, min: next.min, remaining: Math.max(next.min - points, 0) } : null,
    keep: tier.rank > 0 ? { min: keepMin, remaining: Math.max(keepMin - points, 0) } : null,
    // Within 30 days of the review: whether the level is kept (70% of its points), and what is missing
    review: tier.rank > 0 && reviewAt && now.getTime() >= warnFrom
      ? { at: reviewAt, keeps: points >= keepMin, needed: Math.max(keepMin - points, 0) }
      : null,
    celebrate: tier.rank > 0 && saved.seen !== tier.key ? tier.key : null,
    manual: saved.manual?.at ? { reason: saved.manual.reason || '', at: saved.manual.at, by: saved.manual.by ? String(saved.manual.by) : null } : null,
    ...(withHistory && { history: (saved.history || []).slice().reverse() }),
  };
}

// The app showed the celebration of the customer's level
async function markSeen(userId) {
  const user = await users().findOne({ _id: oid(userId) }, { projection: { 'loyaltyTier.level': 1 } });
  const level = user?.loyaltyTier?.level;
  if (level) await users().updateOne({ _id: oid(userId) }, { $set: { 'loyaltyTier.seen': level } });
  return { seen: level || null };
}

// ---- Staff: setting a level by hand ----

// With a required reason: the level from now for a year (the review may lower it later like any
// other). No upgrade gift: gifts come with levels reached by earning.
async function setLevel({ userId, level, reason } = {}, { session, req } = {}) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب تغيير المستوى');
  if (!tiers.TIERS.some((tier) => tier.key === level)) throw new ErrorHandler(400, 'المستوى غير معروف');
  if (!mongoose.isValidObjectId(userId)) throw new ErrorHandler(400, 'حدد العميل');
  const user = await users().findOne({ _id: oid(userId) }, { projection: { 'loyaltyTier.level': 1 }, session });
  if (!user) throw new ErrorHandler(404, 'العميل غير موجود');
  await lockWalletOwner(user._id, session);
  const current = user.loyaltyTier?.level || tiers.TIERS[0].key;
  if (current === level) throw new ErrorHandler(400, 'العميل في هذا المستوى أصلاً');
  await saveLevel(userId, { level, now: new Date(), why: 'manual', reason: why, by: req?.user?._id }, current, session);
  return { from: current, to: level };
}

// ---- The hourly job: yearly reviews ----

// Each level whose review is due: kept for another year when its level points reach 70% of it, else
// down to what they reach but never more than one level. One transaction per customer.
async function reviewDue({ now = new Date() } = {}) {
  let kept = 0;
  let lowered = 0;
  let failed = 0;
  const due = await users().find({ 'loyaltyTier.reviewAt': { $lte: now }, 'loyaltyTier.level': { $exists: true, $ne: tiers.TIERS[0].key } },
    { projection: { _id: 1 } }).toArray();
  for (const { _id } of due) {
    try {
      const result = await runInTransaction(async (session) => {
        const user = await users().findOne({ _id }, { projection: { loyaltyTier: 1 }, session });
        const current = user?.loyaltyTier?.level;
        if (!current || !(new Date(user.loyaltyTier.reviewAt) <= now)) return null;
        const points = await levelPoints(_id, { now, session });
        const reached = tiers.qualifyingTier(points);
        const rank = tiers.rankOf(current);
        if (points >= tiers.keepMin(current) || reached.rank >= rank) {
          await users().updateOne({ _id }, { $set: { 'loyaltyTier.reviewAt': new Date(now.getTime() + tiers.REVIEW_DAYS * DAY_MS) } }, { session });
          return 'kept';
        }
        const level = tiers.TIERS[Math.max(reached.rank, rank - 1)].key;
        await saveLevel(_id, { level, now, why: 'review', keepSince: false }, current, session);
        await users().updateOne({ _id }, { $set: { 'loyaltyTier.seen': level } }, { session });
        return 'lowered';
      });
      if (result === 'kept') kept += 1;
      if (result === 'lowered') lowered += 1;
    } catch (error) {
      failed += 1;
      console.error(`[loyalty] level review ${_id}: ${error.message}`);
    }
  }
  return { kept, lowered, failed };
}

// ---- Staff report ----

// Customers in each level, who moved up this month (Libya time), whose level drops at a review due
// within 30 days, and who are close to the next level (what is left at most 20% of the gap)
async function report({ now = new Date(), limit = 20 } = {}) {
  const counts = new Map((await users().aggregate([
    { $match: { 'roles.isClient': true } },
    { $group: { _id: { $ifNull: ['$loyaltyTier.level', tiers.TIERS[0].key] }, count: { $sum: 1 } } },
  ]).toArray()).map((row) => [row._id, row.count]));
  const monthStart = moment(now).tz(TZ).startOf('month').toDate();
  const warnUntil = new Date(now.getTime() + tiers.WARN_DAYS * DAY_MS);
  const [upgraded, reviewing, earners] = await Promise.all([
    users().find({ 'loyaltyTier.history': { $elemMatch: { at: { $gte: monthStart }, why: { $in: ['upgrade', 'manual'] } } } },
      { projection: { firstName: 1, lastName: 1, customerId: 1, loyaltyTier: 1 } }).limit(200).toArray(),
    users().find({ 'loyaltyTier.reviewAt': { $lte: warnUntil }, 'loyaltyTier.level': { $exists: true, $ne: tiers.TIERS[0].key }, 'loyaltyOff.at': { $exists: false } },
      { projection: { firstName: 1, lastName: 1, customerId: 1, phone: 1, loyaltyTier: 1 } }).limit(500).toArray(),
    LoyaltyPoint.distinct('user', { kind: 'earn', earnedAt: { $gt: new Date(now.getTime() - tiers.WINDOW_DAYS * DAY_MS) } }),
  ]);
  const name = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ');
  const levelPointsMap = await levelPointsOf([...reviewing.map((u) => u._id), ...earners], { now });
  const atRisk = reviewing
    .map((u) => {
      const tier = tiers.tierOf(u.loyaltyTier.level);
      const points = levelPointsMap.get(String(u._id)) || 0;
      return { userId: String(u._id), name: name(u), customerId: u.customerId, phone: u.phone ?? null, level: tier.key, points, needed: Math.max(tiers.keepMin(tier.key) - points, 0), reviewAt: u.loyaltyTier.reviewAt };
    })
    .filter((row) => row.needed > 0)
    .sort((a, b) => new Date(a.reviewAt) - new Date(b.reviewAt))
    .slice(0, limit);
  const earnerUsers = new Map((await users().find({ _id: { $in: earners }, 'loyaltyOff.at': { $exists: false } },
    { projection: { firstName: 1, lastName: 1, customerId: 1, phone: 1, 'loyaltyTier.level': 1 } }).toArray()).map((u) => [String(u._id), u]));
  const near = earners
    .map((id) => {
      const u = earnerUsers.get(String(id));
      if (!u) return null;
      const tier = tiers.tierOf(u.loyaltyTier?.level);
      const next = tiers.nextTier(tier.key);
      if (!next) return null;
      const points = levelPointsMap.get(String(id)) || 0;
      const remaining = next.min - points;
      if (remaining <= 0 || remaining > (next.min - tier.min) * tiers.NEAR_SHARE) return null;
      return { userId: String(id), name: name(u), customerId: u.customerId, phone: u.phone ?? null, level: tier.key, next: next.key, points, remaining };
    })
    .filter(Boolean)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, limit);
  const upgradedRows = upgraded.flatMap((u) => (u.loyaltyTier.history || [])
    .filter((h) => new Date(h.at) >= monthStart && ['upgrade', 'manual'].includes(h.why) && tiers.rankOf(h.to) > tiers.rankOf(h.from))
    .map((h) => ({ userId: String(u._id), name: name(u), customerId: u.customerId, from: h.from, to: h.to, at: h.at, why: h.why })))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
  return {
    tiers: tiers.publicTiers().map((tier) => ({ ...tier, customers: counts.get(tier.key) || 0 })),
    upgraded: upgradedRows,
    atRisk,
    near,
  };
}

module.exports = { levelPointsOf, levelPoints, refreshLevel, levelOf, markSeen, setLevel, reviewDue, report };
