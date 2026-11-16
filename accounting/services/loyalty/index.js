// Loyalty points: earning on paid claims, balance and points on the way (spec 2026-11-16).
// A claim earns once: a shipping claim `SHP:<order>:<package>` or a purchase claim `PUR:<order>`
// (never the package's transport or customs fees), on an order neither cancelled nor marked
// "no points", once it is fully paid and (for shipping) its package delivered. It earns on what was
// billed less what was written off and what was paid with points, and a later reprice never earns
// again. Only orders placed on or after LOYALTY_START_DATE take part.
const mongoose = require('mongoose');
const Order = require('../../../models/order');
const LoyaltyPoint = require('../../../models/loyaltyPoint');
const PricingConfig = require('../../../models/pricingConfig');
const { JournalEntry } = require('../../models');
const { postEntry, reverseEntry } = require('../ledger');
const { getConfig } = require('../config');
const { runInTransaction, assertInTransaction } = require('../transaction');
const ErrorHandler = require('../../../utils/errorHandler');
const { lockWalletOwner } = require('../../../utils/walletLock');
const { lockClaimAllocations } = require('../claims/locks');
const { syncOrder } = require('../claims/sync');
const { openBalances, resolveClaimKeys, splitOverClaims, claimLines } = require('../posting/operations');
const { resolveAccount } = require('../roles');
const { purchaseKey, shipmentKey, parseKey, CLAIM_EVENTS } = require('../claims/keys');
const { earnPoints, redeemCap, takeOldest, EXPIRY_DAYS, SOON_DAYS } = require('./rules');

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
    earned: Math.max(sum('earn') - sum('revoke'), 0),
    pending,
    redeemed: Math.max(sum('redeem') - sum('restore'), 0),
    noPoints: order?.loyalty?.noPoints ? { reason: order.loyalty.reason || '' } : null,
  };
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
  const maxPoints = Math.max(Math.min(balance, owedCents, redeemCap(billedCents, usedOnTarget)), 0);
  return { lots, quote: { balance, maxPoints, owedCents, billedCents, usedOnTarget } };
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
async function reverseRedemption(redemption, session) {
  const entry = await JournalEntry.findById(redemption.journalEntryId).select('eventKey').session(session).lean();
  const key = String(entry?.eventKey || `LOYALTY_REDEEM:${redemption._id}`).replace(/^LOYALTY_REDEEM:/, 'LOYALTY_RESTORE:');
  return reverseEntry(redemption.journalEntryId, { session, eventKey: key, eventType: 'LOYALTY_RESTORE', reason: 'إلغاء الطلبية: إرجاع النقاط' });
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
  for (const redemption of redemptions) {
    // ObjectId hex needs no escaping
    if (await LoyaltyPoint.exists({ eventKey: { $regex: `^${restorePrefix(redemption._id)}` } }).session(session)) continue;
    // The redemption entry is reversed at once (it was posted live), even if accounting is off now
    const reversal = redemption.journalEntryId ? await reverseRedemption(redemption, session) : null;
    for (const source of redemption.sources || []) {
      const lot = await LoyaltyPoint.findById(source.lotId).select('expiresAt').session(session).lean();
      if (!lot?.expiresAt) throw new Error(`Loyalty lot ${source.lotId} not found`);
      const [back] = await LoyaltyPoint.create([{
        user: redemption.user, kind: 'restore', points: source.points, remaining: source.points, arKey: redemption.arKey,
        orderId: redemption.orderId, office: redemption.office, earnedAt: now, expiresAt: lot.expiresAt,
        eventKey: `${restorePrefix(redemption._id)}${source.lotId}`, ...(reversal && { journalEntryId: reversal._id }),
      }], { session });
      if (lot.expiresAt <= now) await takeBackLot(back._id, 'expire', session);
    }
    restored += 1;
  }
  return restored;
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
      pipeline: [{ $project: { customerId: 1, phone: 1, firstName: 1, lastName: 1 } }] } },
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
    })),
    total: result?.count?.[0]?.total || 0,
  };
}

// What each kind of movement does to the balance
const GAIN_KINDS = ['earn', 'add', 'restore'];
const signedPoints = (m) => (GAIN_KINDS.includes(m.kind) ? m.points : -m.points);

// A customer's movements, newest first, with the order number, the reason and the balance right
// after each one (every movement walked oldest first, so it is right on any page; pages from 1)
async function historyOf(userId, { page, limit } = {}) {
  const paging = pageOf({ page, limit });
  if (!userId || !mongoose.isValidObjectId(userId)) return { rows: [], total: 0 };
  const filter = { user: oid(userId) };
  const [movements, all] = await Promise.all([
    LoyaltyPoint.find(filter).select('kind points orderId reason createdAt expiresAt')
      .sort({ createdAt: -1, _id: -1 }).skip((paging.page - 1) * paging.limit).limit(paging.limit).lean(),
    LoyaltyPoint.find(filter).select('kind points').sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const total = all.length;
  const balanceAfter = new Map();
  let running = 0;
  for (const m of all) {
    running += signedPoints(m);
    balanceAfter.set(String(m._id), running);
  }
  const orderIds = [...new Set(movements.filter((m) => m.orderId).map((m) => String(m.orderId)))];
  const numbers = new Map((await Order.find({ _id: { $in: orderIds } }).setOptions({ withDeleted: true }).select('orderId').lean())
    .map((o) => [String(o._id), o.orderId]));
  return {
    rows: movements.map((m) => ({
      kind: m.kind,
      points: m.points,
      orderId: m.orderId,
      orderNumber: m.orderId ? numbers.get(String(m.orderId)) : undefined,
      reason: m.reason,
      createdAt: m.createdAt,
      expiresAt: LOTS.includes(m.kind) ? m.expiresAt : undefined,
      balanceAfter: balanceAfter.get(String(m._id)) ?? 0,
    })),
    total,
  };
}

// The points of each of a customer's orders, for the orders list: { [orderId]: { earned, pending } }
// for the orders that earned (earn less revoke) or have points on the way (as in summaryOf)
async function ordersPointsOf(userId) {
  if (!userId || !mongoose.isValidObjectId(userId)) return {};
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
  awardDue, summaryOf, orderLoyalty, redeemQuote, redeem, packagesQuote, redeemPackages, pointsPaidOnPackages, expireDue, settleOrders, setNoPoints,
  adjust, customersWithPoints, historyOf, ordersPointsOf, HISTORY_PAGE_SIZE,
  claimLedger, claimState, earnKey, loyaltyStartDate,
};
