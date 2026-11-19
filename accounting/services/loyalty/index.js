// Loyalty points: earning on paid claims, balance and points on the way (spec 2026-11-16).
// A claim earns once: a shipping claim `SHP:<order>:<package>` or a purchase claim `PUR:<order>`
// (never the package's transport or customs fees), on an order neither cancelled nor marked
// "no points", once it is fully paid and (for shipping) its package delivered. It earns on what was
// billed less what was written off and what was paid with points, and a later reprice never earns
// again. Only orders placed on or after LOYALTY_START_DATE take part.
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Order = require('../../../models/order');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const PricingConfig = require('../../../models/pricingConfig');
const { JournalEntry } = require('../../models');
const { postEntry, reverseEntry } = require('../ledger');
const { getConfig } = require('../config');
const { TZ } = require('../dates');
const { runInTransaction, assertInTransaction } = require('../transaction');
const ErrorHandler = require('../../../utils/errorHandler');
const { lockWalletOwner } = require('../../../utils/walletLock');
const { lockClaimAllocations } = require('../claims/locks');
const { syncOrder } = require('../claims/sync');
const { openBalances, resolveClaimKeys, splitOverClaims, claimLines } = require('../posting/operations');
const { resolveAccount } = require('../roles');
const { purchaseKey, shipmentKey, parseKey, CLAIM_EVENTS } = require('../claims/keys');
const { earnPoints, redeemCap, takeOldest, EXPIRY_DAYS, SOON_DAYS } = require('./rules');
const tiers = require('./tiers');
const promotions = require('./promotions');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOTS = ['earn', 'add', 'restore'];
const earnKey = (arKey) => `LOYALTY_EARN:${arKey}`;
const oid = (value) => new mongoose.Types.ObjectId(String(value));
// shipment and package method: which points offer a claim gets (promotions.js)
const ORDER_FIELDS = 'orderId user placedAt createdAt isRemittance isCanceled loyalty paymentList._id paymentList.status.received shipment.method shipment.fromWhere paymentList.deliveredPackages.shipmentMethod';
const WRITEOFF_EVENTS = ['CLAIM_WRITEOFF', 'WRITEOFF_RECOVERY'];

// Orders placed from this day earn points (env LOYALTY_START_DATE, an ISO date). Unset or invalid:
// nothing earns and nothing is pending, so turning the program on never awards the paid history.
function loyaltyStartDate() {
  const raw = String(process.env.LOYALTY_START_DATE || '').trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Per claim key: billed (net receivable from claim entries), still owed, and written off (a
// write-off less what a later payment took back, posted and not reversed, as claims/sync.js counts it)
async function claimLedger(arKeyFilter, session) {
  const receivable = await resolveAccount('customer_receivable');
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.arKey': arKeyFilter } },
    { $unwind: '$lines' },
    { $match: { 'lines.arKey': arKeyFilter, 'lines.accountId': receivable._id } },
    { $group: {
      _id: '$lines.arKey',
      open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
      billed: { $sum: { $cond: [{ $in: ['$eventType', CLAIM_EVENTS] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
      writtenOff: { $sum: { $cond: [{ $and: [{ $in: ['$eventType', WRITEOFF_EVENTS] }, { $ne: ['$status', 'reversed'] }] }, { $subtract: ['$lines.credit', '$lines.debit'] }, 0] } },
    } },
  ]).session(session || null);
  return new Map(rows.map((row) => [row._id, { billed: row.billed, open: row.open, writtenOff: row.writtenOff }]));
}

// Points paid on each claim (used, less what came back on a cancellation)
async function redeemedOn(arKeys, session) {
  if (!arKeys.length) return new Map();
  const rows = await LoyaltyPoint.aggregate([
    { $match: { arKey: { $in: arKeys }, kind: { $in: ['redeem', 'restore'] } } },
    { $group: { _id: '$arKey', points: { $sum: { $cond: [{ $eq: ['$kind', 'redeem'] }, '$points', { $multiply: ['$points', -1] }] } } } },
  ]).session(session || null);
  return new Map(rows.map((row) => [row._id, Math.max(row.points, 0)]));
}

// The loyalty level of each customer (no level saved: the first level), by user id
async function levelsOf(userIds, session) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return new Map();
  const users = await mongoose.connection.collection('users')
    .find({ _id: { $in: ids.map(oid) } }, { projection: { 'loyaltyTier.level': 1 }, session }).toArray();
  return new Map(users.map((u) => [String(u._id), u.loyaltyTier?.level || tiers.TIERS[0].key]));
}

// Points switched off for a customer (owner, 2026-11-18: partners on a special price, for whom the
// points would be a loss). While off: nothing earns (an order that becomes due is marked "no points"
// with OFF_REASON, so switching back on never earns for it), nothing is redeemed, and the client app
// hides the points. The balance stays as it was (and still expires) and returns when switched on.
const OFF_REASON = 'نقاط العميل موقوفة';
async function isOff(userId, session) {
  if (!userId || !mongoose.isValidObjectId(String(userId))) return false;
  const user = await mongoose.connection.collection('users').findOne({ _id: oid(userId) }, { projection: { 'loyaltyOff.at': 1 }, session });
  return !!user?.loyaltyOff?.at;
}

// Staff switch a customer's points off (a reason is required) or back on
async function setOff({ userId, off, reason } = {}, { session, req } = {}) {
  assertInTransaction(session);
  if (!mongoose.isValidObjectId(userId)) throw new ErrorHandler(400, 'حدد العميل');
  const why = String(reason || '').trim();
  if (off && !why) throw new ErrorHandler(400, 'اكتب سبب إيقاف النقاط');
  const users = mongoose.connection.collection('users');
  const user = await users.findOne({ _id: oid(userId) }, { projection: { _id: 1 }, session });
  if (!user) throw new ErrorHandler(404, 'العميل غير موجود');
  await lockWalletOwner(user._id, session);
  if (off) await users.updateOne({ _id: user._id }, { $set: { loyaltyOff: { at: new Date(), by: req?.user?._id || null, reason: why } } }, { session });
  else await users.updateOne({ _id: user._id }, { $unset: { loyaltyOff: 1 } }, { session });
  return { off: !!off };
}

const isEligibleOrder = (order, start = loyaltyStartDate()) => !!order && start instanceof Date && !order.isCanceled && !order.loyalty?.noPoints
  && !!order.createdAt && new Date(order.createdAt) >= start;

// Where a claim stands: null (earns nothing), 'earned', or { points, waitingFor } where
// waitingFor is 'payment' (still owed), 'delivery' (paid, package not delivered) or 'processing'
// (paid and delivered: the next hourly run adds it)
function claimState({ arKey, order, ledger, redeemed, earned }) {
  const parsed = parseKey(arKey);
  if (!['purchase', 'shipment'].includes(parsed.kind) || parsed.domesticFee || parsed.customsFee) return null;
  if (!isEligibleOrder(order)) return null;
  const billed = ledger?.billed || 0;
  if (billed <= 0) return null;
  if (earned) return 'earned';
  const base = billed - Math.max(ledger.writtenOff || 0, 0) - (redeemed || 0);
  const points = earnPoints(base, parsed.kind === 'purchase' && !!order.isRemittance);
  if (points <= 0) return null;
  if ((ledger.open || 0) > 0) return { points, waitingFor: 'payment' };
  if (parsed.kind === 'shipment') {
    const pkg = (order.paymentList || []).find((p) => String(p._id) === parsed.packageId);
    if (!pkg) return null;
    if (!pkg.status?.received) return { points, waitingFor: 'delivery' };
  }
  return { points, waitingFor: 'processing' };
}

const orderKeys = (order) => [purchaseKey(order._id), ...(order.paymentList || []).map((p) => shipmentKey(order._id, p._id))];

// Points on the way for some orders (one row per claim not yet earned)
async function pendingOf(orders, session) {
  const eligible = orders.filter((order) => isEligibleOrder(order));
  const keys = eligible.flatMap(orderKeys);
  if (!keys.length) return [];
  const [ledger, redeemed, earned] = await Promise.all([
    claimLedger({ $in: keys }, session),
    redeemedOn(keys, session),
    LoyaltyPoint.distinct('arKey', { kind: 'earn', arKey: { $in: keys } }).session(session || null),
  ]);
  const earnedSet = new Set(earned);
  // Shown with the customer's level today (what they would earn if it were paid now), or the
  // points offer the order was created in when that is higher
  const levels = await levelsOf(eligible.map((order) => order.user), session);
  const offers = await promotions.promotionsAround(eligible.map((order) => order.createdAt), session);
  const rows = [];
  for (const order of eligible) {
    for (const arKey of orderKeys(order)) {
      const state = claimState({ arKey, order, ledger: ledger.get(arKey), redeemed: redeemed.get(arKey), earned: earnedSet.has(arKey) });
      if (!state || state === 'earned') continue;
      const { points, promotion } = promotions.pointsWith(state.points, levels.get(String(order.user)), arKey, order, offers);
      rows.push({ orderId: order._id, orderNumber: order.orderId, arKey, points, waitingFor: state.waitingFor, ...(promotion && { promotion }) });
    }
  }
  return rows;
}

async function officeOf(order) {
  const { settings, offices } = await getConfig();
  return offices.has(order?.placedAt) ? order.placedAt : settings?.defaultOffice;
}

// Dr loyalty_expense (office of the order) / Cr loyalty_points (the customer)
async function postEarnEntry(movement, orderNumber, session) {
  const entry = await postEntry({
    eventType: 'LOYALTY_EARN',
    eventKey: movement.eventKey,
    description: `نقاط ولاء مكتسبة (${movement.points} نقطة) - طلب ${orderNumber || movement.orderId}`,
    source: { model: 'LoyaltyPoint', id: movement._id },
    lines: [
      { role: 'loyalty_expense', debit: movement.points, office: movement.office, orderId: movement.orderId },
      { role: 'loyalty_points', credit: movement.points, partnerId: movement.user, orderId: movement.orderId },
    ],
  }, { session });
  await LoyaltyPoint.updateOne({ _id: movement._id }, { $set: { journalEntryId: entry._id } }, { session });
  return entry;
}

// The hourly job. Each claim that became due earns in its own transaction (with its entry when
// accounting is live); a claim that fails is logged and skipped, and the others go on. Then the
// entries of points recorded while accounting was not live are posted, one transaction each.
async function awardDue({ now = new Date() } = {}) {
  let awarded = 0;
  let failed = 0;
  // What each customer earned in this run, told on their phone once the run is done
  const earnedBy = new Map(); // userId -> { points, level }
  const start = loyaltyStartDate();
  if (start) {
    const ledger = await claimLedger({ $in: [/^PUR:/, /^SHP:/] });
    const earned = new Set(await LoyaltyPoint.distinct('arKey', { kind: 'earn' }));
    const candidates = [...ledger].filter(([arKey, row]) => row.billed > 0 && row.open <= 0 && !earned.has(arKey)).map(([arKey]) => arKey);
    const orderIds = [...new Set(candidates.map((key) => parseKey(key).orderId).filter((id) => mongoose.isValidObjectId(id)))];
    const eligible = new Set((await Order.find({ _id: { $in: orderIds }, createdAt: { $gte: start } }).select('_id').lean()).map((o) => String(o._id)));
    for (const arKey of candidates.filter((key) => eligible.has(parseKey(key).orderId))) {
      try {
        const earned = await runInTransaction((session) => earnClaim(arKey, now, session));
        if (earned) {
          awarded += 1;
          const mine = earnedBy.get(earned.userId) || { points: 0, level: null };
          mine.points += earned.points;
          if (earned.movedTo) mine.level = earned.movedTo;
          earnedBy.set(earned.userId, mine);
        }
      } catch (error) {
        failed += 1;
        console.error(`[loyalty] ${arKey}: ${error.message}`);
      }
    }
  }
  // After every earn has committed: one notification per customer for the points, and one for a
  // new level reached on the way
  const customerPush = require('../../../utils/customerPush');
  for (const [userId, { points, level }] of earnedBy) {
    await customerPush.pointsEarned(userId, points);
    if (level) await customerPush.levelUp(userId, level);
  }
  const { settings } = await getConfig();
  if (settings?.liveEnabled) {
    // Movements recorded while accounting was not live, oldest first (an earn before the expiry or
    // take-back of its lot), each posted with the same builder as the live path
    const unposted = await LoyaltyPoint.find({ kind: { $in: POSTED_KINDS }, journalEntryId: { $exists: false } })
      .select('_id arKey eventKey').sort({ createdAt: 1, _id: 1 }).lean();
    for (const { _id, arKey, eventKey } of unposted) {
      try {
        await runInTransaction(async (session) => {
          const movement = await LoyaltyPoint.findOne({ _id, journalEntryId: { $exists: false } }).session(session).lean();
          if (movement) await postMovementEntry(movement, session);
        });
      } catch (error) {
        failed += 1;
        console.error(`[loyalty] ${arKey || eventKey}: ${error.message}`);
      }
    }
  }
  return { awarded, failed };
}

async function orderNumberOf(orderId, session) {
  return orderId ? (await Order.findById(orderId).setOptions({ withDeleted: true }).select('orderId').session(session).lean())?.orderId : undefined;
}

// The movements that carry an entry, and the builder of each (the live path and the backlog
// poster use the same ones). A redeem is always posted when made (it needs live accounting).
const POSTED_KINDS = ['earn', 'expire', 'revoke', 'restore', 'add', 'deduct'];
async function postMovementEntry(movement, session) {
  if (movement.kind === 'earn') return postEarnEntry(movement, await orderNumberOf(movement.orderId, session), session);
  if (movement.kind === 'expire' || movement.kind === 'revoke') return postTakeBackEntry(movement, session);
  if (movement.kind === 'restore') return postRestoreEntry(movement, session);
  if (movement.kind === 'add' || movement.kind === 'deduct') return postAdjustEntry(movement, session);
  return null;
}

// Earns one claim if it is still due, read again inside the transaction. When it earned:
// { userId, points, movedTo } (movedTo: the new level when the customer moved up), else false.
async function earnClaim(arKey, now, session) {
  const eventKey = earnKey(arKey);
  if (await LoyaltyPoint.exists({ eventKey }).session(session)) return false;
  const order = await Order.findById(parseKey(arKey).orderId).select(ORDER_FIELDS).session(session).lean();
  const ledger = (await claimLedger({ $in: [arKey] }, session)).get(arKey);
  const redeemed = (await redeemedOn([arKey], session)).get(arKey);
  const state = claimState({ arKey, order, ledger, redeemed, earned: false });
  if (!state || state === 'earned' || state.waitingFor !== 'processing') return false;
  if (await isOff(order.user, session)) {
    await Order.updateOne({ _id: order._id, 'loyalty.noPoints': { $ne: true } }, { $set: { loyalty: { noPoints: true, reason: OFF_REASON, at: now } } }, { session });
    return false;
  }
  // The customer's level multiplies the points and sets how long they last; the level counts the
  // points before the multiplier (basePoints)
  const level = (await levelsOf([order.user], session)).get(String(order.user));
  const tier = tiers.tierOf(level);
  // A points offer the order was created in multiplies instead, when it is higher (spec 2026-11-19)
  const offers = await promotions.promotionsAround([order.createdAt], session);
  const { points, promotion } = promotions.pointsWith(state.points, level, arKey, order, offers);
  const [movement] = await LoyaltyPoint.create([{
    user: order.user, kind: 'earn', points, remaining: points, basePoints: state.points, tier: tier.key, ...(promotion && { promotion }), arKey, orderId: order._id,
    office: await officeOf(order), earnedAt: now, expiresAt: new Date(now.getTime() + tier.expiryDays * DAY_MS), eventKey,
  }], { session });
  const { settings } = await getConfig();
  if (settings?.liveEnabled) await postEarnEntry(movement.toObject(), order.orderId, session);
  // Reaching the next level happens at once, in the same transaction
  const moved = await require('./levels').refreshLevel(order.user, { now, session });
  return { userId: String(order.user), points, movedTo: moved?.to || null };
}

// A customer's points: balance (unexpired lots), expiring soon, on the way, and totals
async function summaryOf(userId) {
  const user = oid(userId);
  const now = new Date();
  const lots = await LoyaltyPoint.find({ user, kind: { $in: LOTS }, remaining: { $gt: 0 }, expiresAt: { $gt: now } }).select('remaining expiresAt').lean();
  const points = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const soonLimit = new Date(now.getTime() + SOON_DAYS * DAY_MS);
  const soon = lots.filter((lot) => lot.expiresAt <= soonLimit);
  const expiringSoon = soon.length
    ? { points: soon.reduce((sum, lot) => sum + lot.remaining, 0), at: new Date(Math.min(...soon.map((lot) => lot.expiresAt.getTime()))) }
    : null;
  const totals = new Map((await LoyaltyPoint.aggregate([
    { $match: { user } }, { $group: { _id: '$kind', points: { $sum: '$points' } } },
  ])).map((row) => [row._id, row.points]));
  const orders = await Order.find({ user, isCanceled: { $ne: true }, 'loyalty.noPoints': { $ne: true } }).select(ORDER_FIELDS).sort({ _id: 1 }).lean();
  const off = await isOff(userId);
  return {
    off,
    points,
    usd: points / 100,
    expiringSoon,
    pending: off ? [] : await pendingOf(orders),
    earnedTotal: (totals.get('earn') || 0) + (totals.get('add') || 0),
    redeemedTotal: Math.max((totals.get('redeem') || 0) - (totals.get('restore') || 0), 0),
  };
}

// One order's points: earned, on the way, paid with points, or why it earns none
async function orderLoyalty(orderId) {
  const order = await Order.findById(orderId).select(ORDER_FIELDS).lean();
  const movements = await LoyaltyPoint.find({ orderId: oid(orderId) }).select('kind points arKey promotion').lean();
  const sum = (kind) => movements.filter((m) => m.kind === kind).reduce((total, m) => total + m.points, 0);
  const pendingRows = order ? await pendingOf([order]) : [];
  const pending = pendingRows.reduce((total, row) => total + row.points, 0);
  const offer = movements.find((m) => m.kind === 'earn' && m.promotion?.id)?.promotion || pendingRows.find((r) => r.promotion)?.promotion;
  // Per package (shipment claims only): earned = earn less revoke on its key, pending as in pendingOf
  const packages = {};
  for (const pkg of order?.paymentList || []) {
    const arKey = shipmentKey(order._id, pkg._id);
    const forKey = (kind) => movements.filter((m) => m.kind === kind && m.arKey === arKey).reduce((total, m) => total + m.points, 0);
    const earned = Math.max(forKey('earn') - forKey('revoke'), 0);
    const row = pendingRows.find((r) => r.arKey === arKey);
    if (earned > 0 || row) packages[String(pkg._id)] = { earned, pending: row ? row.points : 0, waitingFor: row ? row.waitingFor : null };
  }
  return {
    packages,
    earned: Math.max(sum('earn') - sum('revoke'), 0),
    pending,
    redeemed: Math.max(sum('redeem') - sum('restore'), 0),
    noPoints: order?.loyalty?.noPoints ? { reason: order.loyalty.reason || '' } : null,
    // The points offer of this order, from what it earned or what is on the way (absent when none)
    ...(offer && { promotion: offer }),
  };
}

// Points paid on each part of an order, net of what came back (cancelled or restored): the
// invoice (PUR:<order>) and each package's shipping (SHP:<order>:<package>), by package id.
// Staff use it to take what points paid off what the order still asks for.
async function redeemedByPart(orderId) {
  if (!mongoose.isValidObjectId(orderId)) return { invoice: 0, packages: {} };
  const movements = await LoyaltyPoint.find({ orderId: oid(orderId), kind: { $in: ['redeem', 'restore'] } }).select('kind points arKey').lean();
  const byKey = new Map();
  for (const m of movements) {
    if (!m.arKey) continue;
    byKey.set(m.arKey, (byKey.get(m.arKey) || 0) + (m.kind === 'redeem' ? m.points : -m.points));
  }
  const result = { invoice: 0, packages: {} };
  for (const [arKey, points] of byKey) {
    const net = Math.max(points, 0);
    if (!net) continue;
    const parsed = parseKey(arKey);
    if (parsed.kind === 'purchase') result.invoice += net;
    else if (parsed.kind === 'shipment' && parsed.packageId && !parsed.domesticFee && !parsed.customsFee) {
      result.packages[String(parsed.packageId)] = (result.packages[String(parsed.packageId)] || 0) + net;
    }
  }
  return result;
}

// ---- Redeeming (staff only; spec "Redeeming") ----

// The claims a payment target pays that points may pay: a purchase or shipping invoice, never a
// package's transport or customs fee, nor a debt not tied to an order
async function redeemKeys(target, session) {
  const keys = await resolveClaimKeys({ orderId: target.orderId, category: target.category, packageIds: target.packageIds }, session);
  return keys.filter((key) => {
    const parsed = parseKey(key);
    return ['purchase', 'shipment'].includes(parsed.kind) && !parsed.domesticFee && !parsed.customsFee;
  });
}

// The customer's lots still spendable now, oldest first
const spendableLots = (user, now, session) => LoyaltyPoint.find({ user: oid(user), kind: { $in: LOTS }, remaining: { $gt: 0 }, expiresAt: { $gt: now } })
  .select('remaining expiresAt').sort({ expiresAt: 1, _id: 1 }).session(session || null).lean();

// The quote over some claims of one customer: { balance, maxPoints, owedCents, billedCents, usedOnTarget }.
// The 20% cap is pooled over the claims (what was billed on them, less what points already paid).
async function quoteKeys(user, keys, session, now) {
  // One at a time: operations of one transaction must not run concurrently
  const ledger = await claimLedger({ $in: keys }, session);
  const redeemed = await redeemedOn(keys, session);
  const lots = await spendableLots(user, now, session);
  const billedCents = keys.reduce((sum, key) => sum + Math.max(ledger.get(key)?.billed || 0, 0), 0);
  const owedCents = keys.reduce((sum, key) => sum + Math.max(ledger.get(key)?.open || 0, 0), 0);
  const usedOnTarget = keys.reduce((sum, key) => sum + (redeemed.get(key) || 0), 0);
  const balance = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  const off = await isOff(user, session);
  const maxPoints = off ? 0 : Math.max(Math.min(balance, owedCents, redeemCap(billedCents, usedOnTarget)), 0);
  return { lots, quote: { balance, maxPoints, owedCents, billedCents, usedOnTarget, ...(off && { off: true }) } };
}

async function quoteOf({ userId, target }, session, now = new Date()) {
  if (!target?.orderId || !mongoose.isValidObjectId(target.orderId)) throw new ErrorHandler(400, 'حدد الطلبية');
  const order = await Order.findById(target.orderId).select('orderId user placedAt').session(session || null).lean();
  if (!order) throw new ErrorHandler(404, 'الطلبية غير موجودة');
  if (!userId || String(order.user) !== String(userId)) throw new ErrorHandler(400, 'هذه الطلبية ليست لهذا العميل');
  const keys = await redeemKeys(target, session);
  const { lots, quote } = await quoteKeys(order.user, keys, session, now);
  return { orders: [order], keys, lots, quote };
}

// The shipping claims `SHP:<order>:<package>` of some packages of one customer, which may belong to
// several of their orders (never the packages' transport or customs fees). A package that is not the
// customer's, of a cancelled order or already handed over is refused.
async function packagesQuoteOf({ userId, packageIds }, session, now = new Date()) {
  if (!userId || !mongoose.isValidObjectId(userId)) throw new ErrorHandler(400, 'حدد العميل');
  const ids = [...new Set((packageIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new ErrorHandler(400, 'اختر الطرود');
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new ErrorHandler(400, 'بعض الطرود المحددة ليست لهذا العميل');
  const orders = await Order.find({ user: oid(userId), isCanceled: { $ne: true }, 'paymentList._id': { $in: ids.map(oid) } })
    .select('orderId user placedAt paymentList._id paymentList.status.received').sort({ _id: 1 }).session(session || null).lean();
  const owner = new Map();
  for (const order of orders) for (const pkg of order.paymentList || []) owner.set(String(pkg._id), { order, pkg });
  const keys = ids.map((id) => {
    const found = owner.get(id);
    if (!found) throw new ErrorHandler(400, 'بعض الطرود المحددة ليست لهذا العميل');
    if (found.pkg.status?.received) throw new ErrorHandler(400, 'بعض الطرود المحددة سُلّمت من قبل');
    return shipmentKey(found.order._id, id);
  });
  const { lots, quote } = await quoteKeys(oid(userId), keys, session, now);
  return { orders: orders.map(({ paymentList, ...order }) => order), keys, lots, quote };
}

// What the customer can pay with points on a target: { balance, maxPoints, owedCents, billedCents, usedOnTarget }
async function redeemQuote({ userId, target }, { session } = {}) {
  return (await quoteOf({ userId, target }, session)).quote;
}

// The same quote over the shipping of some packages (the delivery screen)
async function packagesQuote({ userId, packageIds }, { session } = {}) {
  return (await packagesQuoteOf({ userId, packageIds }, session)).quote;
}

// Pays `points` of the target with the customer's points, oldest lots first: one redeem movement
// per claim paid, and one entry Dr loyalty_points (the customer) / Cr customer_receivable (the
// claims, by what is still owed on each). At most 20% of the invoice, what is owed and the balance.
async function redeem({ userId, target, points }, { session, req } = {}) {
  return redeemOn(userId, points, (now) => quoteOf({ userId, target }, session, now), { session, req });
}

// The same over the shipping of some packages of the customer, possibly of several orders (the
// delivery screen). The 20% cap is pooled over the packages. One entry per order, so cancelling an
// order reverses exactly what was paid on it (restoreOrder reverses a redemption's whole entry).
async function redeemPackages({ userId, packageIds, points }, { session, req } = {}) {
  return redeemOn(userId, points, (now) => packagesQuoteOf({ userId, packageIds }, session, now), { session, req });
}

// What redeem and redeemPackages share. quoteFor(now) gives { orders, keys, lots, quote }.
async function redeemOn(userId, points, quoteFor, { session, req } = {}) {
  assertInTransaction(session);
  if (!Number.isInteger(points) || points < 1) throw new ErrorHandler(400, 'اكتب عدد النقاط (رقم صحيح من 1 فأكثر)');
  if (!(await getConfig()).settings?.liveEnabled) throw new ErrorHandler(400, 'الترحيل المحاسبي الحي غير مفعّل؛ لا يمكن الدفع بالنقاط الآن');
  // Every redemption of the customer waits for the one before it (a write conflict otherwise)
  if (userId) await lockWalletOwner(userId, session);
  const now = new Date();
  const { orders, keys, lots, quote } = await quoteFor(now);
  if (quote.off) throw new ErrorHandler(400, 'نقاط هذا العميل موقوفة، لا يمكن الدفع بها');
  if (points > quote.balance) throw new ErrorHandler(400, 'رصيد النقاط لا يكفي');
  if (points > quote.owedCents) throw new ErrorHandler(400, 'النقاط المطلوبة أكثر من المبلغ المستحق على هذه الفاتورة');
  if (points > quote.maxPoints) throw new ErrorHandler(400, 'النقاط المطلوبة أكثر من المسموح على هذه الفاتورة');
  await lockClaimAllocations(keys, session);
  const parts = await splitOverClaims(keys, points, session);
  // The lots each claim's part used, oldest first
  const taken = takeOldest(lots, points).map((source) => ({ ...source }));
  for (const { lotId, points: take } of taken) {
    const result = await LoyaltyPoint.updateOne({ _id: lotId, remaining: { $gte: take } }, { $inc: { remaining: -take } }, { session });
    if (result.modifiedCount !== 1) throw new ErrorHandler(409, 'تغيّر رصيد النقاط أثناء العملية. أعد المحاولة.');
  }
  const ordersById = new Map(orders.map((order) => [String(order._id), order]));
  // The parts by order, in the order the claims were split
  const groups = new Map();
  for (const part of parts) {
    const orderId = parseKey(part.key).orderId;
    const order = ordersById.get(orderId);
    if (!order) throw new Error(`Loyalty: claim ${part.key} is not on the quoted orders`);
    if (!groups.has(orderId)) groups.set(orderId, { order, office: await officeOf(order), items: [] });
    const group = groups.get(orderId);
    const sources = [];
    let rest = part.usd;
    while (rest > 0) {
      const source = taken[0];
      const take = Math.min(source.points, rest);
      sources.push({ lotId: source.lotId, points: take });
      source.points -= take;
      rest -= take;
      if (source.points === 0) taken.shift();
    }
    const _id = new mongoose.Types.ObjectId();
    group.items.push({ part, movement: { _id, user: order.user, kind: 'redeem', points: part.usd, arKey: part.key, orderId: order._id,
      office: group.office, sources, eventKey: `LOYALTY_REDEEM:${_id}`, createdBy: req?.user?._id } });
  }
  const receivable = await resolveAccount('customer_receivable');
  const entryIds = [];
  for (const { order, items } of groups.values()) {
    const movements = items.map(({ movement }) => movement);
    const sum = movements.reduce((total, movement) => total + movement.points, 0);
    const partnerId = oid(order.user);
    const entry = await postEntry({
      eventType: 'LOYALTY_REDEEM',
      eventKey: movements[0].eventKey, // the first movement's id names the entry (and its LOYALTY_RESTORE reversal)
      description: `دفع بنقاط الولاء (${sum} نقطة) - طلب ${order.orderId || order._id}`,
      source: { model: 'LoyaltyPoint', id: movements[0]._id },
      lines: [
        { role: 'loyalty_points', debit: sum, partnerId, orderId: order._id },
        ...claimLines(items.map(({ part }) => part), 'credit', partnerId).map((line) => ({ ...line, accountId: receivable._id })),
      ],
    }, { session, user: req?.user });
    await LoyaltyPoint.create(movements.map((movement) => ({ ...movement, journalEntryId: entry._id })), { session, ordered: true });
    entryIds.push(entry._id);
  }
  for (const { order } of groups.values()) await syncOrder(order._id, { session, user: req?.user });
  const open = await openBalances(keys, session);
  const remainingOwedCents = keys.reduce((sum, key) => sum + Math.max(open.get(key) || 0, 0), 0);
  return { points, usd: points / 100, remainingOwedCents, journalEntryId: entryIds[0], ...(entryIds.length > 1 && { journalEntryIds: entryIds }) };
}

// ---- Points inside a payment (owner's decision: no separate step) ----
// The payment forms (a delivery, a wallet or cash payment on an order) send `points` with the
// payment; the caller redeems them in the payment's own transaction before the money is taken.

// The points a payment carries: 0 when none were sent, else a whole number from 0
function pointsOfPayment(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return 0;
  const points = typeof value === 'number' ? value : (typeof value === 'string' ? Number(value.trim()) : NaN);
  if (!Number.isInteger(points) || points < 0) throw new ErrorHandler(400, 'عدد النقاط يجب أن يكون رقمًا صحيحًا من 0 فأكثر');
  return points;
}

// What is still owed on a payment target, fees included (cents): a payment made only of points is
// accepted only when nothing is left after them
async function owedOnTarget(target, session) {
  const keys = await resolveClaimKeys({ orderId: target.orderId, category: target.category, packageIds: target.packageIds }, session);
  const open = await openBalances(keys, session);
  return keys.reduce((sum, key) => sum + Math.max(open.get(key) || 0, 0), 0);
}

// Pays `points` of an order's payment target (invoice → PUR, receivedGoods → the packages' SHP) in
// the payment's transaction. `pointsOnly`: no money comes with them, so they must close the target.
async function redeemInPayment({ userId, target, points, pointsOnly = false }, { session, req } = {}) {
  if (!['invoice', 'receivedGoods'].includes(target?.category)) throw new ErrorHandler(400, 'النقاط تُستعمل فقط مع دفعة فاتورة الشراء أو الشحن');
  const result = await redeem({ userId, target, points }, { session, req });
  if (pointsOnly && await owedOnTarget(target, session) > 0) {
    throw new ErrorHandler(400, 'النقاط لا تغطي كامل المستحق؛ أدخل مبلغ الدفع للباقي');
  }
  return result;
}

// The dollars points paid on each package's shipping claim SHP:<order>:<package> (net of what came
// back), by package id: what a delivery no longer asks the customer to pay
async function pointsPaidOnPackages(pairs, session) {
  const keys = pairs.map(({ orderId, packageId }) => shipmentKey(orderId, packageId));
  const redeemed = await redeemedOn(keys, session);
  return new Map(pairs.map(({ packageId }, i) => [String(packageId), (redeemed.get(keys[i]) || 0) / 100]));
}

// ---- Expiry, no-points orders and cancellation (spec "Expiry", "No points", accounting table) ----

const TAKE_BACK = { expire: 'LOYALTY_EXPIRE', revoke: 'LOYALTY_REVOKE' };

// Takes what is left of a lot off the balance: an expire or revoke movement naming the lot, and
// (accounting live) Dr loyalty_points (the customer) / Cr loyalty_expense (the lot's office).
// Returns the movement, or null when nothing is left on the lot.
async function takeBackLot(lotId, kind, session) {
  const lot = await LoyaltyPoint.findById(lotId).session(session).lean();
  if (!lot || !(lot.remaining > 0)) return null;
  const changed = await LoyaltyPoint.updateOne({ _id: lot._id, remaining: lot.remaining }, { $set: { remaining: 0 } }, { session });
  if (changed.modifiedCount !== 1) throw new Error('Loyalty lot changed concurrently; retry the transaction');
  const office = lot.office || await officeOf({});
  const eventKey = `${TAKE_BACK[kind]}:${lot._id}`;
  const [movement] = await LoyaltyPoint.create([{
    user: lot.user, kind, points: lot.remaining, arKey: lot.arKey, orderId: lot.orderId, office,
    sources: [{ lotId: lot._id, points: lot.remaining }], eventKey,
  }], { session });
  const { settings } = await getConfig();
  if (settings?.liveEnabled) await postTakeBackEntry(movement.toObject(), session);
  return movement;
}

// Dr loyalty_points (the customer) / Cr loyalty_expense (the movement's office), for an expire or
// revoke movement; the entry has the movement's eventKey
async function postTakeBackEntry(movement, session) {
  const orderNumber = await orderNumberOf(movement.orderId, session);
  const office = movement.office || await officeOf({});
  const entry = await postEntry({
    eventType: TAKE_BACK[movement.kind],
    eventKey: movement.eventKey,
    description: `${movement.kind === 'expire' ? 'نقاط ولاء منتهية' : 'سحب نقاط ولاء'} (${movement.points} نقطة)${orderNumber ? ` - طلب ${orderNumber}` : ''}`,
    source: { model: 'LoyaltyPoint', id: movement._id },
    lines: [
      { role: 'loyalty_points', debit: movement.points, partnerId: movement.user, ...(movement.orderId && { orderId: movement.orderId }) },
      { role: 'loyalty_expense', credit: movement.points, office, ...(movement.orderId && { orderId: movement.orderId }) },
    ],
  }, { session });
  await LoyaltyPoint.updateOne({ _id: movement._id }, { $set: { journalEntryId: entry._id } }, { session });
  return entry;
}

// The reversal of a redemption's entry, for one of its restore lots (eventKey
// LOYALTY_RESTORE:<redeemId>:<lotId>). Null when the redemption has no entry.
async function postRestoreEntry(restoreLot, session) {
  const redeemId = restoreLot.eventKey.split(':')[1];
  const redemption = await LoyaltyPoint.findById(redeemId).select('journalEntryId').session(session).lean();
  if (!redemption?.journalEntryId) return null;
  const reversal = await reverseRedemption(redemption, session);
  await LoyaltyPoint.updateOne({ _id: restoreLot._id }, { $set: { journalEntryId: reversal._id } }, { session });
  return reversal;
}

// One entry may pay several claims (one redeem movement each), so it is reversed once: its key is
// LOYALTY_RESTORE:<the id in the entry's own eventKey>, i.e. the first movement's id, for every
// movement it paid (reverseEntry returns the existing reversal for a key it already posted)
// A staff cancellation names its reversal LOYALTY_REDEEM_CANCEL:<id> instead; an entry already
// reversed (either way) gives its existing reversal.
async function reverseRedemption(redemption, session, { reason = 'إلغاء الطلبية: إرجاع النقاط', prefix = 'LOYALTY_RESTORE', user } = {}) {
  const entry = await JournalEntry.findById(redemption.journalEntryId).select('eventKey status reversedBy').session(session).lean();
  if (entry?.status === 'reversed' && entry.reversedBy) {
    const existing = await JournalEntry.findById(entry.reversedBy).session(session);
    if (existing) return existing;
  }
  const key = String(entry?.eventKey || `LOYALTY_REDEEM:${redemption._id}`).replace(/^LOYALTY_REDEEM:/, `${prefix}:`);
  return reverseEntry(redemption.journalEntryId, { session, user, eventKey: key, eventType: 'LOYALTY_RESTORE', reason });
}

// The points an order earned and not spent yet are taken back (order "no points" or cancelled).
// Returns how many lots were taken back.
async function revokeOrder(orderId, session) {
  const lots = await LoyaltyPoint.find({ kind: 'earn', orderId: oid(orderId), remaining: { $gt: 0 } }).select('_id').session(session).lean();
  let revoked = 0;
  for (const { _id } of lots) if (await takeBackLot(_id, 'revoke', session)) revoked += 1;
  return revoked;
}

const restorePrefix = (redeemId) => `LOYALTY_RESTORE:${redeemId}:`;

// A cancelled order gives back the points paid on it: each redemption's entry is reversed and each
// lot it used comes back as a restore lot with that lot's expiry. Points from a lot already past
// its expiry come back and expire at once (so the reversed liability goes to expense, not to the
// balance). Returns how many redemptions were restored.
async function restoreOrder(orderId, now, session) {
  const redemptions = await LoyaltyPoint.find({ kind: 'redeem', orderId: oid(orderId) }).sort({ _id: 1 }).session(session).lean();
  let restored = 0;
  for (const redemption of redemptions) if (await restoreRedemption(redemption, now, session)) restored += 1;
  return restored;
}

// Gives back one redeem movement: its entry reversed (once for every movement it paid), each lot it
// used back as a restore lot with that lot's expiry, expired at once when already past it. False
// when it was given back before. `reverse` names the reversal and `reason` goes on the restore lots.
async function restoreRedemption(redemption, now, session, { reason, reverse } = {}) {
  // ObjectId hex needs no escaping
  if (await LoyaltyPoint.exists({ eventKey: { $regex: `^${restorePrefix(redemption._id)}` } }).session(session)) return false;
  // The redemption entry is reversed at once (it was posted live), even if accounting is off now
  const reversal = redemption.journalEntryId ? await reverseRedemption(redemption, session, reverse) : null;
  for (const source of redemption.sources || []) {
    const lot = await LoyaltyPoint.findById(source.lotId).select('expiresAt').session(session).lean();
    if (!lot?.expiresAt) throw new Error(`Loyalty lot ${source.lotId} not found`);
    const [back] = await LoyaltyPoint.create([{
      user: redemption.user, kind: 'restore', points: source.points, remaining: source.points, arKey: redemption.arKey,
      orderId: redemption.orderId, office: redemption.office, earnedAt: now, expiresAt: lot.expiresAt,
      eventKey: `${restorePrefix(redemption._id)}${source.lotId}`, ...(reversal && { journalEntryId: reversal._id }), ...(reason && { reason }),
    }], { session });
    if (lot.expiresAt <= now) await takeBackLot(back._id, 'expire', session);
  }
  return true;
}

// ---- Staff: cancelling a redemption (points used by mistake) ----

// A redemption is the redeem movements sharing one entry (one per claim it paid), named by its
// first movement's id: the id in the entry's eventKey LOYALTY_REDEEM:<id>.
const redemptionGroupKey = (m) => String(m.journalEntryId || m._id);

// The delivery invoice (not cancelled) holding a package of the order, as { id, referenceId }, by
// package id. Points on a package handed over are given back only by cancelling that invoice from
// the customer's invoices (owner's decision 2026-11-17): the invoice was priced net of them.
async function deliveryInvoicesOf(order, movements, session) {
  const packageIds = [...new Set(movements.map((m) => parseKey(m.arKey)).filter((key) => key.kind === 'shipment' && !key.domesticFee && !key.customsFee)
    .map((key) => key.packageId))];
  const received = new Set((order?.paymentList || []).filter((item) => item.status?.received).map((item) => String(item._id)));
  const held = packageIds.filter((id) => received.has(id));
  const found = new Map();
  if (!held.length) return found;
  const Invoices = require('../../../models/invoice');
  const ids = held.flatMap((id) => (mongoose.isValidObjectId(id) ? [id, oid(id)] : [id]));
  const invoices = await Invoices.find({ isCanceled: { $ne: true }, list: { $elemMatch: { orderId: order.orderId, packageId: { $in: ids }, canceledAt: { $exists: false } } } })
    .select('referenceId list').sort({ _id: -1 }).session(session || null).lean();
  for (const invoice of invoices) {
    for (const pkg of invoice.list || []) {
      const id = String(pkg.packageId || '');
      if (pkg.orderId === order.orderId && !pkg.canceledAt && held.includes(id) && !found.has(id)) {
        found.set(id, { id: String(invoice._id), referenceId: invoice.referenceId });
      }
    }
  }
  return found;
}

// The delivery invoice a redemption's packages were handed over in, or null
function invoiceOfMovements(movements, invoices) {
  for (const m of movements) {
    const key = parseKey(m.arKey);
    if (key.kind === 'shipment' && invoices.has(key.packageId)) return invoices.get(key.packageId);
  }
  return null;
}

// The redemptions of an order, newest first: { id, points, usd, createdAt, by (staff id), canceled,
// invoice } — invoice: the delivery invoice it was handed over in (cancelled from there only)
async function orderRedemptions(orderId) {
  if (!mongoose.isValidObjectId(orderId)) return [];
  const movements = await LoyaltyPoint.find({ kind: 'redeem', orderId: oid(orderId) })
    .select('points arKey journalEntryId createdAt createdBy canceledAt canceledBy cancelReason').sort({ _id: 1 }).lean();
  const order = movements.length
    ? await Order.findById(orderId).setOptions({ withDeleted: true }).select('orderId paymentList._id paymentList.status.received').lean()
    : null;
  const invoices = await deliveryInvoicesOf(order, movements);
  const restored = new Set((await LoyaltyPoint.find({ kind: 'restore', orderId: oid(orderId) }).select('eventKey').lean())
    .map((lot) => lot.eventKey.split(':')[1]));
  const groups = new Map();
  for (const m of movements) {
    const key = redemptionGroupKey(m);
    if (!groups.has(key)) groups.set(key, { first: m, points: 0, back: false, movements: [] });
    const group = groups.get(key);
    group.points += m.points;
    group.movements.push(m);
    if (restored.has(String(m._id))) group.back = true;
  }
  return [...groups.values()].reverse().map(({ first, points, back, movements: own }) => ({
    id: String(first._id),
    points,
    usd: points / 100,
    createdAt: first.createdAt,
    by: first.createdBy ? String(first.createdBy) : null,
    // Given back with its cancelled order: no staff and no reason of their own
    canceled: first.canceledAt
      ? { at: first.canceledAt, by: first.canceledBy ? String(first.canceledBy) : null, reason: first.cancelReason || '' }
      : (back ? { at: null, by: null, reason: 'إلغاء الطلبية' } : null),
    invoice: first.canceledAt || back ? null : invoiceOfMovements(own, invoices),
  }));
}

// Staff undo a redemption of an order with a required reason: its whole entry is reversed (every
// claim it paid is owed again) and the points come back with their lots' original expiry, as when
// the order is cancelled. Needs live accounting, like redeeming. Returns { restored, usd }.
async function cancelRedemption({ orderId, redemptionId, reason } = {}, { session, req } = {}) {
  assertInTransaction(session);
  if (!mongoose.isValidObjectId(orderId)) throw new ErrorHandler(400, 'حدد الطلبية');
  const order = await Order.findById(orderId).setOptions({ withDeleted: true }).select('user orderId paymentList._id paymentList.status.received').session(session).lean();
  if (!order) throw new ErrorHandler(404, 'الطلبية غير موجودة');
  // Every movement of the customer's points waits for the one before it
  if (order.user) await lockWalletOwner(order.user, session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب إلغاء النقاط');
  if (!(await getConfig()).settings?.liveEnabled) throw new ErrorHandler(400, 'الترحيل المحاسبي الحي غير مفعّل؛ لا يمكن إلغاء النقاط الآن');
  const notFound = () => new ErrorHandler(404, 'النقاط المستعملة غير موجودة في هذه الطلبية');
  if (!mongoose.isValidObjectId(redemptionId)) throw notFound();
  const named = await LoyaltyPoint.findOne({ _id: oid(redemptionId), kind: 'redeem', orderId: order._id }).session(session).lean();
  if (!named) throw notFound();
  const movements = named.journalEntryId
    ? await LoyaltyPoint.find({ kind: 'redeem', orderId: order._id, journalEntryId: named.journalEntryId }).sort({ _id: 1 }).session(session).lean()
    : [named];
  const eventKey = `LOYALTY_REDEEM_CANCEL:${movements[0]._id}`;
  const done = movements.some((m) => m.canceledAt)
    || await JournalEntry.exists({ eventKey }).session(session)
    || await LoyaltyPoint.exists({ $or: movements.map((m) => ({ eventKey: { $regex: `^${restorePrefix(m._id)}` } })) }).session(session);
  if (done) throw new ErrorHandler(400, 'تم إلغاء هذه النقاط من قبل');
  const invoice = invoiceOfMovements(movements, await deliveryInvoicesOf(order, movements, session));
  if (invoice) {
    throw new ErrorHandler(400, `هذه النقاط مستعملة في فاتورة التسليم رقم #0${invoice.referenceId}؛ تُلغى من فواتير العميل (Created Invoices) بإلغاء الفاتورة أو الشحنة`);
  }
  await lockClaimAllocations(movements.map((m) => m.arKey).filter(Boolean), session);
  const now = new Date();
  const reverse = { prefix: 'LOYALTY_REDEEM_CANCEL', reason: `إلغاء استعمال النقاط: ${why}`, user: req?.user };
  for (const movement of movements) await restoreRedemption(movement, now, session, { reason: why, reverse });
  await LoyaltyPoint.updateMany({ _id: { $in: movements.map((m) => m._id) } },
    { $set: { canceledAt: now, cancelReason: why, ...(req?.user?._id && { canceledBy: req.user._id }) } }, { session });
  await syncOrder(order._id, { session, user: req?.user });
  const points = movements.reduce((sum, m) => sum + m.points, 0);
  return { restored: points, usd: points / 100 };
}

// Staff mark an order "no points" (a reason is required) or switch it back. Marking takes back at
// once what the order earned and was not spent yet; switching back does not return it.
async function setNoPoints(orderId, { enabled, reason } = {}, { session, req } = {}) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (enabled && !why) throw new ErrorHandler(400, 'اكتب سبب استثناء الطلبية من النقاط');
  if (!mongoose.isValidObjectId(orderId)) throw new ErrorHandler(400, 'حدد الطلبية');
  const order = await Order.findById(orderId).select('user').session(session).lean();
  if (!order) throw new ErrorHandler(404, 'الطلبية غير موجودة');
  if (order.user) await lockWalletOwner(order.user, session);
  await Order.updateOne({ _id: order._id }, { $set: { loyalty: { noPoints: !!enabled, reason: why, by: req?.user?._id, at: new Date() } } }, { session });
  if (enabled) await revokeOrder(order._id, session);
}

// ---- Staff: adjustments, the customers list and the history (spec "Staff management") ----

const DEFAULT_ADJUST_OFFICE = 'tripoli';
const HISTORY_PAGE_SIZE = 20;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pageOf = ({ page, limit } = {}, max = 100) => {
  const size = Math.min(Math.max(parseInt(limit, 10) || HISTORY_PAGE_SIZE, 1), max);
  return { page: Math.max(parseInt(page, 10) || 1, 1), limit: size };
};

// The office serving the customer's city (Settings > Customer prices > offices), else Tripoli
async function customerOffice(city, session) {
  const name = String(city || '').trim();
  if (!name) return DEFAULT_ADJUST_OFFICE;
  const config = await PricingConfig.findOne({ key: 'main' }).select('offices').session(session || null).lean();
  const office = (config?.offices || []).find((o) => (o.cities || []).some((c) => String(c).trim() === name));
  const { offices } = await getConfig();
  return office?.key && offices.has(office.key) ? office.key : DEFAULT_ADJUST_OFFICE;
}

// An add (Dr loyalty_expense / Cr loyalty_points) or a deduct (the reverse), with the movement's eventKey
async function postAdjustEntry(movement, session, user) {
  const add = movement.kind === 'add';
  const expense = { role: 'loyalty_expense', office: movement.office || DEFAULT_ADJUST_OFFICE };
  const liability = { role: 'loyalty_points', partnerId: movement.user };
  const entry = await postEntry({
    eventType: add ? 'LOYALTY_ADD' : 'LOYALTY_DEDUCT',
    eventKey: movement.eventKey,
    description: `${add ? 'إضافة' : 'خصم'} نقاط ولاء (${movement.points} نقطة)${movement.reason ? ` - ${movement.reason}` : ''}`,
    source: { model: 'LoyaltyPoint', id: movement._id },
    lines: add
      ? [{ ...expense, debit: movement.points }, { ...liability, credit: movement.points }]
      : [{ ...liability, debit: movement.points }, { ...expense, credit: movement.points }],
  }, { session, ...(user && { user }) });
  await LoyaltyPoint.updateOne({ _id: movement._id }, { $set: { journalEntryId: entry._id } }, { session });
  return entry;
}

// Staff add (points > 0: a new lot expiring 365 days later) or deduct (points < 0: oldest lots
// first, never below zero) with a required reason, shown to the customer in their history
async function adjust({ userId, points, reason } = {}, { session, req } = {}) {
  assertInTransaction(session);
  const why = String(reason || '').trim();
  if (!why) throw new ErrorHandler(400, 'اكتب سبب تعديل النقاط');
  if (!Number.isInteger(points) || points === 0) throw new ErrorHandler(400, 'اكتب عدد النقاط (رقم صحيح غير الصفر)');
  if (!userId || !mongoose.isValidObjectId(userId)) throw new ErrorHandler(400, 'حدد العميل');
  const customer = await mongoose.connection.collection('users').findOne({ _id: oid(userId) }, { projection: { city: 1 }, session });
  if (!customer) throw new ErrorHandler(404, 'العميل غير موجود');
  // Every movement of the customer's points waits for the one before it
  await lockWalletOwner(customer._id, session);
  const now = new Date();
  const office = await customerOffice(customer.city, session);
  const _id = new mongoose.Types.ObjectId();
  const base = { _id, user: customer._id, points: Math.abs(points), office, reason: why, eventKey: `LOYALTY_ADJUST:${_id}`, createdBy: req?.user?._id };
  let movement;
  if (points > 0) {
    movement = { ...base, kind: 'add', remaining: points, earnedAt: now, expiresAt: new Date(now.getTime() + EXPIRY_DAYS * DAY_MS) };
  } else {
    const lots = await spendableLots(customer._id, now, session);
    const balance = lots.reduce((sum, lot) => sum + lot.remaining, 0);
    if (-points > balance) throw new ErrorHandler(400, 'رصيد النقاط لا يكفي');
    const sources = takeOldest(lots, -points);
    for (const { lotId, points: take } of sources) {
      const result = await LoyaltyPoint.updateOne({ _id: lotId, remaining: { $gte: take } }, { $inc: { remaining: -take } }, { session });
      if (result.modifiedCount !== 1) throw new ErrorHandler(409, 'تغيّر رصيد النقاط أثناء العملية. أعد المحاولة.');
    }
    movement = { ...base, kind: 'deduct', sources };
  }
  const [created] = await LoyaltyPoint.create([movement], { session });
  if ((await getConfig()).settings?.liveEnabled) await postAdjustEntry(created.toObject(), session, req?.user);
}

// Points the system gives (a level's upgrade gift): an add lot like a staff addition,
// once per eventKey, lasting as long as the customer's level keeps points. Returns the lot or null.
async function grantGift({ userId, points, reason, eventKey, now = new Date() } = {}, session) {
  assertInTransaction(session);
  if (!(points > 0) || !eventKey) return null;
  if (await LoyaltyPoint.exists({ eventKey }).session(session)) return null;
  const customer = await mongoose.connection.collection('users').findOne({ _id: oid(userId) }, { projection: { city: 1, 'loyaltyTier.level': 1 }, session });
  if (!customer) return null;
  await lockWalletOwner(customer._id, session);
  const office = await customerOffice(customer.city, session);
  const days = tiers.tierOf(customer.loyaltyTier?.level).expiryDays;
  const [created] = await LoyaltyPoint.create([{
    user: customer._id, kind: 'add', points, remaining: points, office, reason, eventKey,
    earnedAt: now, expiresAt: new Date(now.getTime() + days * DAY_MS),
  }], { session });
  if ((await getConfig()).settings?.liveEnabled) await postAdjustEntry(created.toObject(), session);
  return created;
}

// Every customer with a balance or a history: their balance (unexpired lots), what expires within
// 30 days and their last movement. Totals cover every customer (the liability), whatever the filter.
async function customersWithPoints({ search, sort = 'balance', expiringOnly = false, page, limit } = {}) {
  const paging = pageOf({ page, limit });
  const now = new Date();
  const soonLimit = new Date(now.getTime() + SOON_DAYS * DAY_MS);
  const isLive = { $and: [{ $in: ['$kind', LOTS] }, { $gt: ['$remaining', 0] }, { $gt: ['$expiresAt', now] }] };
  const isSoon = { $and: [isLive, { $lte: ['$expiresAt', soonLimit] }] };
  const perCustomer = [
    { $group: {
      _id: '$user',
      points: { $sum: { $cond: [isLive, '$remaining', 0] } },
      soonPoints: { $sum: { $cond: [isSoon, '$remaining', 0] } },
      soonAt: { $min: { $cond: [isSoon, '$expiresAt', null] } },
      lastMovementAt: { $max: '$createdAt' },
    } },
  ];
  const [totals] = await LoyaltyPoint.aggregate([...perCustomer, { $group: {
    _id: null, points: { $sum: '$points' }, customers: { $sum: { $cond: [{ $gt: ['$points', 0] }, 1, 0] } },
    soonCustomers: { $sum: { $cond: [{ $gt: ['$soonPoints', 0] }, 1, 0] } }, soonPoints: { $sum: '$soonPoints' },
  } }]);
  const match = {};
  if (expiringOnly === true || expiringOnly === 'true') match.soonPoints = { $gt: 0 };
  const text = String(search || '').trim();
  if (text) {
    const pattern = escapeRegex(text);
    match.$or = [
      { 'customer.customerId': { $regex: pattern, $options: 'i' } },
      { 'customer.name': { $regex: pattern, $options: 'i' } },
      { 'customer.phoneText': { $regex: pattern, $options: 'i' } },
    ];
  }
  const order = sort === 'expiring'
    ? { hasSoon: -1, soonAt: 1, points: -1, _id: 1 }
    : { points: -1, _id: 1 };
  const [result] = await LoyaltyPoint.aggregate([
    ...perCustomer,
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'customer',
      pipeline: [{ $project: { customerId: 1, phone: 1, firstName: 1, lastName: 1, 'loyaltyTier.level': 1 } }] } },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    { $set: {
      'customer.name': { $trim: { input: { $concat: [{ $ifNull: ['$customer.firstName', ''] }, ' ', { $ifNull: ['$customer.lastName', ''] }] } } },
      'customer.phoneText': { $toString: { $ifNull: ['$customer.phone', ''] } },
      hasSoon: { $cond: [{ $gt: ['$soonPoints', 0] }, 1, 0] },
    } },
    { $match: match },
    { $sort: order },
    { $facet: {
      rows: [{ $skip: (paging.page - 1) * paging.limit }, { $limit: paging.limit }],
      count: [{ $count: 'total' }],
    } },
  ]);
  const points = totals?.points || 0;
  return {
    totals: { points, usd: points / 100, customers: totals?.customers || 0,
      expiring: { customers: totals?.soonCustomers || 0, points: totals?.soonPoints || 0 } },
    rows: (result?.rows || []).map((row) => ({
      userId: row._id,
      name: row.customer?.name || '',
      customerId: row.customer?.customerId || '',
      phone: row.customer?.phone ?? null,
      points: row.points,
      usd: row.points / 100,
      expiringSoon: row.soonPoints > 0 ? { points: row.soonPoints, at: row.soonAt } : null,
      lastMovementAt: row.lastMovementAt,
      level: row.customer?.loyaltyTier?.level || tiers.TIERS[0].key,
    })),
    total: result?.count?.[0]?.total || 0,
  };
}

// What each kind of movement does to the balance
const GAIN_KINDS = ['earn', 'add', 'restore'];
const signedPoints = (m) => (GAIN_KINDS.includes(m.kind) ? m.points : -m.points);

// The history's filters: which kinds of movement each one shows
const HISTORY_TYPES = {
  all: null,
  earn: ['earn'],
  spend: ['redeem'],
  expire: ['expire', 'revoke'],
  staff: ['add', 'deduct'],
  returned: ['restore'],
};
// The month of a movement, in Libya time: 'YYYY-MM'
const monthKey = (date) => moment(date).tz(TZ).format('YYYY-MM');

// A customer's movements, newest first, with the order number, the reason and the balance right
// after each one (every movement walked oldest first, so it is right on any page and whatever the
// filter; pages from 1). `type` keeps one kind of movement (HISTORY_TYPES); `months` has, for each
// month on the page, what that month gained and spent over all its movements of that type.
async function historyOf(userId, { page, limit, type } = {}) {
  const typeName = type === undefined || type === null || type === '' ? 'all' : String(type);
  if (!Object.prototype.hasOwnProperty.call(HISTORY_TYPES, typeName)) throw new ErrorHandler(400, 'نوع الحركة غير معروف');
  const paging = pageOf({ page, limit });
  if (!userId || !mongoose.isValidObjectId(userId)) return { rows: [], total: 0, months: [] };
  const kinds = HISTORY_TYPES[typeName];
  const user = oid(userId);
  const filter = kinds ? { user, kind: { $in: kinds } } : { user };
  const [movements, total, all] = await Promise.all([
    LoyaltyPoint.find(filter).select('kind points orderId reason createdAt expiresAt promotion')
      .sort({ createdAt: -1, _id: -1 }).skip((paging.page - 1) * paging.limit).limit(paging.limit).lean(),
    LoyaltyPoint.countDocuments(filter),
    LoyaltyPoint.find({ user }).select('kind points createdAt').sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const balanceAfter = new Map();
  let running = 0;
  for (const m of all) {
    running += signedPoints(m);
    balanceAfter.set(String(m._id), running);
  }
  const pageMonths = [...new Set(movements.map((m) => monthKey(m.createdAt)))];
  const totals = new Map(pageMonths.map((month) => [month, { month, gained: 0, spent: 0 }]));
  for (const m of all) {
    if (kinds && !kinds.includes(m.kind)) continue;
    const entry = totals.get(monthKey(m.createdAt));
    if (!entry) continue;
    const delta = signedPoints(m);
    if (delta > 0) entry.gained += delta;
    else entry.spent += -delta;
  }
  const orderIds = [...new Set(movements.filter((m) => m.orderId).map((m) => String(m.orderId)))];
  const numbers = new Map((await Order.find({ _id: { $in: orderIds } }).setOptions({ withDeleted: true }).select('orderId').lean())
    .map((o) => [String(o._id), o.orderId]));
  return {
    rows: movements.map((m) => ({
      id: String(m._id),
      kind: m.kind,
      points: m.points,
      orderId: m.orderId,
      orderNumber: m.orderId ? numbers.get(String(m.orderId)) : undefined,
      reason: m.reason,
      createdAt: m.createdAt,
      month: monthKey(m.createdAt),
      expiresAt: LOTS.includes(m.kind) ? m.expiresAt : undefined,
      balanceAfter: balanceAfter.get(String(m._id)) ?? 0,
      ...(m.promotion?.id && { promotion: m.promotion }),
    })),
    total,
    months: pageMonths.map((month) => totals.get(month)),
  };
}

// The programme at a glance, for the staff page: what moved this month and the month before (Libya
// time), by what it did, and the latest movements across all customers with who and which order.
const OVERVIEW_BUCKETS = { earn: 'earned', redeem: 'used', expire: 'expired', revoke: 'expired', add: 'added', deduct: 'deducted', restore: 'returned' };
const emptyMonth = () => ({ earned: 0, used: 0, expired: 0, added: 0, deducted: 0, returned: 0 });
async function overview({ now = new Date(), recent = 8 } = {}) {
  const thisMonth = moment(now).tz(TZ).startOf('month');
  const lastMonth = thisMonth.clone().subtract(1, 'month');
  const [byMonth, latest] = await Promise.all([
    LoyaltyPoint.aggregate([
      { $match: { createdAt: { $gte: lastMonth.toDate() } } },
      { $group: { _id: { current: { $gte: ['$createdAt', thisMonth.toDate()] }, kind: '$kind' }, points: { $sum: '$points' } } },
    ]),
    LoyaltyPoint.find({}).select('user kind points orderId reason createdAt').sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(Math.max(Number(recent) || 8, 1), 30)).lean(),
  ]);
  const months = { current: emptyMonth(), previous: emptyMonth() };
  for (const row of byMonth) {
    const bucket = OVERVIEW_BUCKETS[row._id.kind];
    if (bucket) months[row._id.current ? 'current' : 'previous'][bucket] += row.points;
  }
  const User = mongoose.model('User');
  const [users, orders] = await Promise.all([
    User.find({ _id: { $in: [...new Set(latest.map((m) => String(m.user)))] } }).select('firstName lastName customerId').lean(),
    Order.find({ _id: { $in: [...new Set(latest.filter((m) => m.orderId).map((m) => String(m.orderId)))] } })
      .setOptions({ withDeleted: true }).select('orderId').lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const orderNumber = new Map(orders.map((o) => [String(o._id), o.orderId]));
  return {
    month: thisMonth.format('YYYY-MM'),
    current: months.current,
    previous: months.previous,
    recent: latest.map((m) => {
      const u = userById.get(String(m.user));
      return {
        id: String(m._id),
        kind: m.kind,
        points: m.points,
        delta: signedPoints(m),
        createdAt: m.createdAt,
        reason: m.reason,
        userId: String(m.user),
        name: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '',
        customerId: u?.customerId,
        orderId: m.orderId,
        orderNumber: m.orderId ? orderNumber.get(String(m.orderId)) : undefined,
      };
    }),
  };
}

// The points of each of a customer's orders, for the orders list: { [orderId]: { earned, pending } }
// for the orders that earned (earn less revoke) or have points on the way (as in summaryOf)
async function ordersPointsOf(userId) {
  if (!userId || !mongoose.isValidObjectId(userId) || await isOff(userId)) return {};
  const user = oid(userId);
  const [movements, orders] = await Promise.all([
    LoyaltyPoint.aggregate([
      { $match: { user, kind: { $in: ['earn', 'revoke'] }, orderId: { $ne: null } } },
      { $group: { _id: '$orderId', points: { $sum: { $cond: [{ $eq: ['$kind', 'earn'] }, '$points', { $multiply: ['$points', -1] }] } } } },
    ]),
    Order.find({ user, isCanceled: { $ne: true }, 'loyalty.noPoints': { $ne: true } }).select(ORDER_FIELDS).lean(),
  ]);
  const result = {};
  const entry = (id) => (result[id] = result[id] || { earned: 0, pending: 0 });
  for (const row of movements) if (row.points > 0) entry(String(row._id)).earned = row.points;
  for (const row of await pendingOf(orders)) entry(String(row.orderId)).pending += row.points;
  return result;
}

// The hourly job: every lot past its expiry loses what is left on it, one transaction per lot;
// a lot that fails is logged and skipped.
async function expireDue({ now = new Date() } = {}) {
  let expired = 0;
  let failed = 0;
  const lots = await LoyaltyPoint.find({ kind: { $in: LOTS }, remaining: { $gt: 0 }, expiresAt: { $lte: now } }).select('_id user').sort({ expiresAt: 1, _id: 1 }).lean();
  for (const { _id, user } of lots) {
    try {
      const done = await runInTransaction(async (session) => {
        await lockWalletOwner(user, session);
        const lot = await LoyaltyPoint.findById(_id).select('expiresAt').session(session).lean();
        if (!lot || lot.expiresAt > now) return false;
        return !!(await takeBackLot(_id, 'expire', session));
      });
      if (done) expired += 1;
    } catch (error) {
      failed += 1;
      console.error(`[loyalty] expire ${_id}: ${error.message}`);
    }
  }
  return { expired, failed };
}

// The hourly job: orders marked "no points" or cancelled lose their unspent earned points, and
// cancelled orders give back the points paid on them. One transaction per order; an order that
// fails is logged and skipped. Not limited to LOYALTY_START_DATE: it acts on whatever movements exist.
async function settleOrders({ now = new Date() } = {}) {
  let revoked = 0;
  let restored = 0;
  let failed = 0;
  const earning = await LoyaltyPoint.distinct('orderId', { kind: 'earn', remaining: { $gt: 0 } });
  // A deleted order counts as cancelled (its claims are reversed the same way): withDeleted
  const toRevoke = await Order.find({ _id: { $in: earning }, $or: [{ isCanceled: true }, { isDeleted: true }, { 'loyalty.noPoints': true }] })
    .setOptions({ withDeleted: true }).select('_id').lean();
  const redeemedOrders = await LoyaltyPoint.distinct('orderId', { kind: 'redeem' });
  const cancelled = (await Order.find({ _id: { $in: redeemedOrders }, $or: [{ isCanceled: true }, { isDeleted: true }] })
    .setOptions({ withDeleted: true }).select('_id').lean()).map((o) => o._id);
  const redemptions = await LoyaltyPoint.find({ kind: 'redeem', orderId: { $in: cancelled } }).select('_id orderId').lean();
  const restoredIds = new Set((await LoyaltyPoint.find({ kind: 'restore', orderId: { $in: cancelled } }).select('eventKey').lean())
    .map((lot) => lot.eventKey.split(':')[1]));
  const toRestore = redemptions.filter((r) => !restoredIds.has(String(r._id))).map((r) => String(r.orderId));
  const orderIds = [...new Set([...toRevoke.map((o) => String(o._id)), ...toRestore])].sort();
  for (const id of orderIds) {
    try {
      const result = await runInTransaction(async (session) => {
        const order = await Order.findById(id).setOptions({ withDeleted: true }).select('user isCanceled isDeleted loyalty').session(session).lean();
        if (!order) return { revoked: 0, restored: 0 };
        if (order.user) await lockWalletOwner(order.user, session);
        const out = { revoked: 0, restored: 0 };
        const cancelled = order.isCanceled || order.isDeleted;
        if (cancelled || order.loyalty?.noPoints) out.revoked = await revokeOrder(order._id, session);
        if (cancelled) out.restored = await restoreOrder(order._id, now, session);
        return out;
      });
      revoked += result.revoked;
      restored += result.restored;
    } catch (error) {
      failed += 1;
      console.error(`[loyalty] order ${id}: ${error.message}`);
    }
  }
  return { revoked, restored, failed };
}

module.exports = {
  awardDue, summaryOf, orderLoyalty, redeemedByPart, orderRedemptions, cancelRedemption, redeemQuote, redeem, packagesQuote, redeemPackages, pointsPaidOnPackages, expireDue, settleOrders, setNoPoints,
  pointsOfPayment, redeemInPayment, adjust, customersWithPoints, overview, historyOf, ordersPointsOf, HISTORY_PAGE_SIZE, HISTORY_TYPES,
  claimLedger, claimState, earnKey, loyaltyStartDate, grantGift, levelsOf, isEligibleOrder, isOff, setOff, OFF_REASON,
};
