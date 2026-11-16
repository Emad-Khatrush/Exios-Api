// Loyalty points: earning on paid claims, balance and points on the way (spec 2026-11-16).
// A claim earns once: a shipping claim `SHP:<order>:<package>` or a purchase claim `PUR:<order>`
// (never the package's transport or customs fees), on an order neither cancelled nor marked
// "no points", once it is fully paid and (for shipping) its package delivered. It earns on what was
// billed less what was written off and what was paid with points, and a later reprice never earns
// again. Only orders placed on or after LOYALTY_START_DATE take part.
const mongoose = require('mongoose');
const Order = require('../../../models/order');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const { JournalEntry } = require('../../models');
const { postEntry } = require('../ledger');
const { getConfig } = require('../config');
const { runInTransaction } = require('../transaction');
const { resolveAccount } = require('../roles');
const { purchaseKey, shipmentKey, parseKey, CLAIM_EVENTS } = require('../claims/keys');
const { earnPoints, EXPIRY_DAYS, SOON_DAYS } = require('./rules');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOTS = ['earn', 'add', 'restore'];
const earnKey = (arKey) => `LOYALTY_EARN:${arKey}`;
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const ORDER_FIELDS = 'orderId user placedAt createdAt isRemittance isCanceled loyalty paymentList._id paymentList.status.received';
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
  const rows = [];
  for (const order of eligible) {
    for (const arKey of orderKeys(order)) {
      const state = claimState({ arKey, order, ledger: ledger.get(arKey), redeemed: redeemed.get(arKey), earned: earnedSet.has(arKey) });
      if (!state || state === 'earned') continue;
      rows.push({ orderId: order._id, orderNumber: order.orderId, arKey, points: state.points, waitingFor: state.waitingFor });
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
  const start = loyaltyStartDate();
  if (start) {
    const ledger = await claimLedger({ $in: [/^PUR:/, /^SHP:/] });
    const earned = new Set(await LoyaltyPoint.distinct('arKey', { kind: 'earn' }));
    const candidates = [...ledger].filter(([arKey, row]) => row.billed > 0 && row.open <= 0 && !earned.has(arKey)).map(([arKey]) => arKey);
    const orderIds = [...new Set(candidates.map((key) => parseKey(key).orderId).filter((id) => mongoose.isValidObjectId(id)))];
    const eligible = new Set((await Order.find({ _id: { $in: orderIds }, createdAt: { $gte: start } }).select('_id').lean()).map((o) => String(o._id)));
    for (const arKey of candidates.filter((key) => eligible.has(parseKey(key).orderId))) {
      try {
        if (await runInTransaction((session) => earnClaim(arKey, now, session))) awarded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[loyalty] ${arKey}: ${error.message}`);
      }
    }
  }
  const { settings } = await getConfig();
  if (settings?.liveEnabled) {
    const unposted = await LoyaltyPoint.find({ kind: 'earn', journalEntryId: { $exists: false } }).select('_id arKey').sort({ _id: 1 }).lean();
    for (const { _id, arKey } of unposted) {
      try {
        await runInTransaction(async (session) => {
          const movement = await LoyaltyPoint.findOne({ _id, journalEntryId: { $exists: false } }).session(session).lean();
          if (movement) await postEarnEntry(movement, await orderNumberOf(movement.orderId, session), session);
        });
      } catch (error) {
        failed += 1;
        console.error(`[loyalty] ${arKey}: ${error.message}`);
      }
    }
  }
  return { awarded, failed };
}

async function orderNumberOf(orderId, session) {
  return orderId ? (await Order.findById(orderId).select('orderId').session(session).lean())?.orderId : undefined;
}

// Earns one claim if it is still due, read again inside the transaction. True when it earned.
async function earnClaim(arKey, now, session) {
  const eventKey = earnKey(arKey);
  if (await LoyaltyPoint.exists({ eventKey }).session(session)) return false;
  const order = await Order.findById(parseKey(arKey).orderId).select(ORDER_FIELDS).session(session).lean();
  const ledger = (await claimLedger({ $in: [arKey] }, session)).get(arKey);
  const redeemed = (await redeemedOn([arKey], session)).get(arKey);
  const state = claimState({ arKey, order, ledger, redeemed, earned: false });
  if (!state || state === 'earned' || state.waitingFor !== 'processing') return false;
  const [movement] = await LoyaltyPoint.create([{
    user: order.user, kind: 'earn', points: state.points, remaining: state.points, arKey, orderId: order._id,
    office: await officeOf(order), earnedAt: now, expiresAt: new Date(now.getTime() + EXPIRY_DAYS * DAY_MS), eventKey,
  }], { session });
  const { settings } = await getConfig();
  if (settings?.liveEnabled) await postEarnEntry(movement.toObject(), order.orderId, session);
  return true;
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
  return {
    points,
    usd: points / 100,
    expiringSoon,
    pending: await pendingOf(orders),
    earnedTotal: (totals.get('earn') || 0) + (totals.get('add') || 0),
    redeemedTotal: Math.max((totals.get('redeem') || 0) - (totals.get('restore') || 0), 0),
  };
}

// One order's points: earned, on the way, paid with points, or why it earns none
async function orderLoyalty(orderId) {
  const order = await Order.findById(orderId).select(ORDER_FIELDS).lean();
  const movements = await LoyaltyPoint.find({ orderId: oid(orderId) }).select('kind points').lean();
  const sum = (kind) => movements.filter((m) => m.kind === kind).reduce((total, m) => total + m.points, 0);
  const pending = order ? (await pendingOf([order])).reduce((total, row) => total + row.points, 0) : 0;
  return {
    earned: sum('earn'),
    pending,
    redeemed: Math.max(sum('redeem') - sum('restore'), 0),
    noPoints: order?.loyalty?.noPoints ? { reason: order.loyalty.reason || '' } : null,
  };
}

module.exports = { awardDue, summaryOf, orderLoyalty, claimLedger, claimState, earnKey, loyaltyStartDate };
