// The migration report (spec 6-أ.9): what was posted, the profit per year, and everything the
// accountant has to look at before approving: assumptions, differences, suspicious data.
const mongoose = require('mongoose');
const { JournalEntry, CurrencyRate } = require('../../models');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const User = require('../../../models/user');
const Balance = require('../../../models/balance');
const { getConfig } = require('../config');
const { resolveAccount } = require('../roles');

const LIST_LIMIT = 200;
const PAYMENT_EVENTS = ['WALLET_PAYMENT', 'CASH_PAYMENT', 'CANCEL', 'SETTLEMENT_CANCEL', 'REFUND'];

async function yearlyResults() {
  const { accountsById } = await getConfig();
  const rows = await JournalEntry.aggregate([
    { $unwind: '$lines' },
    { $group: { _id: { year: { $substr: ['$day', 0, 4] }, accountId: '$lines.accountId' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  const costRoles = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices', 'cost_remittance'];
  const { settings } = await getConfig();
  const costIds = new Set(costRoles.map((role) => String(settings.accountRoles?.[role])));
  const years = new Map();
  rows.forEach(({ _id, net }) => {
    const account = accountsById.get(String(_id.accountId));
    if (!account || !['income', 'expense'].includes(account.type)) return;
    const year = years.get(_id.year) || { year: _id.year, revenue: 0, costOfSales: 0, expenses: 0 };
    if (account.type === 'income') year.revenue += -net;
    else if (costIds.has(String(account._id))) year.costOfSales += net;
    else year.expenses += net;
    years.set(_id.year, year);
  });
  return [...years.values()].sort((a, b) => a.year.localeCompare(b.year))
    .map((y) => ({ ...y, grossProfit: y.revenue - y.costOfSales, netProfit: y.revenue - y.costOfSales - y.expenses }));
}

async function claimsReview(tolerance) {
  const receivable = await resolveAccount('customer_receivable');
  const open = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': receivable._id } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': receivable._id, 'lines.arKey': { $exists: true } } },
    { $group: { _id: '$lines.arKey', open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, orderId: { $first: '$lines.orderId' }, partnerId: { $first: '$lines.partnerId' } } },
    { $match: { $or: [{ open: { $gt: tolerance } }, { open: { $lt: -tolerance } }] } },
  ]);
  const orderIds = [...new Set(open.map((row) => row.orderId).filter(Boolean).map(String))];
  const orders = new Map((await Order.find({ _id: { $in: orderIds } }).setOptions({ withDeleted: true }).select('orderId paymentList._id paymentList.status.received paymentList.deliveredPackages.trackingNumber').lean()).map((o) => [String(o._id), o]));
  const describe = (row) => {
    const order = orders.get(String(row.orderId));
    const packageId = row._id.startsWith('SHP:') ? row._id.split(':')[2] : null;
    const pkg = packageId && order?.paymentList?.find((p) => String(p._id) === packageId);
    return { arKey: row._id, open: row.open, orderNumber: order?.orderId, tracking: pkg?.deliveredPackages?.trackingNumber, delivered: !!pkg?.status?.received, kind: row._id.split(':')[0] };
  };
  const rows = open.map(describe);
  return {
    deliveredUnpaid: rows.filter((r) => r.open > 0 && r.kind === 'SHP' && r.delivered).sort((a, b) => b.open - a.open),
    unpaid: rows.filter((r) => r.open > 0 && !(r.kind === 'SHP' && r.delivered)).sort((a, b) => b.open - a.open),
    overpaid: rows.filter((r) => r.open < 0).sort((a, b) => a.open - b.open),
  };
}

// Purchase orders sold with no supplier cost at all: a 100% profit that is almost surely missing costs
async function purchasesWithoutCost() {
  const [revenue, cost] = await Promise.all([resolveAccount('revenue_purchase_invoices'), resolveAccount('cost_purchase_invoices')]);
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': { $in: [revenue._id, cost._id] } } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: [revenue._id, cost._id] } } },
    {
      $group: {
        _id: '$lines.orderId',
        revenue: { $sum: { $cond: [{ $eq: ['$lines.accountId', revenue._id] }, { $subtract: ['$lines.credit', '$lines.debit'] }, 0] } },
        cost: { $sum: { $cond: [{ $eq: ['$lines.accountId', cost._id] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
      },
    },
    { $match: { revenue: { $gt: 0 }, cost: 0 } },
  ]);
  const orders = new Map((await Order.find({ _id: { $in: rows.map((r) => r._id) } }).setOptions({ withDeleted: true }).select('orderId').lean()).map((o) => [String(o._id), o.orderId]));
  return rows.map((r) => ({ orderId: r._id, orderNumber: orders.get(String(r._id)), revenue: r.revenue })).sort((a, b) => b.revenue - a.revenue);
}

async function tripsWithoutCost() {
  // Domestic trips are a lump-sum transport cost, not shared over packages: only air and sea count
  const trips = await Inventory.find({ inventoryType: 'inventoryGoods', shippingType: { $ne: 'domestic' }, 'orders.0': { $exists: true } }).select('voyage shippingType arrivalDate createdAt').lean();
  const withCost = new Set((await JournalEntry.distinct('lines.tripId', { 'lines.tripId': { $in: trips.map((t) => t._id) } })).map(String));
  return trips.filter((t) => !withCost.has(String(t._id))).map((t) => ({ tripId: t._id, voyage: t.voyage, shippingType: t.shippingType, date: t.arrivalDate || t.createdAt }));
}

// Unsure (unconfirmed) orders the customer paid on: billed like any order, but something to fix
async function unsurePaidOrders() {
  const receivable = await resolveAccount('customer_receivable');
  const orders = await Order.find({ unsureOrder: true }).select('orderId user totalInvoice').lean();
  if (!orders.length) return { count: 0, list: [] };
  const paid = await JournalEntry.aggregate([
    // Payments only (and their reversals), not the claim entries of the order
    { $match: { 'lines.orderId': { $in: orders.map((o) => o._id) }, eventType: { $in: PAYMENT_EVENTS } } }, { $unwind: '$lines' },
    { $match: { 'lines.orderId': { $in: orders.map((o) => o._id) }, 'lines.accountId': receivable._id } },
    { $group: { _id: '$lines.orderId', paid: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
    { $match: { paid: { $gt: 0 } } },
  ]);
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  const list = paid.map((row) => ({ orderId: row._id, orderNumber: byId.get(String(row._id))?.orderId, totalInvoice: byId.get(String(row._id))?.totalInvoice, paid: row.paid }));
  return { count: list.length, list };
}

// Unconfirmed orders with amounts typed in their old "received" fields: not posted (they were
// estimates, not money received), listed so the owner checks them
async function unsureReceivedFields() {
  const orders = await Order.find({ unsureOrder: true, $or: [{ receivedUSD: { $gt: 0 } }, { receivedLYD: { $gt: 0 } }, { receivedShipmentUSD: { $gt: 0 } }, { receivedShipmentLYD: { $gt: 0 } }] })
    .select('orderId user totalInvoice receivedUSD receivedLYD receivedShipmentUSD receivedShipmentLYD').lean();
  return { count: orders.length, list: orders.map((o) => ({ orderId: o._id, orderNumber: o.orderId, totalInvoice: o.totalInvoice, usd: (o.receivedUSD || 0) + (o.receivedShipmentUSD || 0), lyd: (o.receivedLYD || 0) + (o.receivedShipmentLYD || 0) })) };
}

// Old "credit" balances (balanceType 'credit', replaced by the wallet long ago): not posted; listed
// with their amounts so the owner decides what to do with any that are not zero (owner's decision)
async function creditBalances() {
  const rows = await Balance.find({ balanceType: 'credit', amount: { $ne: 0 } }).select('owner amount initialAmount currency status notes createdAt').populate('owner', 'firstName lastName customerId').sort({ createdAt: 1 }).lean();
  const totals = {};
  rows.forEach((row) => { totals[row.currency] = Math.round(((totals[row.currency] || 0) + Number(row.amount || 0)) * 1000) / 1000; });
  return {
    count: rows.length,
    totals,
    list: rows.slice(0, LIST_LIMIT).map((row) => ({
      balanceId: row._id, customer: row.owner, amount: row.amount, initialAmount: row.initialAmount, currency: row.currency, status: row.status, notes: row.notes, createdAt: row.createdAt,
    })),
  };
}

// Supplier refunds credited to wallets (spec E4): linked to an order (lower its sale) or not (520200)
async function refundsSummary(runId) {
  const [receivable, refunds] = await Promise.all([resolveAccount('customer_receivable'), resolveAccount('customer_refunds')]);
  const rows = await JournalEntry.aggregate([
    { $match: { migrationRunId: runId, eventType: 'REFUND' } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: [receivable._id, refunds._id] } } },
    { $group: { _id: '$lines.accountId', count: { $sum: 1 }, usd: { $sum: '$lines.debit' } } },
  ]);
  const of = (account) => rows.find((row) => String(row._id) === String(account._id)) || { count: 0, usd: 0 };
  return { linkedToOrders: { count: of(receivable).count, usd: of(receivable).usd }, toRefundsExpense: { count: of(refunds).count, usd: of(refunds).usd } };
}

async function buildReport(run, result) {
  const { settings } = await getConfig();
  const tolerance = settings.recognitionToleranceCents ?? 200;
  const byType = await JournalEntry.aggregate([
    { $match: { migrationRunId: run.runId } },
    { $group: { _id: '$eventType', count: { $sum: 1 }, amount: { $sum: '$totalDebit' } } },
    { $sort: { count: -1 } },
  ]);
  const fallbacks = await JournalEntry.aggregate([
    { $match: { migrationRunId: run.runId, 'fallbacks.0': { $exists: true } } }, { $unwind: '$fallbacks' },
    { $group: { _id: { $substrCP: ['$fallbacks', 0, 60] }, count: { $sum: 1 }, example: { $first: '$fallbacks' }, entryId: { $first: '$_id' } } },
    { $sort: { count: -1 } },
  ]);
  const derivedRates = await CurrencyRate.find({ migrationRunId: run.runId }).sort({ day: 1 }).select('currency day rate').lean();
  const totals = (await JournalEntry.aggregate([
    { $unwind: '$lines' }, { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' }, lines: { $sum: 1 } } },
  ]))[0] || { debit: 0, credit: 0 };
  const suspense = await resolveAccount('migration_suspense');
  const suspenseBalance = (await JournalEntry.aggregate([
    { $match: { 'lines.accountId': suspense._id } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': suspense._id } },
    { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]))[0]?.usd || 0;

  // What went through suspense, by kind of operation (before any closing into the opening balance)
  const suspenseBreakdown = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': suspense._id, eventKey: { $not: /^SUSPENSE_CLOSE:/ } } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': suspense._id } },
    { $group: { _id: '$eventType', count: { $sum: 1 }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $sort: { count: -1 } },
  ]);

  const partnerIds = result.walletDifferences.map((d) => d.partnerId).filter((id) => mongoose.isValidObjectId(id));
  const users = new Map((await User.find({ _id: { $in: partnerIds } }).select('firstName lastName customerId').lean()).map((u) => [String(u._id), u]));
  const claims = await claimsReview(tolerance);

  return {
    generatedAt: new Date(),
    historyStart: run.historyStart,
    cutoff: run.cutoff,
    events: result.events,
    entries: byType.reduce((sum, row) => sum + row.count, 0),
    byEventType: byType.map((row) => ({ eventType: row._id, count: row.count, amount: row.amount })),
    years: await yearlyResults(),
    balanced: totals.debit === totals.credit,
    totals: { debit: totals.debit, credit: totals.credit },
    suspenseBalance,
    suspenseBreakdown: suspenseBreakdown.map((row) => ({ eventType: row._id, count: row.count, net: row.net })),
    suspenseClosed: result.suspenseClosed?.amount ?? null,
    rates: { derived: derivedRates.length, missingEntirely: !!result.rateInfo?.missingEntirely, list: derivedRates.slice(0, 500) },
    fallbacks: fallbacks.map((f) => ({ message: f.example, count: f.count, entryId: f.entryId })),
    walletDifferences: result.walletDifferences.slice(0, LIST_LIMIT).map((d) => ({ ...d, customer: users.get(String(d.partnerId)) })),
    walletDifferencesCount: result.walletDifferences.length,
    deliveredUnpaid: { count: claims.deliveredUnpaid.length, total: claims.deliveredUnpaid.reduce((s, r) => s + r.open, 0), list: claims.deliveredUnpaid.slice(0, LIST_LIMIT) },
    unpaidClaims: { count: claims.unpaid.length, total: claims.unpaid.reduce((s, r) => s + r.open, 0), list: claims.unpaid.slice(0, LIST_LIMIT) },
    overpaid: { count: claims.overpaid.length, total: claims.overpaid.reduce((s, r) => s + r.open, 0), list: claims.overpaid.slice(0, LIST_LIMIT) },
    purchasesWithoutCost: (await purchasesWithoutCost()).slice(0, LIST_LIMIT),
    tripsWithoutCost: (await tripsWithoutCost()).slice(0, LIST_LIMIT),
    openingCash: result.openingCash,
    overpaidSettled: { count: (result.overpaidSettled || []).length, total: (result.overpaidSettled || []).reduce((sum, row) => sum + row.amount, 0), list: (result.overpaidSettled || []).slice(0, LIST_LIMIT) },
    unsurePaid: await unsurePaidOrders(),
    unsureReceived: await unsureReceivedFields(),
    creditBalances: await creditBalances(),
    refunds: await refundsSummary(run.runId),
    debtsWithoutSource: (await JournalEntry.aggregate([
      { $match: { migrationRunId: run.runId, eventType: 'GENERAL_DEBT' } },
      { $group: { _id: null, count: { $sum: 1 }, usd: { $sum: '$totalDebit' } } },
    ]))[0] || { count: 0, usd: 0 },
    problemsCount: run.problems.length,
  };
}

module.exports = { buildReport };
