// Brings the ledger in line with an order (spec E6, E7, E11, E12, E13, E19, E20).
//
// Instead of one handler per kind of change, every change to an order (created, re-priced,
// items edited, package delivered, paid, cancelled, package removed, customer changed, trip
// cost added...) runs the same reconciliation: work out what the books SHOULD hold for each
// claim of the order, compare with what they DO hold, and post only the difference. Running it
// twice posts nothing the second time, which also makes the historical replay safe.
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const { postEntry } = require('../ledger');
const { resolveAccount } = require('../roles');
const { getConfig } = require('../config');
const { nextSeq } = require('../counter');
const { toMinor } = require('../money');
const { purchaseKey, shipmentKey, CLAIM_EVENTS } = require('./keys');

const oid = (value) => new mongoose.Types.ObjectId(String(value));

// Package charge in cents: weight x unit price (exiosPrice is per KG or CBM)
const packageCharge = (pkg) => toMinor(Number(pkg?.deliveredPackages?.weight?.total || 0) * Number(pkg?.deliveredPackages?.exiosPrice || 0), 2);

// Splits `total` over `weights` so the parts always add up to exactly `total`
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  const shares = sum > 0 ? weights.map((w) => (total * w) / sum) : weights.map(() => total / weights.length);
  const floored = shares.map((s) => Math.floor(s));
  let rest = total - floored.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - Math.floor(s), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floored[order[k][1]]++;
  return floored;
}

async function roleIds() {
  const roles = [
    'customer_receivable', 'deferred_shipping_revenue', 'deferred_purchase_revenue', 'trip_cost_wip', 'purchase_cost_wip',
    'revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'revenue_purchase_invoices',
    'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices',
    'revenue_remittance', 'cost_remittance',
  ];
  const accounts = {};
  for (const role of roles) accounts[role] = await resolveAccount(role);
  return accounts;
}

// The air or sea trip that carried a package (Order.paymentList[].tripId, spec 4.3). A domestic
// trip is not returned: it only tracks what was sent on, its cost is posted straight to expense.
async function internationalTrip(pkg, ctx) {
  if (!pkg?.tripId) return null;
  const key = String(pkg.tripId);
  if (!ctx.packageTrips.has(key)) {
    const trip = await Inventory.findById(pkg.tripId).select('shippingType status inventoryPlace inventoryType').session(ctx.session).lean();
    ctx.packageTrips.set(key, trip && trip.inventoryType === 'inventoryGoods' && trip.shippingType !== 'domestic' ? trip : null);
  }
  return ctx.packageTrips.get(key);
}

// How an air or sea trip's cost splits over its packages: by weight, always (owner's decision;
// air in KG, sea in CBM, one unit per trip). Packages of cancelled orders take no share; if no
// package has a weight the cost is split evenly.
async function tripAllocation(tripId, ctx) {
  const key = String(tripId);
  if (ctx.allocations.has(key)) return ctx.allocations.get(key);

  const trip = await Inventory.findById(tripId).select('shippingType inventoryType').session(ctx.session).lean();
  const international = trip && trip.inventoryType === 'inventoryGoods' && trip.shippingType !== 'domestic';
  let result = { total: 0, shares: new Map(), shippingType: trip?.shippingType };
  if (international) {
    const costAccounts = [ctx.accounts.trip_cost_wip, ctx.accounts.cost_shipping_air, ctx.accounts.cost_shipping_sea].map((a) => a._id);
    const [cost] = await JournalEntry.aggregate([
      { $match: { 'lines.tripId': oid(tripId) } },
      { $unwind: '$lines' },
      { $match: { 'lines.tripId': oid(tripId), 'lines.accountId': { $in: costAccounts } } },
      { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]).session(ctx.session);

    const orders = await Order.find({ 'paymentList.tripId': oid(tripId), isCanceled: { $ne: true } })
      .select('paymentList._id paymentList.tripId paymentList.deliveredPackages.weight').session(ctx.session).lean();
    const packages = [];
    orders.forEach((o) => (o.paymentList || []).forEach((p) => { if (String(p.tripId) === key) packages.push(p); }));
    const weights = packages.map((pkg) => Math.round(Number(pkg.deliveredPackages?.weight?.total || 0) * 1000));
    const shares = allocate(cost?.usd || 0, weights);
    result = { total: cost?.usd || 0, shares: new Map(packages.map((pkg, i) => [String(pkg._id), shares[i]])), shippingType: trip.shippingType };
  }
  ctx.allocations.set(key, result);
  return result;
}

// Everything the ledger holds for one order, in one pass
async function orderLedger(orderId, ctx) {
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.orderId': oid(orderId) } },
    { $unwind: '$lines' },
    { $match: { 'lines.orderId': oid(orderId) } },
    {
      $group: {
        _id: {
          arKey: '$lines.arKey', accountId: '$lines.accountId', partnerId: '$lines.partnerId',
          packageId: '$lines.packageId', tripId: '$lines.tripId', claim: { $in: ['$eventType', CLAIM_EVENTS] },
          refund: { $eq: ['$eventType', 'REFUND'] },
        },
        net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
      },
    },
  ]).session(ctx.session);

  const a = ctx.accounts;
  const is = (row, account) => String(row._id.accountId) === String(account._id);
  const revenueIds = new Set(['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'revenue_purchase_invoices', 'revenue_remittance'].map((r) => String(a[r]._id)));
  const shippingCostIds = new Set(['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic'].map((r) => String(a[r]._id)));

  const state = {
    ar: new Map(), arByPartner: new Map(), billed: new Map(), recognized: new Map(), refunded: new Map(),
    shipCost: new Map(), purchaseCostTotal: 0, purchaseCostRecognized: 0, remittanceCostRecognized: 0,
  };
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

  rows.forEach((row) => {
    const { arKey, partnerId, packageId, tripId, claim, refund } = row._id;
    if (is(row, a.customer_receivable) && arKey) {
      add(state.ar, arKey, row.net);
      if (!state.arByPartner.has(arKey)) state.arByPartner.set(arKey, new Map());
      add(state.arByPartner.get(arKey), String(partnerId || ''), row.net);
      if (claim) add(state.billed, arKey, row.net);
      // Money given back to the customer on this claim (a refund from the supplier, spec 19.6):
      // the customer is billed that much less
      if (refund) add(state.refunded, arKey, row.net);
    }
    if (arKey && revenueIds.has(String(row._id.accountId))) {
      if (!state.recognized.has(arKey)) state.recognized.set(arKey, new Map());
      add(state.recognized.get(arKey), String(row._id.accountId), -row.net);
    }
    if (shippingCostIds.has(String(row._id.accountId)) && packageId && tripId) {
      add(state.shipCost, `${packageId}|${tripId}`, row.net);
    }
    if (is(row, a.purchase_cost_wip) || is(row, a.cost_purchase_invoices) || is(row, a.cost_remittance)) {
      state.purchaseCostTotal += row.net;
      if (!is(row, a.purchase_cost_wip)) state.purchaseCostRecognized += row.net;
      if (is(row, a.cost_remittance)) state.remittanceCostRecognized += row.net;
    }
  });
  return state;
}

async function post(ctx, type, key, description, lines, fallbacks = []) {
  const seq = await nextSeq(`EV:${type}:${key}`, ctx.session);
  return postEntry({
    eventType: type,
    eventKey: `${type}:${key}:${seq}`,
    date: ctx.date,
    description,
    source: { model: 'Order', id: ctx.order._id },
    isHistorical: !!ctx.isHistorical,
    migrationRunId: ctx.migrationRunId,
    fallbacks,
    lines,
  }, { session: ctx.session, user: ctx.user });
}

// A line moving `amount` cents from `from` to `to` (debit `to`, credit `from`); negative flips it
const move = (amount, debitLine, creditLine) => (amount > 0
  ? [{ ...debitLine, debit: amount }, { ...creditLine, credit: amount }]
  : [{ ...creditLine, debit: -amount }, { ...debitLine, credit: -amount }]);

const revenueRoleFor = (pkg, trip, order) => {
  const method = trip?.shippingType || pkg?.deliveredPackages?.shipmentMethod || order.shipment?.method;
  if (method === 'air') return { role: 'revenue_shipping_air' };
  if (method === 'sea') return { role: 'revenue_shipping_sea' };
  return { role: 'revenue_other', fallback: 'طريقة شحن الطرد غير معروفة؛ سُجّل الإيراد في إيرادات أخرى' };
};

async function syncOrder(orderId, options = {}) {
  const { settings, offices } = await getConfig();
  if (!settings?.liveEnabled && !options.migration) return { skipped: 'live posting is off' };
  const ctx = {
    session: options.session,
    user: options.user,
    date: options.date || new Date(),
    isHistorical: !!options.isHistorical,
    migrationRunId: options.migrationRunId,
    settings,
    accounts: options.accounts || await roleIds(),
    allocations: options.allocations || new Map(),
    packageTrips: options.packageTrips || new Map(),
  };
  // The historical replay passes orderAt(orderId, date): the order as it was on that date
  // (delivered packages, invoice total, cancellation), not as it is today
  const order = options.orderAt
    ? await options.orderAt(orderId, ctx.date)
    : await Order.findById(orderId).session(ctx.session).lean();
  if (!order) return { skipped: 'order not found' };
  ctx.order = order;
  const a = ctx.accounts;
  const office = offices.has(order.placedAt) ? order.placedAt : settings.defaultOffice;
  const partnerId = order.user ? oid(order.user) : null;
  const tolerance = settings.recognitionToleranceCents ?? 200;
  const state = await orderLedger(order._id, ctx);
  // An unsure order (not confirmed) bills nothing, unless the customer paid on it: then it is a
  // real order and is billed like any other (it is listed for review in the exceptions)
  const paidOn = [...state.ar.values()].some((open) => open < 0);
  const active = !order.isCanceled && (!order.unsureOrder || paidOn);
  const posted = [];

  // ---- 1. Claims: what the customer is billed ----
  const desired = new Map();
  if (order.isPayment && active && Number(order.totalInvoice) > 0) desired.set(purchaseKey(order._id), toMinor(order.totalInvoice, 2));
  const packages = new Map((order.paymentList || []).map((pkg) => [String(pkg._id), pkg]));
  packages.forEach((pkg, id) => {
    const charge = active ? packageCharge(pkg) : 0;
    if (charge > 0) desired.set(shipmentKey(order._id, id), charge);
  });
  // A refund given to the customer on a claim lowers what they are billed (never below zero)
  state.refunded.forEach((refunded, key) => {
    if (desired.has(key)) desired.set(key, Math.max(desired.get(key) - refunded, 0));
  });
  const keys = new Set([...desired.keys(), ...state.billed.keys()]);

  for (const key of keys) {
    const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
    const want = desired.get(key) || 0;
    const have = state.billed.get(key) || 0;
    if (want === have || !partnerId) continue;
    const deferred = packageId ? a.deferred_shipping_revenue : a.deferred_purchase_revenue;
    const pkg = packageId && packages.get(packageId);
    const what = packageId ? `شحن ${pkg?.deliveredPackages?.trackingNumber || packageId}` : 'فاتورة شراء';
    const reason = !active ? 'إلغاء' : !have ? 'مطالبة' : want > have ? 'زيادة' : 'تخفيض';
    const dims = { arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }) };
    posted.push(await post(ctx, 'CLAIM', key, `${reason} ${what} - طلب ${order.orderId}`, move(
      want - have,
      { accountId: a.customer_receivable._id, partnerId, ...dims },
      { accountId: deferred._id, office, ...dims },
    )));
    state.billed.set(key, want);
    state.ar.set(key, (state.ar.get(key) || 0) + (want - have));
    if (!state.arByPartner.has(key)) state.arByPartner.set(key, new Map());
    const byPartner = state.arByPartner.get(key);
    byPartner.set(String(partnerId), (byPartner.get(String(partnerId)) || 0) + (want - have));
  }

  // ---- 2. A claim follows its order when the customer changes ----
  if (partnerId) {
    for (const [key, byPartner] of state.arByPartner) {
      for (const [other, balance] of byPartner) {
        if (!balance || other === String(partnerId) || !other) continue;
        const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
        const dims = { arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }) };
        posted.push(await post(ctx, 'RECLASS_PARTNER', key, `نقل مطالبة طلب ${order.orderId} إلى عميله الحالي`, move(
          balance,
          { accountId: a.customer_receivable._id, partnerId, ...dims },
          { accountId: a.customer_receivable._id, partnerId: oid(other), ...dims },
        )));
      }
    }
  }

  // ---- 3. Revenue: recognised when paid (and, for a package, delivered) ----
  const recognizedNow = new Map();
  for (const key of keys) {
    const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
    const pkg = packageId && packages.get(packageId);
    const billed = state.billed.get(key) || 0;
    const paid = (state.ar.get(key) || 0) <= tolerance;
    const delivered = packageId ? !!pkg?.status?.received : true;
    const want = billed > 0 && paid && delivered ? billed : 0;
    const byAccount = state.recognized.get(key) || new Map();
    const have = [...byAccount.values()].reduce((s, v) => s + v, 0);
    recognizedNow.set(key, want);
    if (want === have) continue;

    const deferred = packageId ? a.deferred_shipping_revenue : a.deferred_purchase_revenue;
    const dims = { arKey: key, orderId: order._id, office, ...(packageId && { packageId: oid(packageId) }) };
    const fallbacks = [];
    let revenueAccount;
    if (want > have) {
      if (packageId) {
        const { role, fallback } = revenueRoleFor(pkg, await internationalTrip(pkg, ctx), order);
        revenueAccount = a[role];
        if (fallback) fallbacks.push(fallback);
        // The historical replay had to guess this package's delivery date (spec 6-أ.5)
        const dateFallback = options.deliveries?.get(String(packageId))?.fallback;
        if (dateFallback) fallbacks.push(dateFallback);
      } else {
        // A purchase invoice marked as an Alipay transfer is remittance revenue (spec 19.5)
        revenueAccount = order.isRemittance ? a.revenue_remittance : a.revenue_purchase_invoices;
      }
    } else {
      // Taking revenue back: from the account that holds it
      const [accountId] = [...byAccount.entries()].sort((x, y) => y[1] - x[1])[0] || [];
      revenueAccount = { _id: accountId ? oid(accountId) : (packageId ? a.revenue_other._id : a.revenue_purchase_invoices._id) };
    }
    const what = packageId ? `شحن ${pkg?.deliveredPackages?.trackingNumber || packageId}` : 'فاتورة شراء';
    posted.push(await post(ctx, 'RECOGNITION', key, `${want > have ? 'الاعتراف بإيراد' : 'عكس الاعتراف بإيراد'} ${what} - طلب ${order.orderId}`, move(
      want - have,
      { accountId: deferred._id, ...dims },
      { accountId: revenueAccount._id, ...dims },
    ), fallbacks));
  }

  // ---- 4. Costs follow their revenue ----
  const purchaseRecognized = recognizedNow.get(purchaseKey(order._id)) > 0;
  const purchaseWant = purchaseRecognized ? state.purchaseCostTotal : 0;
  if (purchaseWant !== state.purchaseCostRecognized) {
    const dims = { orderId: order._id, office, arKey: purchaseKey(order._id) };
    // New cost follows the order's kind; cost taken back leaves the account that holds it
    const costAccount = purchaseWant > state.purchaseCostRecognized
      ? (order.isRemittance ? a.cost_remittance : a.cost_purchase_invoices)
      : (state.remittanceCostRecognized > 0 ? a.cost_remittance : a.cost_purchase_invoices);
    posted.push(await post(ctx, 'COST_RECOGNITION', purchaseKey(order._id), `تكلفة فاتورة شراء - طلب ${order.orderId}`, move(
      purchaseWant - state.purchaseCostRecognized,
      { accountId: costAccount._id, ...dims },
      { accountId: a.purchase_cost_wip._id, ...dims },
    )));
  }

  const packageIds = new Set([...packages.keys(), ...[...state.shipCost.keys()].map((k) => k.split('|')[0])]);
  for (const packageId of packageIds) {
    const recognized = recognizedNow.get(shipmentKey(order._id, packageId)) > 0;
    const trip = await internationalTrip(packages.get(packageId), ctx);
    const tripIds = new Set([...(trip ? [String(trip._id)] : []), ...[...state.shipCost.keys()].filter((k) => k.startsWith(`${packageId}|`)).map((k) => k.split('|')[1])]);
    for (const tripId of tripIds) {
      const allocation = await tripAllocation(tripId, ctx);
      const want = recognized ? (allocation.shares.get(packageId) || 0) : 0;
      const have = state.shipCost.get(`${packageId}|${tripId}`) || 0;
      if (want === have) continue;
      const role = allocation.shippingType === 'sea' ? 'cost_shipping_sea' : allocation.shippingType === 'domestic' ? 'cost_shipping_domestic' : 'cost_shipping_air';
      const dims = { tripId: oid(tripId), packageId: oid(packageId), orderId: order._id, office };
      const tracking = packages.get(packageId)?.deliveredPackages?.trackingNumber || packageId;
      posted.push(await post(ctx, 'COST_RECOGNITION', `${packageId}:${tripId}`, `حصة الطرد ${tracking} من تكلفة الرحلة - طلب ${order.orderId}`, move(
        want - have,
        { accountId: a[role]._id, ...dims },
        { accountId: a.trip_cost_wip._id, ...dims },
      )));
    }
  }

  return { posted: posted.length };
}

// After a trip's costs or packages change: every order on it gets its cost shares re-checked
async function syncTrip(tripId, options = {}) {
  const { settings } = await getConfig();
  if (!settings?.liveEnabled && !options.migration) return { skipped: 'live posting is off' };
  const trip = await Inventory.findById(tripId).select('inventoryType').session(options.session || null).lean();
  // Warehouses only track packages; they never carry costs (spec 4.3)
  if (trip && trip.inventoryType !== 'inventoryGoods') return { skipped: 'not a trip' };
  const withCost = await JournalEntry.distinct('lines.orderId', { 'lines.tripId': oid(tripId), eventType: 'COST_RECOGNITION' }).session(options.session || null);
  const orders = await Order.find({ $or: [{ 'paymentList.tripId': oid(tripId) }, { 'paymentList.domesticTripId': oid(tripId) }] })
    .select('_id').session(options.session || null).lean();
  const orderIds = [...new Set([...orders.map((o) => String(o._id)), ...withCost.filter(Boolean).map(String)])];
  const shared = { ...options, accounts: await roleIds(), allocations: new Map(), packageTrips: new Map() };
  let posted = 0;
  for (const orderId of orderIds) posted += (await syncOrder(orderId, shared)).posted || 0;
  return { posted, orders: orderIds.length };
}

module.exports = { syncOrder, syncTrip, allocate, packageCharge };
