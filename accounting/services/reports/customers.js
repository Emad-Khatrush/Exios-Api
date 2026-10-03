// Customers and their invoices as the books see them (the "sales and customers" part of the
// accounting section). Read from the ledger; the order and the customer only give names, dates
// and the invoice as typed in the system.
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { JournalEntry } = require('../../models');
const Order = require('../../../models/order');
const User = require('../../../models/user');
const Wallet = require('../../../models/wallet');
const { getConfig } = require('../config');
const { TZ } = require('../dates');
const { roleIds } = require('./operations');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const USER_FIELDS = 'firstName lastName customerId phone';

// Customers whose name, number or phone matches the search
async function usersMatching(search, limit = 200) {
  const pattern = new RegExp(escapeRegex(search), 'i');
  const or = [{ customerId: pattern }, { firstName: pattern }, { lastName: pattern }];
  if (/^\d{4,}$/.test(search)) or.push({ phone: Number(search) });
  return User.find({ $or: or }).select(USER_FIELDS).limit(limit).lean();
}

// Every customer with something in the books: what they owe, what their two wallets hold (and
// whether that is what the system's wallets say), their last movement.
// view: 'all' | 'owing' (owe us) | 'wallet' (money in a wallet) | 'mismatch' (wallet differs from the system)
async function customersList({ search, view = 'all', limit = 500 } = {}) {
  const roles = await roleIds(['customer_receivable', 'wallet_usd', 'wallet_lyd']);
  const accountIds = Object.values(roles).filter(Boolean).map(oid);
  const searched = search ? await usersMatching(search) : null;
  // On the whole entry only "some line has a partner" can be asked ($ne: null there would mean
  // "no line lacks one" and drop every entry with a cash line)
  const partner = searched ? { $in: searched.map((u) => u._id) } : { $exists: true };
  const entryMatch = { 'lines.accountId': { $in: accountIds }, 'lines.partnerId': partner };
  const lineMatch = { 'lines.accountId': { $in: accountIds }, 'lines.partnerId': searched ? partner : { $exists: true, $ne: null } };
  const rows = await JournalEntry.aggregate([
    { $match: entryMatch }, { $unwind: '$lines' }, { $match: lineMatch },
    {
      $group: {
        _id: { partnerId: '$lines.partnerId', accountId: '$lines.accountId' },
        net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } },
        lastDay: { $max: '$day' }, movements: { $sum: 1 },
      },
    },
  ]);

  const byCustomer = new Map();
  const customer = (id) => {
    const key = String(id);
    if (!byCustomer.has(key)) byCustomer.set(key, { partnerId: id, owed: 0, walletUsd: 0, walletLyd: 0, lastDay: null, movements: 0 });
    return byCustomer.get(key);
  };
  rows.forEach(({ _id, net, foreign, lastDay, movements }) => {
    const item = customer(_id.partnerId);
    const account = String(_id.accountId);
    if (account === roles.customer_receivable) item.owed += net;
    if (account === roles.wallet_usd) item.walletUsd -= net;
    if (account === roles.wallet_lyd) item.walletLyd -= foreign;
    if (!item.lastDay || lastDay > item.lastDay) item.lastDay = lastDay;
    item.movements += movements;
  });
  // A searched customer with nothing in the books still shows (with zeros)
  (searched || []).forEach((user) => customer(user._id));

  // The system's own wallets, to show where the books and the system disagree
  const { currencies } = await getConfig();
  const inMinor = (value, currency) => Math.round(Math.max(0, Number(value) || 0) * 10 ** (currencies.get(currency)?.decimals ?? 2));
  const ids = [...byCustomer.values()].map((item) => item.partnerId);
  const wallets = await Wallet.find({ user: { $in: ids } }).select('user currency balance').lean();
  wallets.forEach((wallet) => {
    const item = byCustomer.get(String(wallet.user));
    if (!item) return;
    if (wallet.currency === 'USD') item.systemUsd = inMinor(wallet.balance, 'USD');
    if (wallet.currency === 'LYD') item.systemLyd = inMinor(wallet.balance, 'LYD');
  });

  let list = [...byCustomer.values()].map((item) => ({
    ...item, systemUsd: item.systemUsd || 0, systemLyd: item.systemLyd || 0,
    matches: (item.systemUsd || 0) === item.walletUsd && (item.systemLyd || 0) === item.walletLyd,
  }));
  if (view === 'owing') list = list.filter((item) => item.owed > 0);
  if (view === 'wallet') list = list.filter((item) => item.walletUsd > 0 || item.walletLyd > 0);
  if (view === 'mismatch') list = list.filter((item) => !item.matches);
  list.sort((a, b) => b.owed - a.owed || b.walletUsd - a.walletUsd || String(b.lastDay).localeCompare(String(a.lastDay)));

  const totals = {
    customers: list.length,
    owed: list.reduce((sum, item) => sum + Math.max(0, item.owed), 0),
    overpaid: list.reduce((sum, item) => sum + Math.min(0, item.owed), 0),
    walletUsd: list.reduce((sum, item) => sum + item.walletUsd, 0),
    walletLyd: list.reduce((sum, item) => sum + item.walletLyd, 0),
    mismatches: list.filter((item) => !item.matches).length,
  };
  const shown = list.slice(0, limit);
  const users = searched
    ? new Map(searched.map((u) => [String(u._id), u]))
    : new Map((await User.find({ _id: { $in: shown.map((item) => item.partnerId) } }).select(USER_FIELDS).lean()).map((u) => [String(u._id), u]));
  return { totals, results: shown.map((item) => ({ ...item, customer: users.get(String(item.partnerId)) || null })), truncated: list.length > shown.length };
}

// Alipay transfers and customs clearance have their own revenue and cost accounts (spec 19.5, decision 111)
const REVENUE = ['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic', 'revenue_other', 'revenue_purchase_invoices', 'revenue_remittance', 'revenue_customs'];
const DEFERRED = ['deferred_shipping_revenue', 'deferred_purchase_revenue'];
const COST = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices', 'cost_remittance', 'cost_customs'];
const WIP = ['purchase_cost_wip', 'customs_cost_wip'];

const dayStart = (day) => moment.tz(day, TZ).startOf('day').toDate();
const dayEnd = (day) => moment.tz(day, TZ).endOf('day').toDate();

// The customers' invoices (orders): what was billed to the customer in the books, paid and still
// open, revenue recognised or waiting, the cost on it and the profit.
// kind: 'purchase' (a purchase invoice) | 'shipment' (shipping only)
// status: 'unpaid' | 'partial' | 'paid' | 'none' (nothing in the books) | 'canceled'
async function customerInvoices({ search, kind, status, office, from, to, userId, limit = 300 } = {}) {
  const query = {};
  if (kind === 'purchase') query.isPayment = true;
  if (kind === 'shipment') query.isPayment = { $ne: true };
  if (office) query.placedAt = office;
  if (userId) query.user = oid(userId);
  if (from || to) query.createdAt = { ...(from && { $gte: dayStart(from) }), ...(to && { $lte: dayEnd(to) }) };
  if (status === 'canceled') query.isCanceled = true;
  // Orders deleted by mistake appear only under their own filter, with a "deleted" badge
  if (status === 'deleted') query.isDeleted = true;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await usersMatching(search, 100);
    query.$or = [{ orderId: pattern }, { 'customerInfo.fullName': pattern }, ...(users.length ? [{ user: { $in: users.map((u) => u._id) } }] : [])];
  }
  const orders = await Order.find(query)
    .select('orderId user customerInfo.fullName placedAt isPayment isShipment isCanceled isDeleted unsureOrder invoiceConfirmed totalInvoice createdAt paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice paymentList.deliveredPackages.domesticFee paymentList.deliveredPackages.customsFee')
    .sort({ createdAt: -1 }).limit(2000).lean();

  const roles = await roleIds(['customer_receivable', ...REVENUE, ...DEFERRED, ...COST, ...WIP]);
  const accountIds = Object.values(roles).filter(Boolean).map(oid);
  const lineMatch = { 'lines.orderId': { $in: orders.map((o) => o._id) }, 'lines.accountId': { $in: accountIds } };
  const rows = orders.length ? await JournalEntry.aggregate([
    { $match: lineMatch }, { $unwind: '$lines' }, { $match: lineMatch },
    { $group: { _id: { orderId: '$lines.orderId', accountId: '$lines.accountId' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]) : [];
  const ledger = new Map();
  rows.forEach(({ _id, net }) => {
    const key = String(_id.orderId);
    if (!ledger.has(key)) ledger.set(key, new Map());
    ledger.get(key).set(String(_id.accountId), net);
  });
  const sum = (map, list) => list.reduce((total, role) => total + (map?.get(roles[role]) || 0), 0);

  const users = new Map((await User.find({ _id: { $in: [...new Set(orders.map((o) => String(o.user)).filter((id) => mongoose.isValidObjectId(id)))] } }).select(USER_FIELDS).lean()).map((u) => [String(u._id), u]));

  let list = orders.map((order) => {
    const books = ledger.get(String(order._id));
    const open = sum(books, ['customer_receivable']);
    const recognized = -sum(books, REVENUE) || 0;
    const deferred = -sum(books, DEFERRED) || 0;
    const cost = sum(books, COST);
    const costInProgress = sum(books, WIP);
    const billed = recognized + deferred;
    const paid = billed - open;
    const shipping = (order.paymentList || []).reduce((total, pkg) => total + require('../claims/keys').packageChargeCents(pkg) / 100 + Number(pkg.deliveredPackages?.domesticFee?.usd || 0) + Number(pkg.deliveredPackages?.customsFee?.usd || 0), 0);
    let state = 'none';
    if (order.isDeleted) state = 'deleted';
    else if (order.isCanceled) state = 'canceled';
    else if (books) state = open > 0 ? (paid > 0 ? 'partial' : 'unpaid') : billed > 0 ? 'paid' : 'none';
    return {
      _id: order._id, orderNumber: order.orderId, date: order.createdAt, office: order.placedAt,
      kind: order.isPayment ? 'purchase' : 'shipment', isShipment: !!order.isShipment, unsure: !!order.unsureOrder, confirmed: !!order.invoiceConfirmed,
      customerName: order.customerInfo?.fullName, userId: order.user, customer: users.get(String(order.user)) || null,
      invoice: Math.round(Number(order.isPayment ? order.totalInvoice || 0 : 0) * 100), shipping: Math.round(shipping * 100),
      billed, paid, open, recognized, deferred, cost, costInProgress, profit: recognized - cost, status: state,
    };
  });
  if (status && status !== 'canceled' && status !== 'deleted') list = list.filter((row) => row.status === status);
  const total = (field) => list.reduce((s, row) => s + row[field], 0);
  return {
    totals: {
      count: list.length, billed: total('billed'), paid: total('paid'), open: total('open'), recognized: total('recognized'),
      deferred: total('deferred'), cost: total('cost'), profit: total('profit'),
    },
    results: list.slice(0, limit), truncated: list.length > limit || orders.length === 2000,
  };
}

module.exports = { customersList, customerInvoices };
