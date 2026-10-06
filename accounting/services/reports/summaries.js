// The accounting view of one order, one trip or one customer (spec 7: the "accounting" tab on
// the order, trip and customer pages). Read from the ledger only.
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { SupplierBill, SupplierPayment, CustomerRefund } = require('../../models/documents');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const Wallet = require('../../../models/wallet');
const ErrorHandler = require('../../../utils/errorHandler');
const { getConfig } = require('../config');
const { roleIds, receivables, customerStatement } = require('./operations');
const { purchaseKey, shipmentKey, customsFeeKey, CLAIM_EVENTS } = require('../claims/keys');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const notFound = (what) => new ErrorHandler(404, `${what} غير موجود`);

const ROLES = [
  'customer_receivable', 'deferred_shipping_revenue', 'deferred_purchase_revenue', 'trip_cost_wip', 'purchase_cost_wip',
  'revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'revenue_purchase_invoices',
  'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices',
  // Alipay transfers and customs clearance have their own accounts (spec 19.5, decision 111)
  'revenue_remittance', 'cost_remittance', 'revenue_customs', 'cost_customs', 'customs_cost_wip',
];
const SHIP_REVENUE = ['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other'];
const SHIP_COST = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic'];

// Net (debit - credit) of every line matching `lineMatch`, keyed by whatever `key` builds
async function ledgerBy(entryMatch, lineMatch, key) {
  const rows = await JournalEntry.aggregate([
    { $match: entryMatch }, { $unwind: '$lines' }, { $match: lineMatch },
    { $group: { _id: { ...key, accountId: '$lines.accountId' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return rows;
}

const recentEntries = (match) => JournalEntry.find(match).sort({ day: -1, createdAt: -1 }).limit(100)
  .select('number day description eventType totalDebit status reversalOf').lean();

// Supplier bills that put a cost on this order or trip, with the part of each bill that is theirs,
// and the payments made on them: what was paid, in what currency and at what rate, and the
// difference a payment put on this cost (paid in lira for a bill in Kuwaiti dinars, decision 127)
async function billsFor(field, id) {
  const bills = await SupplierBill.find({ [`lines.${field}`]: id, status: { $ne: 'draft' } }).populate('vendorId', 'name').sort({ day: -1 }).lean();
  const payments = await SupplierPayment.find({ 'allocations.billId': { $in: bills.map((b) => b._id) }, status: 'posted' })
    .populate('fromAccountId', 'code name').select('number day currency amount rate allocations costDifferenceUsd entryId fromAccountId fromAdvance').lean();
  const entries = await JournalEntry.find({ _id: { $in: payments.filter((p) => p.costDifferenceUsd).map((p) => p.entryId) } }).select('lines').lean();
  const entryOf = new Map(entries.map((e) => [String(e._id), e]));
  return bills.map((bill) => {
    const lines = bill.lines.filter((line) => String(line[field]) === String(id));
    const label = `فرق المدفوع عن الفاتورة ${bill.number}`;
    const paid = payments.filter((p) => p.allocations.some((a) => String(a.billId) === String(bill._id))).map((p) => ({
      paymentId: p._id, number: p.number, day: p.day, currency: p.currency, amount: p.amount, rate: p.rate, fromAdvance: p.fromAdvance, account: p.fromAccountId?.name,
      allocatedUsd: p.allocations.find((a) => String(a.billId) === String(bill._id))?.amountUsd || 0,
      // The part of the payment's difference that landed on this order or trip
      difference: (entryOf.get(String(p.entryId))?.lines || []).filter((l) => l.label === label && String(l[field]) === String(id))
        .reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0),
    }));
    const usd = lines.reduce((sum, line) => sum + (line.usd || 0), 0);
    const difference = paid.reduce((sum, p) => sum + p.difference, 0);
    return {
      billId: bill._id, number: bill.number, day: bill.day, vendor: bill.vendorId?.name, status: bill.status, currency: bill.currency, isCreditNote: bill.isCreditNote,
      amount: lines.reduce((sum, line) => sum + line.amount, 0), usd, payments: paid, difference, cost: usd + difference,
      description: lines.map((line) => line.description).join('، '),
    };
  });
}

async function orderSummary(orderId) {
  const order = await Order.findById(orderId).setOptions({ withDeleted: true }).select('orderId user isPayment isShipment isCanceled isDeleted unsureOrder totalInvoice paymentList._id paymentList.status paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice').lean();
  if (!order) throw notFound('الطلب');
  const roles = await roleIds(ROLES);
  const match = { 'lines.orderId': oid(orderId) };
  const rows = await ledgerBy(match, match, { arKey: '$lines.arKey', packageId: '$lines.packageId', tripId: '$lines.tripId', claim: { $in: ['$eventType', CLAIM_EVENTS] } });

  const is = (row, role) => String(row._id.accountId) === roles[role];
  const among = (row, list) => list.some((role) => is(row, role));
  const claims = new Map();
  const claim = (key) => {
    if (!claims.has(key)) claims.set(key, { arKey: key, billed: 0, open: 0, recognized: 0, deferred: 0, cost: 0 });
    return claims.get(key);
  };
  let purchaseCost = 0;
  let purchaseCostInProgress = 0;
  rows.forEach((row) => {
    const { arKey, packageId, claim: isClaim } = row._id;
    const key = arKey || (packageId ? shipmentKey(orderId, packageId) : null);
    if (is(row, 'customer_receivable') && arKey) {
      claim(arKey).open += row.net;
      if (isClaim) claim(arKey).billed += row.net;
    }
    if (key && among(row, [...SHIP_REVENUE, 'revenue_purchase_invoices', 'revenue_remittance', 'revenue_customs'])) claim(key).recognized -= row.net;
    if (key && among(row, ['deferred_shipping_revenue', 'deferred_purchase_revenue'])) claim(key).deferred -= row.net;
    if (packageId && among(row, SHIP_COST)) claim(shipmentKey(orderId, packageId)).cost += row.net;
    // A free package's share of its trip sits on the purchase cost with its package (decision 110)
    if (among(row, ['cost_purchase_invoices', 'cost_remittance'])) {
      if (packageId && row._id.tripId) claim(shipmentKey(orderId, packageId)).cost += row.net;
      else purchaseCost += row.net;
    }
    if (packageId && is(row, 'cost_customs')) claim(customsFeeKey(orderId, packageId)).cost += row.net;
    if (among(row, ['purchase_cost_wip', 'customs_cost_wip'])) purchaseCostInProgress += row.net;
  });
  if (claims.has(purchaseKey(orderId))) claims.get(purchaseKey(orderId)).cost = purchaseCost;

  const packages = new Map((order.paymentList || []).map((pkg) => [String(pkg._id), pkg]));
  const list = [...claims.values()].map((item) => {
    const [first, , packageId] = item.arKey.split(':');
    // The transport fee of a package is its own claim beside the shipping (spec v8)
    const kind = item.arKey.endsWith(':DOM') ? 'DOM' : item.arKey.endsWith(':CUS') ? 'CUS' : first;
    const pkg = packages.get(packageId);
    return {
      ...item, kind, packageId: packageId || null, tracking: pkg?.deliveredPackages?.trackingNumber, delivered: ['SHP', 'DOM', 'CUS'].includes(kind) ? !!pkg?.status?.received : null,
      paid: item.billed - item.open, profit: item.recognized - item.cost,
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
  const total = (field) => list.reduce((sum, item) => sum + item[field], 0);

  return {
    order: { _id: order._id, orderId: order.orderId, user: order.user, isCanceled: !!order.isCanceled, isPayment: !!order.isPayment },
    claims: list,
    totals: {
      billed: total('billed'), paid: total('paid'), open: total('open'), recognized: total('recognized'), deferred: total('deferred'),
      cost: total('cost'), profit: total('recognized') - total('cost'), costInProgress: purchaseCostInProgress,
    },
    bills: await billsFor('orderId', order._id),
    costExplanation: await orderCostExplanation(order._id, roles),
    entries: await recentEntries({ $or: [{ 'lines.orderId': order._id }, { 'source.model': 'Order', 'source.id': order._id }] }),
  };
}

// Each actual cost posting appears once. Moving cost from WIP to cost of sales
// has zero net impact, while refunds, payment differences and reversals remain visible.
async function orderCostExplanation(orderId, roles) {
  const { currencies } = await getConfig();
  const recognizedIds = new Set([...SHIP_COST, 'cost_purchase_invoices', 'cost_remittance', 'cost_customs'].map(role => roles[role]).filter(Boolean));
  const progressIds = new Set(['purchase_cost_wip', 'customs_cost_wip'].map(role => roles[role]).filter(Boolean));
  const entries = await JournalEntry.find({ 'lines.orderId': orderId }).sort({ day: 1, createdAt: 1, _id: 1 })
    .select('number day description eventType eventKey source status reversalOf lines notes')
    .populate('lines.accountId', 'code name currency').lean();
  const refunds = await CustomerRefund.find({ orderId }).populate('accountId', 'code name currency').lean();
  const bills = await SupplierBill.find({ 'lines.orderId': orderId }).populate('vendorId', 'name').lean();
  const payments = await SupplierPayment.find({ 'allocations.billId': { $in: bills.map(b => b._id) } }).populate('fromAccountId', 'code name currency').lean();
  const docs = new Map([...bills, ...payments, ...refunds].map(doc => [String(doc._id), doc]));
  let runningCost = 0; let recognizedCost = 0; let inProgress = 0;
  const rows = entries.flatMap(entry => {
    const own = entry.lines.filter(line => String(line.orderId) === String(orderId));
    const costLines = own.filter(line => recognizedIds.has(String(line.accountId?._id)) || progressIds.has(String(line.accountId?._id)));
    const refundEntry = entry.source?.model === 'AccountingCustomerRefund';
    if (!costLines.length && !refundEntry) return [];
    const recognized = costLines.filter(line => recognizedIds.has(String(line.accountId?._id))).reduce((sum, line) => sum + line.debit - line.credit, 0);
    const progress = costLines.filter(line => progressIds.has(String(line.accountId?._id))).reduce((sum, line) => sum + line.debit - line.credit, 0);
    const impact = recognized + progress;
    recognizedCost += recognized; inProgress += progress; runningCost += impact;
    const doc = docs.get(String(entry.source?.id));
    const valuation = String(entry.eventKey || '').startsWith('REFUND_BANK_VALUE:');
    return [{ entryId: entry._id, number: entry.number, day: entry.day, description: entry.description, status: entry.status,
      reversalOf: entry.reversalOf, eventType: entry.eventType, impact, recognized, inProgress: progress, runningCost,
      kind: entry.reversalOf ? 'reversal' : valuation ? 'refund_valuation' : refundEntry ? costLines.length ? 'refund' : 'wallet_refund'
        : impact === 0 ? 'recognition' : entry.source?.model === 'AccountingSupplierBill' ? doc?.isCreditNote ? 'credit_note' : 'bill' : entry.source?.model === 'AccountingSupplierPayment' ? 'payment_difference' : 'other',
      document: doc ? { _id: doc._id, number: doc.number, model: entry.source.model, status: doc.status,
        vendor: doc.vendorId?.name, currency: doc.currency, amount: doc.amount ?? doc.total, rate: doc.rate,
        account: doc.accountId || doc.fromAccountId, valuationUsd: doc.usd, walletUsd: doc.walletUsd, beforeBankUsd: doc.bankValuationBeforeUsd } : null,
      notes: entry.notes,
      // Show the whole journal so its debit/credit remain understandable; only
      // this order's cost lines contribute to impact and running total.
      lines: entry.lines.map((line, index) => ({
        _id: `${entry._id}:${index}`, account: line.accountId, debit: line.debit, credit: line.credit, currency: line.currency, amountCurrency: line.amountCurrency,
        currencyDecimals: currencies.get(line.currency || 'USD')?.decimals ?? 2,
        otherOrder: !!line.orderId && String(line.orderId) !== String(orderId),
        rate: line.rate, label: line.label, affectsCost: costLines.includes(line),
      })),
    }];
  });
  return { rows, total: runningCost, recognizedCost, inProgress,
    increases: rows.reduce((sum, row) => sum + Math.max(row.impact, 0), 0),
    decreases: rows.reduce((sum, row) => sum + Math.max(-row.impact, 0), 0) };
}

async function tripSummary(tripId) {
  const trip = await Inventory.findById(tripId).select('voyage shippingType status inventoryType inventoryPlace arrivalDate orders.paymentList._id').lean();
  if (!trip) throw notFound('الرحلة');
  // A warehouse only tracks packages: it has no costs, revenue or entries (spec 4.3)
  if (trip.inventoryType !== 'inventoryGoods') return { trip: { _id: trip._id, voyage: trip.voyage, inventoryType: trip.inventoryType }, isWarehouse: true };

  const roles = await roleIds(ROLES);
  const packageIds = (trip.orders || []).map((o) => o?.paymentList?._id).filter(Boolean);
  const international = trip.shippingType !== 'domestic';
  const is = (row, role) => String(row._id.accountId) === roles[role];
  const among = (row, list) => list.some((role) => is(row, role));

  const tripMatch = { 'lines.tripId': oid(tripId) };
  const costRows = await ledgerBy(tripMatch, tripMatch, { packageId: '$lines.packageId' });
  const packageMatch = { 'lines.packageId': { $in: packageIds.map(oid) } };
  const packageRows = packageIds.length ? await ledgerBy(packageMatch, packageMatch, { packageId: '$lines.packageId' }) : [];

  const orders = packageIds.length ? await Order.find({ 'paymentList._id': { $in: packageIds.map(oid) } })
    .select('orderId isCanceled paymentList._id paymentList.status.received paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice paymentList.deliveredPackages.volumetric').lean() : [];
  const wanted = new Set(packageIds.map(String));
  const packages = new Map();
  orders.forEach((order) => (order.paymentList || []).forEach((pkg) => {
    if (!wanted.has(String(pkg._id))) return;
    packages.set(String(pkg._id), {
      packageId: pkg._id, orderId: order._id, orderNumber: order.orderId, isCanceled: !!order.isCanceled, tracking: pkg.deliveredPackages?.trackingNumber, delivered: !!pkg.status?.received,
      // The chargeable weight, and whether it is the volumetric one (spec v8)
      weight: Number(pkg.deliveredPackages?.weight?.total || 0), volumetric: !!pkg.deliveredPackages?.volumetric?.enabled, actualWeight: pkg.deliveredPackages?.weight?.actual, charge: require('../claims/keys').packageChargeCents(pkg),
      revenue: 0, deferred: 0, open: 0, cost: 0,
    });
  }));

  let cost = 0;
  let costInProgress = 0;
  costRows.forEach((row) => {
    if (among(row, SHIP_COST)) {
      cost += row.net;
      const pkg = packages.get(String(row._id.packageId));
      if (pkg) pkg.cost += row.net;
    }
    if (is(row, 'trip_cost_wip')) costInProgress += row.net;
  });
  packageRows.forEach((row) => {
    const pkg = packages.get(String(row._id.packageId));
    if (!pkg) return;
    if (is(row, 'customer_receivable')) pkg.open += row.net;
    // A domestic leg carries cost only: the revenue belongs to the package's air or sea trip
    if (international && among(row, SHIP_REVENUE)) pkg.revenue -= row.net;
    if (international && is(row, 'deferred_shipping_revenue')) pkg.deferred -= row.net;
  });

  const list = [...packages.values()].sort((a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber)));
  const revenue = list.reduce((sum, p) => sum + p.revenue, 0);
  return {
    trip: { _id: trip._id, voyage: trip.voyage, shippingType: trip.shippingType, status: trip.status, inventoryType: trip.inventoryType },
    // Air and sea trips share their cost by weight; a domestic trip's cost is a lump-sum expense
    allocationBase: international ? 'weight' : 'none', international,
    totals: {
      revenue, cost, profit: revenue - cost, margin: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
      deferred: list.reduce((sum, p) => sum + p.deferred, 0), costInProgress, totalCost: cost + costInProgress,
      packages: list.length, recognizedPackages: list.filter((p) => p.revenue > 0).length,
    },
    packages: list,
    bills: await billsFor('tripId', trip._id),
    entries: await recentEntries({ 'lines.tripId': trip._id }),
  };
}

async function customerSummary(partnerId) {
  const { currencies } = await getConfig();
  const [statement, claims, wallets] = await Promise.all([
    customerStatement(partnerId, {}), receivables({ partnerId }), Wallet.find({ user: partnerId }).select('currency balance').lean(),
  ]);
  if (!statement.customer) throw notFound('العميل');
  const system = (currency) => {
    const wallet = wallets.find((w) => w.currency === currency);
    return Math.round(Math.max(0, Number(wallet?.balance) || 0) * 10 ** (currencies.get(currency)?.decimals ?? 2));
  };
  const walletUsd = { ledger: statement.closing.walletUsd, system: system('USD') };
  const walletLyd = { ledger: statement.closing.walletLyd, system: system('LYD') };
  return {
    customer: statement.customer,
    owed: statement.closing.owed, walletUsd, walletLyd,
    matches: walletUsd.ledger === walletUsd.system && walletLyd.ledger === walletLyd.system,
    claims: claims.claims, aging: claims.totals,
    recent: statement.movements.slice(-15).reverse(),
    movementsCount: statement.movements.length,
  };
}

module.exports = { orderSummary, tripSummary, customerSummary };
