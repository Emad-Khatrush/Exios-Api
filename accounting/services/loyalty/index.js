// Loyalty points: earning on paid claims, balance and points on the way (spec 2026-11-16).
// A claim earns once: a shipping claim `SHP:<order>:<package>` or a purchase claim `PUR:<order>`
// (never the package's transport or customs fees), on an order neither cancelled nor marked
// "no points", once it is fully paid and (for shipping) its package delivered. It earns on what was
// billed less what was paid with points, and a later reprice never earns again.
const mongoose = require('mongoose');
const Order = require('../../../models/order');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const { JournalEntry } = require('../../models');
const { postEntry } = require('../ledger');
const { getConfig } = require('../config');
const { resolveAccount } = require('../roles');
const { purchaseKey, shipmentKey, parseKey, CLAIM_EVENTS } = require('../claims/keys');
const { earnPoints, EXPIRY_DAYS, SOON_DAYS } = require('./rules');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOTS = ['earn', 'add', 'restore'];
const earnKey = (arKey) => `LOYALTY_EARN:${arKey}`;
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const ORDER_FIELDS = 'orderId user placedAt isRemittance isCanceled loyalty paymentList._id paymentList.status.received';

// Billed (net receivable from claim entries) and still owed, per claim key
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
    } },
  ]).session(session || null);
  return new Map(rows.map((row) => [row._id, { billed: row.billed, open: row.open }]));
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

const isEligibleOrder = (order) => !!order && !order.isCanceled && !order.loyalty?.noPoints;

// Where a claim stands: null (earns nothing), 'earned', or { points, waitingFor } where
// waitingFor is 'payment', 'delivery' or null (due now, the next run adds it)
function claimState({ arKey, order, ledger, redeemed, earned }) {
  const parsed = parseKey(arKey);
  if (!['purchase', 'shipment'].includes(parsed.kind) || parsed.domesticFee || parsed.customsFee) return null;
  if (!isEligibleOrder(order)) return null;
  const billed = ledger?.billed || 0;
  if (billed <= 0) return null;
  if (earned) return 'earned';
  const points = earnPoints(billed - (redeemed || 0), parsed.kind === 'purchase' && !!order.isRemittance);
  if (points <= 0) return null;
  if ((ledger.open || 0) > 0) return { points, waitingFor: 'payment' };
  if (parsed.kind === 'shipment') {
    const pkg = (order.paymentList || []).find((p) => String(p._id) === parsed.packageId);
    if (!pkg) return null;
    if (!pkg.status?.received) return { points, waitingFor: 'delivery' };
  }
  return { points, waitingFor: null };
}

const orderKeys = (order) => [purchaseKey(order._id), ...(order.paymentList || []).map((p) => shipmentKey(order._id, p._id))];

// Points on the way for some orders (one row per claim not yet earned)
async function pendingOf(orders, session) {
  const eligible = orders.filter(isEligibleOrder);
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

// The hourly job: earns every claim that became due, then (when accounting is live) posts the
// entries of earned points still without one (recorded while accounting was not live)
async function awardDue({ session, now = new Date() } = {}) {
  const { settings } = await getConfig();
  const ledger = await claimLedger({ $in: [/^PUR:/, /^SHP:/] }, session);
  const earned = new Set(await LoyaltyPoint.distinct('arKey', { kind: 'earn' }).session(session || null));
  const candidates = [...ledger].filter(([arKey, row]) => row.billed > 0 && row.open <= 0 && !earned.has(arKey)).map(([arKey]) => arKey);
  const orderIds = [...new Set(candidates.map((key) => parseKey(key).orderId).filter((id) => mongoose.isValidObjectId(id)))];
  const orders = new Map((await Order.find({ _id: { $in: orderIds } }).select(ORDER_FIELDS).session(session || null).lean())
    .map((order) => [String(order._id), order]));
  const redeemed = await redeemedOn(candidates, session);
  let awarded = 0;
  for (const arKey of candidates) {
    const order = orders.get(parseKey(arKey).orderId);
    const state = claimState({ arKey, order, ledger: ledger.get(arKey), redeemed: redeemed.get(arKey), earned: false });
    if (!state || state === 'earned' || state.waitingFor) continue;
    const eventKey = earnKey(arKey);
    if (await LoyaltyPoint.exists({ eventKey }).session(session || null)) continue;
    await LoyaltyPoint.create([{
      user: order.user, kind: 'earn', points: state.points, remaining: state.points, arKey, orderId: order._id,
      office: await officeOf(order), earnedAt: now, expiresAt: new Date(now.getTime() + EXPIRY_DAYS * DAY_MS), eventKey,
    }], { session });
    awarded += 1;
  }
  if (settings?.liveEnabled) {
    const unposted = await LoyaltyPoint.find({ kind: 'earn', journalEntryId: { $exists: false } }).sort({ _id: 1 }).session(session || null).lean();
    const numbers = new Map((await Order.find({ _id: { $in: unposted.map((m) => m.orderId).filter(Boolean) } }).select('orderId').session(session || null).lean())
      .map((order) => [String(order._id), order.orderId]));
    for (const movement of unposted) await postEarnEntry(movement, numbers.get(String(movement.orderId)), session);
  }
  return { awarded };
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

module.exports = { awardDue, summaryOf, orderLoyalty, claimLedger, claimState, earnKey };
