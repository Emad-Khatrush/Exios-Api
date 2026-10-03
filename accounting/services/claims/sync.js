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
const { postEntry, reverseEntry } = require('../ledger');
const { resolveAccount } = require('../roles');
const { getConfig } = require('../config');
const { nextSeq } = require('../counter');
const { toMinor } = require('../money');
const { purchaseKey, shipmentKey, isDomesticFeeKey, customsFeeKey, isCustomsFeeKey, PACKAGE_FEES, CLAIM_EVENTS } = require('./keys');

const oid = (value) => new mongoose.Types.ObjectId(String(value));

// Package charge in cents: weight x unit price (exiosPrice is per KG or CBM), as the system bills it
const packageCharge = (pkg) => require('./keys').packageChargeCents(pkg);

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
    'revenue_remittance', 'cost_remittance', 'rounding', 'revenue_customs', 'cost_customs', 'customs_cost_wip',
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

// How a trip's cost splits over its packages: by chargeable weight, always (owner's decision; air
// in KG, sea in CBM, one unit per trip). A domestic trip's cost splits over the packages it took on
// (their domesticTripId). Packages of cancelled orders take no share; if no package has a weight
// the cost is split evenly.
async function tripAllocation(tripId, ctx) {
  const key = String(tripId);
  if (ctx.allocations.has(key)) return ctx.allocations.get(key);

  const trip = await Inventory.findById(tripId).select('shippingType inventoryType').session(ctx.session).lean();
  const isTrip = trip && trip.inventoryType === 'inventoryGoods';
  const domestic = isTrip && trip.shippingType === 'domestic';
  const link = domestic ? 'domesticTripId' : 'tripId';
  let result = { total: 0, shares: new Map(), shippingType: trip?.shippingType };
  if (isTrip) {
    // Free packages' shares sit on the purchase cost with the trip's id (step 4)
    const costAccounts = [ctx.accounts.trip_cost_wip, ctx.accounts.cost_shipping_air, ctx.accounts.cost_shipping_sea, ctx.accounts.cost_shipping_domestic, ctx.accounts.cost_purchase_invoices].map((a) => a._id);
    const [cost] = await JournalEntry.aggregate([
      { $match: { 'lines.tripId': oid(tripId) } },
      { $unwind: '$lines' },
      { $match: { 'lines.tripId': oid(tripId), 'lines.accountId': { $in: costAccounts } } },
      { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]).session(ctx.session);

    const orders = await Order.find({ [`paymentList.${link}`]: oid(tripId), isCanceled: { $ne: true } })
      .select(`paymentList._id paymentList.${link} paymentList.deliveredPackages.weight`).session(ctx.session).lean();
    const packages = [];
    orders.forEach((o) => (o.paymentList || []).forEach((p) => { if (String(p[link]) === key) packages.push(p); }));
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
          // A refund or a write-off that was cancelled no longer counts (its reversal is a CANCEL)
          refund: { $and: [{ $eq: ['$eventType', 'REFUND'] }, { $ne: ['$status', 'reversed'] }] },
          writeOff: { $and: [{ $in: ['$eventType', ['CLAIM_WRITEOFF', 'WRITEOFF_RECOVERY']] }, { $ne: ['$status', 'reversed'] }] },
        },
        net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
      },
    },
  ]).session(ctx.session);

  const a = ctx.accounts;
  const is = (row, account) => String(row._id.accountId) === String(account._id);
  const revenueIds = new Set(['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'revenue_purchase_invoices', 'revenue_remittance', 'revenue_customs'].map((r) => String(a[r]._id)));
  const shippingCostIds = new Set(['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic'].map((r) => String(a[r]._id)));

  const state = {
    ar: new Map(), arByPartner: new Map(), billed: new Map(), recognized: new Map(), refunded: new Map(), writtenOff: new Map(),
    shipCost: new Map(), customsCost: new Map(), purchaseCostTotal: 0, purchaseCostRecognized: 0, remittanceCostRecognized: 0,
  };
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

  rows.forEach((row) => {
    const { arKey, partnerId, packageId, tripId, claim, refund, writeOff } = row._id;
    if (is(row, a.customer_receivable) && arKey) {
      add(state.ar, arKey, row.net);
      if (!state.arByPartner.has(arKey)) state.arByPartner.set(arKey, new Map());
      add(state.arByPartner.get(arKey), String(partnerId || ''), row.net);
      if (claim) add(state.billed, arKey, row.net);
      // Money given back to the customer on this claim (a refund from the supplier, spec 19.6):
      // the customer is billed that much less
      if (refund) add(state.refunded, arKey, row.net);
      // What is written off and not yet taken back by a later payment
      if (writeOff) add(state.writtenOff, arKey, -row.net);
    }
    if (arKey && revenueIds.has(String(row._id.accountId))) {
      if (!state.recognized.has(arKey)) state.recognized.set(arKey, new Map());
      add(state.recognized.get(arKey), String(row._id.accountId), -row.net);
    }
    // The clearing agent's invoice for a package: waiting, then cost of sales (step 4)
    if (packageId && (is(row, a.customs_cost_wip) || is(row, a.cost_customs))) {
      const item = state.customsCost.get(String(packageId)) || { total: 0, recognized: 0 };
      item.total += row.net;
      if (is(row, a.cost_customs)) item.recognized += row.net;
      state.customsCost.set(String(packageId), item);
      return;
    }
    // A package's share of a trip; a free package's share sits on the purchase cost (see step 4)
    const tripShare = packageId && tripId && (shippingCostIds.has(String(row._id.accountId)) || is(row, a.cost_purchase_invoices));
    if (tripShare) {
      add(state.shipCost, `${packageId}|${tripId}`, row.net);
    } else if (is(row, a.purchase_cost_wip) || is(row, a.cost_purchase_invoices) || is(row, a.cost_remittance)) {
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
    : await Order.findById(orderId).setOptions({ withDeleted: true }).session(ctx.session).lean();
  if (!order) return { skipped: 'order not found' };
  ctx.order = order;
  const a = ctx.accounts;
  const office = offices.has(order.placedAt) ? order.placedAt : settings.defaultOffice;
  const partnerId = order.user ? oid(order.user) : null;
  const tolerance = settings.recognitionToleranceCents ?? 200;
  const state = await orderLedger(order._id, ctx);
  // An unsure (unconfirmed) order bills nothing and earns nothing, even when something was paid
  // on it: that payment stays the customer's credit on the order, listed for review, until the
  // order is confirmed or the payment corrected (owner's decision 2026-10-02)
  const active = !order.isCanceled && !order.unsureOrder;
  const posted = [];

  // ---- 1. Claims: what the customer is billed ----
  const desired = new Map();
  if (order.isPayment && active && Number(order.totalInvoice) > 0) desired.set(purchaseKey(order._id), toMinor(order.totalInvoice, 2));
  const packages = new Map((order.paymentList || []).map((pkg) => [String(pkg._id), pkg]));
  packages.forEach((pkg, id) => {
    const charge = active ? packageCharge(pkg) : 0;
    if (charge > 0) desired.set(shipmentKey(order._id, id), charge);
    // The transport fee to another office and the customs clearance: each its own claim beside the
    // shipping (spec v8; owner's request 2026-10-03)
    PACKAGE_FEES.forEach(({ field, key }) => {
      const fee = active ? toMinor(Number(pkg?.deliveredPackages?.[field]?.usd || 0), 2) : 0;
      if (fee > 0) desired.set(key(order._id, id), fee);
    });
  });
  // A refund given to the customer on a claim lowers what they are billed (never below zero)
  state.refunded.forEach((refunded, key) => {
    if (desired.has(key)) desired.set(key, Math.max(desired.get(key) - refunded, 0));
  });
  // A package declared abandoned (spec v8): the customer is billed only what was paid on it. The
  // unpaid part leaves the receivable against the deferred revenue, the paid part is recognised as
  // if delivered, and its whole cost goes to cost of sales. The wallet is not touched.
  const abandoned = new Set([...packages].filter(([, p]) => p?.deliveredPackages?.abandoned?.status).map(([id]) => id));
  if (active) {
    abandoned.forEach((id) => [shipmentKey(order._id, id), ...PACKAGE_FEES.map(({ key }) => key(order._id, id))].forEach((key) => {
      if (!desired.has(key)) return;
      const paidSoFar = Math.max((state.billed.get(key) || 0) - (state.ar.get(key) || 0), 0);
      desired.set(key, Math.min(desired.get(key), paidSoFar));
    }));
  }
  const keys = new Set([...desired.keys(), ...state.billed.keys()]);

  for (const key of keys) {
    const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
    const want = desired.get(key) || 0;
    const have = state.billed.get(key) || 0;
    if (want === have || !partnerId) continue;
    const deferred = packageId ? a.deferred_shipping_revenue : a.deferred_purchase_revenue;
    const pkg = packageId && packages.get(packageId);
    const fee = isDomesticFeeKey(key);
    const what = packageId ? `${fee ? 'نقل داخلي' : isCustomsFeeKey(key) ? 'تخليص جمركي' : 'شحن'} ${pkg?.deliveredPackages?.trackingNumber || packageId}` : 'فاتورة شراء';
    const reason = !active ? 'إلغاء' : !have ? 'مطالبة' : want > have ? 'زيادة' : 'تخفيض';
    const dims = { arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }), ...(fee && pkg?.domesticTripId && { tripId: oid(pkg.domesticTripId) }) };
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
  // (from A000 to the real customer, spec 19.10): every entry that put the claim or a payment on
  // the old customer is reversed and posted again for the new one on its own date, both hidden,
  // so the order reads as if it had been entered for the new customer from the start. Whatever
  // that leaves on the old customer is moved by one entry dated today.
  // (a paid claim nets to zero on the old customer but its entries still move)
  if (partnerId && [...state.arByPartner.values()].some((byPartner) => [...byPartner.keys()].some((other) => other && other !== String(partnerId)))) {
    const moved = await repartnerEntries(order, partnerId, ctx);
    posted.push(...moved);
    if (moved.length) {
      const fresh = await orderLedger(order._id, ctx);
      state.arByPartner = fresh.arByPartner;
    }
  }
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

  // ---- 2b. A payment on a written-off claim takes the write-off back (spec 19.7): the claim is
  // owed again by what was paid, so the payment settles it and the revenue rises by it
  if (active) {
    for (const [key, written] of state.writtenOff) {
      const over = -(state.ar.get(key) || 0);
      const back = Math.min(written, over);
      if (!(back > 0) || !partnerId) continue;
      const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
      const deferred = packageId ? a.deferred_shipping_revenue : a.deferred_purchase_revenue;
      const dims = { arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }) };
      posted.push(await post(ctx, 'WRITEOFF_RECOVERY', key, `دفعة بعد الشطب - طلب ${order.orderId}`, move(
        back, { accountId: a.customer_receivable._id, partnerId, ...dims }, { accountId: deferred._id, office, ...dims },
      )));
      state.writtenOff.set(key, written - back);
      state.ar.set(key, (state.ar.get(key) || 0) + back);
    }
  }

  // ---- 2c. Rounding (spec 2.5): a claim that was paid and is left a few cents over or under,
  // because a payment covered several packages or dinars were turned into dollars at the payment's
  // rate, is closed against the rounding account, so the customer owes nothing and has no credit
  const ROUNDING_CENTS = 5;
  if (active && partnerId) {
    for (const key of keys) {
      const open = state.ar.get(key) || 0;
      const paidOn = (state.billed.get(key) || 0) - open - Math.max(state.writtenOff.get(key) || 0, 0);
      if (!open || Math.abs(open) > ROUNDING_CENTS || paidOn <= 0) continue;
      const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
      const dims = { arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }) };
      posted.push(await post(ctx, 'ROUNDING', key, `فرق تقريب - طلب ${order.orderId}`, move(
        -open, { accountId: a.customer_receivable._id, partnerId, ...dims }, { accountId: a.rounding._id, office, ...dims },
      )));
      state.ar.set(key, 0);
    }
  }

  // ---- 2d. An order marked (or unmarked) "Alipay transfer" after its revenue or cost was
  // recognised: what was recognised moves to the accounts of its kind, so the Alipay screen and
  // the purchase invoices each show their own revenue and cost (spec 19.5)
  // (a negative amount too: a supplier refund bigger than the cost recorded leaves a negative cost)
  if (order.isPayment) {
    const key = purchaseKey(order._id);
    const [revenueTo, revenueFrom] = order.isRemittance ? [a.revenue_remittance, a.revenue_purchase_invoices] : [a.revenue_purchase_invoices, a.revenue_remittance];
    const byAccount = state.recognized.get(key);
    const misplaced = byAccount?.get(String(revenueFrom._id)) || 0;
    if (misplaced !== 0) {
      const dims = { arKey: key, orderId: order._id, office };
      posted.push(await post(ctx, 'RECLASS', key, `نقل إيراد فاتورة شراء ${order.isRemittance ? 'إلى حوالات Alipay' : 'من حوالات Alipay'} - طلب ${order.orderId}`, move(
        misplaced, { accountId: revenueFrom._id, ...dims }, { accountId: revenueTo._id, ...dims },
      )));
      byAccount.set(String(revenueFrom._id), 0);
      byAccount.set(String(revenueTo._id), (byAccount.get(String(revenueTo._id)) || 0) + misplaced);
    }
    const costMisplaced = order.isRemittance ? state.purchaseCostRecognized - state.remittanceCostRecognized : state.remittanceCostRecognized;
    if (costMisplaced !== 0) {
      const [costTo, costFrom] = order.isRemittance ? [a.cost_remittance, a.cost_purchase_invoices] : [a.cost_purchase_invoices, a.cost_remittance];
      const dims = { orderId: order._id, office, arKey: key };
      posted.push(await post(ctx, 'RECLASS', `${key}:COST`, `نقل تكلفة فاتورة شراء ${order.isRemittance ? 'إلى حوالات Alipay' : 'من حوالات Alipay'} - طلب ${order.orderId}`, move(
        costMisplaced, { accountId: costTo._id, ...dims }, { accountId: costFrom._id, ...dims },
      )));
      state.remittanceCostRecognized = order.isRemittance ? state.purchaseCostRecognized : 0;
    }
  }

  // ---- 3. Revenue: recognised when paid (and, for a package, delivered) ----
  // A written-off claim counts as settled; its revenue is only what was paid
  const recognizedNow = new Map();
  const writtenOffKeys = new Set();
  for (const key of keys) {
    const packageId = key.startsWith('SHP:') ? key.split(':')[2] : null;
    const pkg = packageId && packages.get(packageId);
    const written = active ? Math.max(state.writtenOff.get(key) || 0, 0) : 0;
    if (written > 0) writtenOffKeys.add(key);
    const billed = (state.billed.get(key) || 0) - written;
    const paid = (state.ar.get(key) || 0) <= tolerance;
    const delivered = packageId ? !!pkg?.status?.received || (active && abandoned.has(packageId)) : true;
    // A package: all of it once delivered and paid in full. A purchase invoice: what has been paid
    // so far (the instalment method, owner's decision in v8), all of it once paid in full; its cost
    // follows in the same proportion below
    const open = Math.max(state.ar.get(key) || 0, 0);
    const want = billed <= 0 || !delivered ? 0 : paid ? billed : (packageId ? 0 : Math.max(billed - open, 0));
    if (packageId && active && abandoned.has(packageId)) writtenOffKeys.add(shipmentKey(order._id, packageId));
    const byAccount = state.recognized.get(key) || new Map();
    const have = [...byAccount.values()].reduce((s, v) => s + v, 0);
    recognizedNow.set(key, want);
    if (want === have) continue;

    const deferred = packageId ? a.deferred_shipping_revenue : a.deferred_purchase_revenue;
    const dims = { arKey: key, orderId: order._id, office, ...(packageId && { packageId: oid(packageId) }), ...(isDomesticFeeKey(key) && pkg?.domesticTripId && { tripId: oid(pkg.domesticTripId) }) };
    const fallbacks = [];
    let revenueAccount;
    if (want > have) {
      if (isDomesticFeeKey(key)) {
        // The transport fee: domestic shipping revenue
        revenueAccount = a.revenue_shipping_domestic;
      } else if (isCustomsFeeKey(key)) {
        // The customs clearance sold with the package (owner's request 2026-10-03)
        revenueAccount = a.revenue_customs;
      } else if (packageId) {
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
    const what = packageId ? `${isDomesticFeeKey(key) ? 'نقل داخلي' : isCustomsFeeKey(key) ? 'تخليص جمركي' : 'شحن'} ${pkg?.deliveredPackages?.trackingNumber || packageId}` : 'فاتورة شراء';
    posted.push(await post(ctx, 'RECOGNITION', key, `${want > have ? 'الاعتراف بإيراد' : 'عكس الاعتراف بإيراد'} ${what} - طلب ${order.orderId}`, move(
      want - have,
      { accountId: deferred._id, ...dims },
      { accountId: revenueAccount._id, ...dims },
    ), fallbacks));
  }

  // ---- 4. Costs follow their revenue ----
  // The whole cost of a written-off claim is recognised, even when nothing of it was paid
  // The purchase cost is recognised in the proportion of the invoice recognised (all of it once
  // paid in full, or when the claim is written off)
  const purchaseBilled = state.billed.get(purchaseKey(order._id)) || 0;
  const purchaseShare = writtenOffKeys.has(purchaseKey(order._id)) ? 1
    : purchaseBilled > 0 ? Math.min((recognizedNow.get(purchaseKey(order._id)) || 0) / purchaseBilled, 1) : 0;
  const purchaseWant = Math.round(state.purchaseCostTotal * purchaseShare);
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
    const pkg = packages.get(packageId);
    // Free shipping (owner's offer with purchases, 2026-10-03): the package is weighed but priced at
    // zero, so it has no revenue to wait for. Its share of the trip is a cost of the order once
    // delivered: of the purchase invoice when the order has one, else of the shipping
    const free = active && !!pkg && !!pkg.status?.received && packageCharge(pkg) === 0 && Number(pkg.deliveredPackages?.weight?.total) > 0;
    const recognized = free || recognizedNow.get(shipmentKey(order._id, packageId)) > 0 || writtenOffKeys.has(shipmentKey(order._id, packageId));
    const trip = await internationalTrip(pkg, ctx);
    // The air or sea trip that carried it, and the domestic trip that took it on (spec v8)
    const tripIds = new Set([
      ...(trip ? [String(trip._id)] : []), ...(pkg?.domesticTripId ? [String(pkg.domesticTripId)] : []),
      ...[...state.shipCost.keys()].filter((k) => k.startsWith(`${packageId}|`)).map((k) => k.split('|')[1]),
    ]);
    for (const tripId of tripIds) {
      const allocation = await tripAllocation(tripId, ctx);
      const want = recognized ? (allocation.shares.get(packageId) || 0) : 0;
      const have = state.shipCost.get(`${packageId}|${tripId}`) || 0;
      if (want === have) continue;
      const shippingRole = allocation.shippingType === 'sea' ? 'cost_shipping_sea' : allocation.shippingType === 'domestic' ? 'cost_shipping_domestic' : 'cost_shipping_air';
      const role = free && order.isPayment ? 'cost_purchase_invoices' : shippingRole;
      const dims = { tripId: oid(tripId), packageId: oid(packageId), orderId: order._id, office };
      const tracking = packages.get(packageId)?.deliveredPackages?.trackingNumber || packageId;
      posted.push(await post(ctx, 'COST_RECOGNITION', `${packageId}:${tripId}`, `حصة الطرد ${tracking} من تكلفة الرحلة${free ? ' (شحن مجاني)' : ''} - طلب ${order.orderId}`, move(
        want - have,
        { accountId: a[role]._id, ...dims },
        { accountId: a.trip_cost_wip._id, ...dims },
      )));
    }
  }

  // The clearing agent's invoice of a package follows the customs clearance it sold: cost of sales
  // once that is recognised (delivered and paid in full) or written off. Cleared but sold to nobody
  // (no fee on the package), it is a cost once the package is delivered. A cancelled order keeps it
  // waiting, like a purchase cost, until the accountant settles it.
  for (const [packageId, cost] of state.customsCost) {
    const pkg = packages.get(packageId);
    const key = customsFeeKey(order._id, packageId);
    const sold = (state.billed.get(key) || 0) > 0;
    const recognized = active && (recognizedNow.get(key) > 0 || writtenOffKeys.has(key) || (!sold && !!pkg?.status?.received));
    const want = recognized ? cost.total : 0;
    if (want === cost.recognized) continue;
    const dims = { orderId: order._id, packageId: oid(packageId), office, arKey: key };
    posted.push(await post(ctx, 'COST_RECOGNITION', key, `تكلفة تخليص جمركي ${pkg?.deliveredPackages?.trackingNumber || packageId} - طلب ${order.orderId}`, move(
      want - cost.recognized,
      { accountId: a.cost_customs._id, ...dims },
      { accountId: a.customs_cost_wip._id, ...dims },
    )));
  }

  if (!active) await hideCancelledClaims(order._id, ctx);
  return { posted: posted.length };
}

// Re-posts on the order's current customer every entry that holds one of its claims on another
// customer: a reversal of the original (on its date, or the first open day) and a copy with the
// receivable lines of this order moved to the new customer. The other lines (a wallet paid from)
// stay as they were; moving the old customer's wallet line is the staff member's choice.
async function repartnerEntries(order, partnerId, ctx) {
  const a = ctx.accounts;
  const entries = await JournalEntry.find({
    status: 'posted', reversalOf: null,
    lines: { $elemMatch: { orderId: order._id, accountId: a.customer_receivable._id, partnerId: { $nin: [partnerId, null] } } },
  }).sort({ day: 1, createdAt: 1 }).session(ctx.session);
  const posted = [];
  for (const entry of entries) {
    const isMoved = (line) => String(line.orderId) === String(order._id) && String(line.accountId) === String(a.customer_receivable._id)
      && line.partnerId && String(line.partnerId) !== String(partnerId);
    const reversal = await reverseEntry(entry._id, {
      session: ctx.session, user: ctx.user, reason: `نقل الطلب ${order.orderId} إلى عميله الحالي`,
      eventKey: `REPARTNER_REVERSE:${entry._id}`, eventType: entry.eventType,
      migrationRunId: ctx.migrationRunId, isHistorical: ctx.isHistorical,
    });
    const copy = await postEntry({
      journalId: entry.journalId,
      eventType: entry.eventType,
      eventKey: `REPARTNER:${entry._id}:${partnerId}`,
      date: entry.day,
      description: entry.description,
      source: entry.source,
      isHistorical: !!ctx.isHistorical,
      migrationRunId: ctx.migrationRunId,
      fallbacks: entry.fallbacks,
      notes: [...(entry.notes || []), `نُقل من العميل السابق مع الطلب (القيد الأصلي ${entry.number})`],
      lines: entry.lines.map((line) => {
        const plain = line.toObject ? line.toObject() : { ...line };
        delete plain._id;
        return isMoved(plain) ? { ...plain, partnerId } : plain;
      }),
    }, { session: ctx.session, user: ctx.user });
    await JournalEntry.updateMany({ _id: { $in: [entry._id, reversal._id] } }, { $set: { hiddenWithCancel: true } }, { session: ctx.session });
    posted.push(reversal, copy);
  }
  return posted;
}

// The claim entries of an order that is cancelled or deleted and owes nothing any more are hidden
// together (spec 19.9); a payment still on the order keeps them all visible
async function hideCancelledClaims(orderId, ctx) {
  const [open] = await JournalEntry.aggregate([
    { $match: { 'lines.orderId': oid(orderId) } }, { $unwind: '$lines' }, { $match: { 'lines.orderId': oid(orderId) } },
    { $group: { _id: '$lines.accountId', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $match: { net: { $ne: 0 } } }, { $limit: 1 },
  ]).session(ctx.session);
  if (open) return;
  await JournalEntry.updateMany({ 'source.model': 'Order', 'source.id': oid(orderId), hiddenWithCancel: { $ne: true } }, { $set: { hiddenWithCancel: true } }, { session: ctx.session });
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
