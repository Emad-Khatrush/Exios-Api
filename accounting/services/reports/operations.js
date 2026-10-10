// Reports about the business itself (spec 9): profit per trip and per purchase order, what
// customers owe and for how long, a customer's statement, what is owed to vendors.
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { JournalEntry } = require('../../models');
const { Vendor, SupplierBill } = require('../../models/documents');
const Order = require('../../../models/order');
const { visibleMatch } = require('../visibility');
const Inventory = require('../../../models/inventory');
const User = require('../../../models/user');
const { getConfig } = require('../config');
const { today, TZ } = require('../dates');
const { allocate } = require('../claims/sync');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function roleIds(roles) {
  const { settings } = await getConfig();
  return Object.fromEntries(roles.map((role) => [role, settings.accountRoles?.[role] ? String(settings.accountRoles[role]) : null]));
}
const idsOf = (map) => Object.values(map).filter(Boolean).map(oid);

// Net (debit - credit) of the given accounts grouped by one line field (tripId, packageId, orderId)
async function netBy(field, accountIds, extraMatch = {}) {
  // On the whole entry only "some line has the field" can be asked ($ne: null there would mean
  // "no line lacks it" and drop entries such as a bill, whose payable line has no trip)
  const entryMatch = { 'lines.accountId': { $in: accountIds }, [`lines.${field}`]: { $exists: true }, ...extraMatch };
  const lineMatch = { 'lines.accountId': { $in: accountIds }, [`lines.${field}`]: { $exists: true, $ne: null }, ...extraMatch };
  const rows = await JournalEntry.aggregate([
    { $match: entryMatch }, { $unwind: '$lines' }, { $match: lineMatch },
    { $group: { _id: { key: `$lines.${field}`, accountId: '$lines.accountId' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  const result = new Map();
  rows.forEach(({ _id, net }) => {
    const key = String(_id.key);
    if (!result.has(key)) result.set(key, new Map());
    const account = String(_id.accountId);
    result.get(key).set(account, (result.get(key).get(account) || 0) + net);
  });
  return result;
}

// Profit of every trip (spec v8). An air or sea trip: the revenue of the packages it carried
// (recognised and still deferred) against its own costs (shipping, customs, clearance...), by cost
// category, per KG/CBM, and per delivery office with the domestic transport that took packages on.
// A domestic trip: its cost, its packages, the extra cost per KG, and the transport fees charged.
const COST_CATEGORIES = ['shipping', 'customs', 'clearance', 'transport', 'other'];

async function tripProfitability({ status, search, shippingType, tripIds: requestedTripIds } = {}) {
  const roles = await roleIds([
    'trip_cost_wip', 'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'deferred_shipping_revenue',
    'revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'cost_purchase_invoices',
  ]);
  const query = { inventoryType: 'inventoryGoods' };
  if (Array.isArray(requestedTripIds)) query._id = { $in: requestedTripIds.map(oid) };
  if (status) query.status = status;
  if (shippingType) query.shippingType = shippingType;
  if (search) query.voyage = new RegExp(escapeRegex(search), 'i');
  const trips = await Inventory.find(query).select('voyage shippingType status inventoryPlace arrivalDate createdAt').sort({ createdAt: -1 }).limit(Array.isArray(requestedTripIds) ? 0 : 1000).lean();

  // The packages of each trip, from their trip links. Packages of cancelled orders do not count.
  const tripIds = trips.map((t) => t._id);
  const orders = await Order.find({ isCanceled: { $ne: true }, $or: [{ 'paymentList.tripId': { $in: tripIds } }, { 'paymentList.domesticTripId': { $in: tripIds } }] })
    .select('placedAt paymentList._id paymentList.tripId paymentList.domesticTripId paymentList.deliveredPackages.weight paymentList.deliveredPackages.volumetric paymentList.deliveredPackages.domesticFee').lean();
  const packagesOf = new Map();
  const addPackage = (tripId, pkg) => {
    if (!tripId) return;
    if (!packagesOf.has(String(tripId))) packagesOf.set(String(tripId), []);
    packagesOf.get(String(tripId)).push(pkg);
  };
  orders.forEach((order) => (order.paymentList || []).forEach((pkg) => {
    const item = { ...pkg, placedAt: order.placedAt };
    addPackage(pkg.tripId, item);
    addPackage(pkg.domesticTripId, item);
  }));
  // Domestic trips the packages went on to (their destination, their cost), even outside the filter
  const domesticIds = [...new Set(orders.flatMap((o) => (o.paymentList || []).map((p) => p.domesticTripId).filter(Boolean).map(String)))];
  const domesticTrips = new Map((await Inventory.find({ _id: { $in: domesticIds.map(oid) } }).select('inventoryPlace').lean()).map((t) => [String(t._id), t]));
  const weightOf = (pkg) => Number(pkg.deliveredPackages?.weight?.total || 0);

  // A free package's share of its trip is a cost of its purchase, still part of what the trip cost
  const costIds = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices'].map((r) => roles[r]);
  const revenueIds = ['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other'].map((r) => roles[r]);
  const allTripIds = [...new Set([...tripIds.map(String), ...domesticIds])];
  const tripScope = { 'lines.tripId': { $in: allTripIds.map(oid) } };
  const packageIds = orders.flatMap((order) => (order.paymentList || []).map((pkg) => pkg._id).filter(Boolean));
  const [byTrip, byPackage, feesByTrip, bills] = await Promise.all([
    netBy('tripId', idsOf({ wip: roles.trip_cost_wip, ...Object.fromEntries(costIds.map((id, i) => [i, id])) }), tripScope),
    // A package's shipping (its transport fee is the domestic trip's, below)
    netBy('packageId', idsOf({ deferred: roles.deferred_shipping_revenue, ...Object.fromEntries(revenueIds.map((id, i) => [i, id])) }), { 'lines.packageId': { $in: packageIds }, 'lines.arKey': { $not: /:DOM$/ } }),
    netBy('tripId', idsOf({ a: roles.revenue_shipping_domestic }), { ...tripScope, 'lines.arKey': /:DOM$/ }),
    SupplierBill.find({ status: 'posted', 'lines.tripId': { $in: allTripIds.map(oid) } }).select('lines.tripId lines.usd lines.costCategory isCreditNote').lean(),
  ]);
  const categories = new Map();
  bills.forEach((bill) => bill.lines.forEach((line) => {
    if (!line.tripId) return;
    const key = String(line.tripId);
    if (!categories.has(key)) categories.set(key, {});
    const map = categories.get(key);
    const category = COST_CATEGORIES.includes(line.costCategory) ? line.costCategory : 'uncategorized';
    map[category] = (map[category] || 0) + (bill.isCreditNote ? -1 : 1) * (line.usd || 0);
  }));
  const sum = (map, ids) => ids.reduce((total, id) => total + (map?.get(id) || 0), 0);
  const perUnit = (cents, weight) => (weight > 0 ? Math.round(cents / weight) : null);
  const tripCost = (id) => sum(byTrip.get(String(id)), [...costIds, roles.trip_cost_wip]);
  // A domestic trip's cost, shared over its packages by chargeable weight
  const domesticWeight = new Map(domesticIds.map((id) => [id, (packagesOf.get(id) || []).reduce((t, p) => t + weightOf(p), 0)]));
  // Match the ledger's cent-exact allocation, including who receives any leftover cents.
  const domesticShareByPackage = new Map();
  domesticIds.forEach((id) => {
    const packages = packagesOf.get(id) || [];
    const cents = allocate(tripCost(id), packages.map((pkg) => Math.round(Number(weightOf(pkg) || 0) * 1000)));
    packages.forEach((pkg, index) => domesticShareByPackage.set(String(pkg._id), cents[index] || 0));
  });
  const domesticShare = (pkg) => {
    const id = pkg.domesticTripId && String(pkg.domesticTripId);
    if (!id || !(domesticWeight.get(id) > 0)) return 0;
    return domesticShareByPackage.get(String(pkg._id)) || 0;
  };

  const results = trips.map((trip) => {
    const packages = packagesOf.get(String(trip._id)) || [];
    const ledger = byTrip.get(String(trip._id));
    const cost = sum(ledger, costIds);
    const costInProgress = ledger?.get(roles.trip_cost_wip) || 0;
    const international = trip.shippingType !== 'domestic';
    const weight = Math.round(packages.reduce((total, pkg) => total + weightOf(pkg), 0) * 1000) / 1000;
    const units = [...new Set(packages.map((pkg) => pkg.deliveredPackages?.weight?.measureUnit).filter(Boolean))];
    const unit = trip.shippingType === 'air' ? 'KG' : trip.shippingType === 'sea' ? 'CBM' : (units.length === 1 ? units[0] : null);
    const totalCost = cost + costInProgress;
    const base = {
      tripId: trip._id, voyage: trip.voyage, shippingType: trip.shippingType, status: trip.status, office: trip.inventoryPlace,
      date: trip.arrivalDate || trip.createdAt, packages: packages.length, weight, unit, mixedUnits: !unit && units.length > 1,
      cost, costInProgress, totalCost, byCategory: categories.get(String(trip._id)) || {},
      freeShippingCost: ledger?.get(roles.cost_purchase_invoices) || 0,
      volumetricPackages: packages.filter((p) => p.deliveredPackages?.volumetric?.enabled).length,
    };
    if (!international) {
      // The domestic leg: what it cost, the extra per KG, and the transport fees charged for it
      const feesBilled = packages.filter((p) => String(p.domesticTripId) === String(trip._id))
        .reduce((t, p) => t + Math.round(Number(p.deliveredPackages?.domesticFee?.usd || 0) * 100), 0);
      const feesRecognized = -(feesByTrip.get(String(trip._id))?.get(roles.revenue_shipping_domestic) || 0);
      return {
        ...base, revenue: feesRecognized, deferred: 0, totalRevenue: feesBilled, profit: feesRecognized - cost, net: feesBilled - totalCost,
        feesBilled, feesRecognized, extraCostPerUnit: perUnit(totalCost, weight), costPerUnit: perUnit(totalCost, weight), revenuePerUnit: null,
        recognizedPackages: 0, margin: null,
      };
    }
    let revenue = 0;
    let deferred = 0;
    let recognizedPackages = 0;
    const offices = new Map();
    const costPerUnitValue = perUnit(totalCost, weight);
    packages.forEach((pkg) => {
      const ledgerOfPackage = byPackage.get(String(pkg._id));
      const earned = -sum(ledgerOfPackage, revenueIds);
      const waiting = -(ledgerOfPackage?.get(roles.deferred_shipping_revenue) || 0);
      revenue += earned;
      deferred += waiting;
      if (earned > 0) recognizedPackages++;
      // Delivered where its domestic trip took it, or where this trip arrived
      const office = (pkg.domesticTripId && domesticTrips.get(String(pkg.domesticTripId))?.inventoryPlace) || trip.inventoryPlace || pkg.placedAt || '';
      const row = offices.get(office) || { office, weight: 0, revenue: 0, domesticCost: 0, packages: 0 };
      row.weight += weightOf(pkg);
      row.revenue += earned + waiting;
      row.domesticCost += domesticShare(pkg);
      row.packages += 1;
      offices.set(office, row);
    });
    const totalRevenue = revenue + deferred;
    const profit = revenue - cost;
    const domesticCost = [...offices.values()].reduce((t, o) => t + o.domesticCost, 0);
    const officeRows = [...offices.values()];
    const officeOwnCosts = allocate(totalCost, officeRows.map((office) => Math.round(Number(office.weight || 0) * 1000)));
    return {
      ...base, recognizedPackages,
      revenue, profit, margin: revenue ? Math.round((profit / revenue) * 1000) / 10 : null,
      deferred, totalRevenue, net: totalRevenue - totalCost,
      // Per KG/CBM: this trip's own cost (shipping, customs...), then with the domestic transport
      costPerUnit: unit ? costPerUnitValue : null, revenuePerUnit: unit ? perUnit(totalRevenue, weight) : null,
      domesticCost, profitBeforeDomestic: totalRevenue - totalCost, profitAfterDomestic: totalRevenue - totalCost - domesticCost,
      offices: officeRows.map((o, index) => {
        const ownCost = officeOwnCosts[index] || 0;
        return {
          ...o, weight: Math.round(o.weight * 1000) / 1000, ownCost,
          costPerUnit: perUnit(ownCost, o.weight), fullCostPerUnit: perUnit(ownCost + o.domesticCost, o.weight), sellPerUnit: perUnit(o.revenue, o.weight),
          profit: o.revenue - ownCost - o.domesticCost,
        };
      }),
    };
  });
  const total = (field) => results.reduce((s2, r) => s2 + (r[field] || 0), 0);
  return {
    results,
    totals: {
      revenue: total('revenue'), cost: total('cost'), profit: total('profit'), deferred: total('deferred'), costInProgress: total('costInProgress'),
      totalRevenue: total('totalRevenue'), totalCost: total('totalCost'), net: total('net'),
    },
  };
}

// Profit of every purchase order: the invoice sold to the customer against the supplier bills
// entered on it. An order with no cost at all shows a 100% profit and is flagged.
async function purchaseProfitability({ search, onlyWithoutCost } = {}) {
  const roles = await roleIds(['revenue_purchase_invoices', 'cost_purchase_invoices', 'purchase_cost_wip', 'deferred_purchase_revenue', 'customer_receivable']);
  const [byOrder, open] = await Promise.all([
    netBy('orderId', idsOf({ a: roles.revenue_purchase_invoices, b: roles.cost_purchase_invoices, c: roles.purchase_cost_wip, d: roles.deferred_purchase_revenue })),
    netBy('orderId', idsOf({ a: roles.customer_receivable }), { 'lines.arKey': /^PUR:/ }),
  ]);
  const orderIds = [...byOrder.keys()].filter((id) => mongoose.isValidObjectId(id));
  const query = { _id: { $in: orderIds.map(oid) } };
  if (search) query.$or = [{ orderId: new RegExp(escapeRegex(search), 'i') }, { 'customerInfo.fullName': new RegExp(escapeRegex(search), 'i') }];
  const orders = await Order.find(query).select('orderId customerInfo.fullName user isCanceled isDeleted createdAt').setOptions({ withDeleted: true }).lean();

  let results = orders.map((order) => {
    const ledger = byOrder.get(String(order._id));
    const revenue = -(ledger.get(roles.revenue_purchase_invoices) || 0);
    const cost = ledger.get(roles.cost_purchase_invoices) || 0;
    const costInProgress = ledger.get(roles.purchase_cost_wip) || 0;
    const deferred = -(ledger.get(roles.deferred_purchase_revenue) || 0);
    const profit = revenue - cost;
    return {
      orderId: order._id, orderNumber: order.orderId, customer: order.customerInfo?.fullName, userId: order.user, isCanceled: !!order.isCanceled, date: order.createdAt,
      revenue, cost, profit, margin: revenue ? Math.round((profit / revenue) * 1000) / 10 : null, deferred, costInProgress,
      open: open.get(String(order._id))?.get(roles.customer_receivable) || 0,
      withoutCost: revenue > 0 && cost === 0,
      // Costs waiting on a cancelled order: the accountant decides (loss, or moved elsewhere)
      stuckCost: !!order.isCanceled && costInProgress > 0,
    };
  }).filter((row) => row.revenue || row.cost || row.deferred || row.costInProgress);
  if (onlyWithoutCost) results = results.filter((row) => row.withoutCost);
  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  const total = (field) => results.reduce((s, r) => s + r[field], 0);
  return {
    results: results.slice(0, 2000), count: results.length,
    totals: { revenue: total('revenue'), cost: total('cost'), profit: total('profit'), deferred: total('deferred'), costInProgress: total('costInProgress') },
  };
}

const BUCKETS = [[0, 30, 'd0'], [31, 60, 'd31'], [61, 90, 'd61'], [91, Infinity, 'd91']];
const bucketOf = (days) => BUCKETS.find(([min, max]) => days >= min && days <= max)[2];
const ageInDays = (day, asOf) => Math.max(0, moment.tz(asOf, TZ).diff(moment.tz(day, TZ), 'days'));

// What customers owe on a day: every open claim with its age (from the day it was billed), per
// customer in age buckets, and which of them are packages already handed over (their revenue is
// still deferred, so it is not in the income statement yet).
async function receivables({ asOf, partnerId } = {}) {
  const day = asOf || today();
  const roles = await roleIds(['customer_receivable']);
  const receivable = oid(roles.customer_receivable);
  const lineMatch = { 'lines.accountId': receivable, ...(partnerId && { 'lines.partnerId': oid(partnerId) }) };
  const rows = await JournalEntry.aggregate([
    { $match: { day: { $lte: day }, ...lineMatch } }, { $unwind: '$lines' }, { $match: lineMatch },
    { $sort: { day: 1 } },
    {
      $group: {
        _id: { arKey: { $ifNull: ['$lines.arKey', '-'] }, partnerId: '$lines.partnerId' },
        open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        billedDay: { $min: { $cond: [{ $gt: ['$lines.debit', 0] }, '$day', null] } }, firstDay: { $first: '$day' },
      },
    },
    { $match: { open: { $ne: 0 } } },
  ]);

  const orderIds = [...new Set(rows.map((row) => String(row._id.arKey).split(':')).filter(([kind]) => kind === 'PUR' || kind === 'SHP').map(([, id]) => id).filter(mongoose.isValidObjectId))];
  const orders = new Map((await Order.find({ _id: { $in: orderIds } }).select('orderId isDeleted paymentList._id paymentList.status.received paymentList.deliveredPackages.trackingNumber').setOptions({ withDeleted: true }).lean()).map((o) => [String(o._id), o]));
  const users = new Map((await User.find({ _id: { $in: [...new Set(rows.map((row) => row._id.partnerId).filter(Boolean).map(String))] } }).select('firstName lastName customerId phone').lean()).map((u) => [String(u._id), u]));

  const claims = rows.map((row) => {
    const [kind, orderId, packageId] = String(row._id.arKey).split(':');
    const order = orders.get(orderId);
    const pkg = order?.paymentList?.find((p) => String(p._id) === packageId);
    const since = row.billedDay || row.firstDay;
    const age = ageInDays(since, day);
    return {
      arKey: row._id.arKey === '-' ? null : row._id.arKey, kind: ['PUR', 'SHP', 'GEN'].includes(kind) ? kind : 'OTHER', orderId: order ? orderId : null, orderNumber: order?.orderId,
      tracking: pkg?.deliveredPackages?.trackingNumber, delivered: !!pkg?.status?.received, partnerId: row._id.partnerId, customer: users.get(String(row._id.partnerId)) || null,
      open: row.open, since, age, bucket: bucketOf(age),
    };
  });

  const customers = new Map();
  claims.forEach((claim) => {
    const key = String(claim.partnerId || '');
    const item = customers.get(key) || { partnerId: claim.partnerId, customer: claim.customer, d0: 0, d31: 0, d61: 0, d91: 0, total: 0, claims: 0 };
    item[claim.bucket] += claim.open;
    item.total += claim.open;
    item.claims++;
    customers.set(key, item);
  });
  const owed = claims.filter((c) => c.open > 0);
  const totals = { d0: 0, d31: 0, d61: 0, d91: 0, total: 0 };
  claims.forEach((c) => { totals[c.bucket] += c.open; totals.total += c.open; });
  const deliveredUnpaid = owed.filter((c) => c.kind === 'SHP' && c.delivered);
  return {
    asOf: day, totals,
    customers: [...customers.values()].sort((a, b) => b.total - a.total),
    claims: claims.sort((a, b) => b.open - a.open).slice(0, 3000), claimsCount: claims.length,
    deliveredUnpaid: { count: deliveredUnpaid.length, total: deliveredUnpaid.reduce((s, c) => s + c.open, 0) },
    overpaid: { count: claims.filter((c) => c.open < 0).length, total: claims.filter((c) => c.open < 0).reduce((s, c) => s + c.open, 0) },
  };
}

// One customer's account from the ledger: claims, payments and wallet movements in date order,
// with what they owe and what their wallets hold after each line
async function customerStatement(partnerId, { from, to, showCanceled } = {}) {
  const roles = await roleIds(['customer_receivable', 'wallet_usd', 'wallet_lyd']);
  const accountIds = idsOf(roles);
  const lineMatch = { 'lines.partnerId': oid(partnerId), 'lines.accountId': { $in: accountIds } };
  const rows = await JournalEntry.aggregate([
    { $match: { ...(to && { day: { $lte: to } }), ...lineMatch, ...visibleMatch(showCanceled) } },
    { $sort: { day: 1, createdAt: 1 } },
    { $unwind: '$lines' }, { $match: lineMatch },
    { $project: { number: 1, day: 1, description: 1, eventType: 1, line: '$lines' } },
  ]);
  const balance = { owed: 0, walletUsd: 0, walletLyd: 0 };
  const apply = (line) => {
    const account = String(line.accountId);
    if (account === roles.customer_receivable) balance.owed += line.debit - line.credit;
    if (account === roles.wallet_usd) balance.walletUsd += line.credit - line.debit;
    if (account === roles.wallet_lyd) balance.walletLyd -= line.amountCurrency || 0;
  };
  const movements = [];
  let opening = { ...balance };
  rows.forEach((row) => {
    apply(row.line);
    if (from && row.day < from) { opening = { ...balance }; return; }
    const account = String(row.line.accountId);
    movements.push({
      entryId: row._id, number: row.number, day: row.day, description: row.line.label || row.description, eventType: row.eventType,
      account: account === roles.customer_receivable ? 'receivable' : account === roles.wallet_usd ? 'walletUsd' : 'walletLyd',
      arKey: row.line.arKey, orderId: row.line.orderId, debit: row.line.debit, credit: row.line.credit,
      foreign: row.line.currency && row.line.currency !== 'USD' ? row.line.amountCurrency : null, currency: row.line.currency, rate: row.line.rate,
      ...balance,
    });
  });
  const customer = await User.findById(partnerId).select('firstName lastName customerId phone').lean();
  return { customer, from: from || null, to: to || null, opening, closing: { ...balance }, movements: movements.slice(-5000), truncated: movements.length > 5000 };
}

// What is owed to vendors on a day, per bill, with its age
async function payables({ asOf } = {}) {
  const day = asOf || today();
  const roles = await roleIds(['payable_carriers', 'payable_suppliers']);
  const accountIds = idsOf(roles);
  const lineMatch = { 'lines.accountId': { $in: accountIds } };
  const rows = await JournalEntry.aggregate([
    { $match: { day: { $lte: day }, ...lineMatch } }, { $unwind: '$lines' }, { $match: lineMatch },
    { $sort: { day: 1 } },
    { $group: { _id: { apKey: { $ifNull: ['$lines.apKey', '-'] }, vendorId: '$lines.vendorId' }, open: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } }, firstDay: { $first: '$day' } } },
    { $match: { open: { $ne: 0 } } },
  ]);
  const billIds = rows.map((row) => String(row._id.apKey).split(':')).filter(([kind, id]) => kind === 'BILL' && mongoose.isValidObjectId(id)).map(([, id]) => id);
  const [bills, vendors] = await Promise.all([
    SupplierBill.find({ _id: { $in: billIds } }).select('number day vendorRef total currency').lean(),
    Vendor.find({ _id: { $in: rows.map((row) => row._id.vendorId).filter(Boolean) } }).select('name type').lean(),
  ]);
  const billById = new Map(bills.map((b) => [String(b._id), b]));
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

  const items = rows.map((row) => {
    const [kind, id] = String(row._id.apKey).split(':');
    const bill = kind === 'BILL' ? billById.get(id) : null;
    const since = bill?.day || row.firstDay;
    const age = ageInDays(since, day);
    return {
      apKey: row._id.apKey, kind: kind === 'BILL' ? 'bill' : kind === 'ADV' ? 'advance' : 'other', billId: bill?._id, number: bill?.number, vendorRef: bill?.vendorRef,
      vendorId: row._id.vendorId, vendor: vendorById.get(String(row._id.vendorId))?.name, open: row.open, since, age, bucket: bucketOf(age),
    };
  });
  const byVendor = new Map();
  items.forEach((item) => {
    const key = String(item.vendorId || '');
    const group = byVendor.get(key) || { vendorId: item.vendorId, vendor: item.vendor, d0: 0, d31: 0, d61: 0, d91: 0, total: 0, bills: 0 };
    group[item.bucket] += item.open;
    group.total += item.open;
    group.bills++;
    byVendor.set(key, group);
  });
  const totals = { d0: 0, d31: 0, d61: 0, d91: 0, total: 0 };
  items.forEach((item) => { totals[item.bucket] += item.open; totals.total += item.open; });
  return { asOf: day, totals, vendors: [...byVendor.values()].sort((a, b) => b.total - a.total), items: items.sort((a, b) => b.age - a.age).slice(0, 3000) };
}

module.exports = { tripProfitability, purchaseProfitability, receivables, customerStatement, payables, roleIds, netBy, ageInDays };
