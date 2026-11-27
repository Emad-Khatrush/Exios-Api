// Customer analytics (owner 2026-11-27): every customer with their real orders, read once and kept
// a few minutes, for the pure analyses in this folder (metrics/*.js).
//
// Source: the orders, which go back years (the ledger only starts in September 2026, too short for
// retention). An order counts as the goals page counts a sale: not cancelled and not a request the
// customer made in the app alone (unsureOrder); a request counts too once one of its packages has
// arrived (abroad, in Libya or delivered). Its value is what the system bills: the purchase invoice
// (totalInvoice, purchase orders only) and each package's shipping (weight x price, free shipping 0).
//
// Beside the orders (second round, owner 2026-11-27): who opened each order (madeBy), when each
// package reached the customer (the ledger's revenue recognition of its shipping), the customers'
// ratings and points, the monthly marketing spend and acquisition gifts, and the accounts the owner
// marked as companies (settings).
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { packageChargeCents } = require('../claims/keys');

const TZ = 'Africa/Tripoli';
const CACHE_MS = 10 * 60 * 1000;
let cache = null;

const isStaff = (u) => !!(u?.roles?.isAdmin || u?.roles?.isEmployee || u?.roles?.isAccountant);
const arrived = (pkg) => !!(pkg?.status?.arrived || pkg?.status?.arrivedLibya || pkg?.status?.received);
const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ');
const monthOf = (date) => moment(date).tz(TZ).format('YYYY-MM');

// What free shipping gave away on a package: its charge had the offer not applied
const freeShippingCents = (pkg) => (pkg?.freeShippingOffer?.enabled
  ? Math.max(packageChargeCents({ ...pkg, freeShippingOffer: { enabled: false } }), 0)
  : 0);

// One order as the analyses see it, or null when it does not count. `deliveredAt` maps
// 'orderId:packageId' to the day the package reached the customer.
function toOrder(o, deliveredAt = new Map()) {
  if (!o || o.isCanceled || o.isDeleted || !o.user) return null;
  const packages = Array.isArray(o.paymentList) ? o.paymentList : [];
  if (o.unsureOrder && !packages.some(arrived)) return null;
  const purchaseCents = o.isPayment ? Math.max(Math.round(Number(o.totalInvoice || 0) * 100), 0) : 0;
  const shippingCents = packages.reduce((sum, pkg) => sum + Math.max(packageChargeCents(pkg), 0), 0);
  const method = o.shipment?.method === 'air' || o.shipment?.method === 'sea' ? o.shipment.method : null;
  return {
    id: String(o._id),
    at: new Date(o.createdAt),
    kind: o.isPayment ? 'purchase' : 'shipment',
    method,
    office: o.placedAt || null,
    madeBy: o.madeBy ? String(o.madeBy) : null,
    purchaseCents,
    shippingCents,
    valueCents: purchaseCents + shippingCents,
    freeShippingCents: packages.reduce((sum, pkg) => sum + freeShippingCents(pkg), 0),
    // Registered at our warehouse abroad, and handed to the customer (null while not yet)
    packages: packages.map((pkg) => {
      const key = `${o._id}:${pkg._id}`;
      const handed = deliveredAt.get(key) || pkg?.deliveredPackages?.deliveredInfo?.deliveredDate || null;
      return {
        id: String(pkg._id),
        arrivedAt: pkg?.deliveredPackages?.arrivedAt ? new Date(pkg.deliveredPackages.arrivedAt) : null,
        deliveredAt: handed ? new Date(handed) : null,
      };
    }),
  };
}

// The customers: client accounts that are not staff, cancelled accounts left out
function toCustomer(u, extras = {}) {
  if (!u || !u.roles?.isClient || isStaff(u) || u.isCanceled) return null;
  const id = String(u._id);
  return {
    id,
    name: fullName(u),
    customerId: u.customerId || null,
    phone: u.phone != null ? String(u.phone) : null,
    city: u.city || null,
    createdAt: u.createdAt ? new Date(u.createdAt) : null,
    invited: !!u.referral?.by,
    isCompany: !!extras.companies?.has(id),
    // Their ratings: how many, and the average of the rating questions (1..5), or null
    rating: extras.ratings?.get(id) || null,
    // Their points: earned (orders, gifts, rewards) and spent (net of what came back)
    loyalty: extras.loyalty?.get(id) || { earned: 0, redeemed: 0 },
    orders: [],
  };
}

// Builds the dataset from plain documents (the tests call it directly). `extras` (all optional):
// { staff: Map(id -> name), deliveredAt: Map('order:package' -> Date), ratings: Map(userId -> { count, avg }),
//   loyalty: Map(userId -> { earned, redeemed }), companies: Set(userId),
//   costs: { marketing: { 'YYYY-MM': cents }, commissions: {…}, gifts: {…} }, targets: {…} }
function build(users, orders, extras = {}) {
  const customers = new Map();
  for (const u of users) {
    const c = toCustomer(u, extras);
    if (c) customers.set(c.id, c);
  }
  for (const raw of orders) {
    const o = toOrder(raw, extras.deliveredAt);
    const c = o && customers.get(String(raw.user));
    if (c) c.orders.push(o);
  }
  for (const c of customers.values()) c.orders.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return {
    customers: [...customers.values()],
    staff: extras.staff || new Map(),
    costs: { marketing: {}, commissions: {}, gifts: {}, ...(extras.costs || {}) },
    targets: extras.targets || {},
    builtAt: new Date(),
  };
}

const USER_FIELDS = { firstName: 1, lastName: 1, customerId: 1, phone: 1, city: 1, createdAt: 1, roles: 1, isCanceled: 1, 'referral.by': 1 };
const ORDER_FIELDS = {
  user: 1, madeBy: 1, createdAt: 1, isCanceled: 1, isDeleted: 1, unsureOrder: 1, isPayment: 1, totalInvoice: 1, placedAt: 1, 'shipment.method': 1,
  'paymentList._id': 1, 'paymentList.status': 1, 'paymentList.freeShippingOffer': 1, 'paymentList.deliveredPackages.weight.total': 1,
  'paymentList.deliveredPackages.exiosPrice': 1, 'paymentList.deliveredPackages.arrivedAt': 1, 'paymentList.deliveredPackages.deliveredInfo.deliveredDate': 1,
};

// When each package reached the customer: the first recognition of its shipping revenue
// (eventKey RECOGNITION:SHP:<order>:<package>:<n>; fee claims end in :DOM / :CUS and are skipped)
async function readDeliveredAt(db) {
  const rows = await db.collection('accountingjournalentries')
    .find({ eventType: 'RECOGNITION', eventKey: /^RECOGNITION:SHP:/ }, { projection: { eventKey: 1, date: 1 } }).toArray();
  const out = new Map();
  for (const row of rows) {
    const [, , orderId, packageId, n] = String(row.eventKey).split(':');
    if (!orderId || !packageId || !/^\d+$/.test(n || '')) continue;
    const key = `${orderId}:${packageId}`;
    const at = new Date(row.date);
    if (!out.has(key) || at < out.get(key)) out.set(key, at);
  }
  return out;
}

// Each customer's ratings: the average of every 'rating' answer (1..5)
async function readRatings(db) {
  const rows = await db.collection('orderratings').find({}, { projection: { user: 1, questions: 1 } }).toArray();
  const acc = new Map();
  for (const row of rows) {
    if (!row.user) continue;
    const values = (row.questions || []).filter((q) => q.type === 'rating' && Number.isFinite(Number(q.value))).map((q) => Number(q.value));
    if (!values.length) continue;
    const id = String(row.user);
    const a = acc.get(id) || { count: 0, sum: 0 };
    a.count += 1;
    a.sum += values.reduce((s, v) => s + v, 0) / values.length;
    acc.set(id, a);
  }
  return new Map([...acc].map(([id, a]) => [id, { count: a.count, avg: a.sum / a.count }]));
}

// Each customer's points: earned (earn, add) and spent (redeem less restore)
async function readLoyalty(db) {
  const rows = await db.collection('loyaltypoints').aggregate([
    { $match: { kind: { $in: ['earn', 'add', 'redeem', 'restore'] } } },
    { $group: { _id: { user: '$user', kind: '$kind' }, points: { $sum: '$points' } } },
  ]).toArray();
  const out = new Map();
  for (const row of rows) {
    const id = String(row._id.user);
    const l = out.get(id) || { earned: 0, redeemed: 0 };
    if (row._id.kind === 'earn' || row._id.kind === 'add') l.earned += row.points;
    if (row._id.kind === 'redeem') l.redeemed += row.points;
    if (row._id.kind === 'restore') l.redeemed -= row.points;
    out.set(id, l);
  }
  for (const l of out.values()) l.redeemed = Math.max(l.redeemed, 0);
  return out;
}

// What acquiring customers cost each month (US cents, Libya months): the marketing accounts
// (531000 and below), staff commissions (530110 and below, shown apart: not all of it is for new
// customers), and the points given to newcomers and their inviters (1 point = 1 cent).
async function readCosts(db) {
  const accounts = await db.collection('accountingaccounts').find({ code: /^(5310|53011)/ }, { projection: { code: 1 } }).toArray();
  const kindOf = new Map(accounts.map((a) => [String(a._id), String(a.code).startsWith('5310') ? 'marketing' : 'commissions']));
  const costs = { marketing: {}, commissions: {}, gifts: {} };
  if (accounts.length) {
    const lines = await db.collection('accountingjournalentries').aggregate([
      { $match: { 'lines.accountId': { $in: accounts.map((a) => a._id) } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': { $in: accounts.map((a) => a._id) } } },
      { $project: { date: 1, accountId: '$lines.accountId', net: { $subtract: ['$lines.debit', '$lines.credit'] } } },
    ]).toArray();
    // Every entry counts, reversed ones too: a reversal is its own entry that cancels the original
    for (const line of lines) {
      const bucket = costs[kindOf.get(String(line.accountId))];
      const month = monthOf(line.date);
      bucket[month] = (bucket[month] || 0) + line.net;
    }
  }
  const gifts = await db.collection('loyaltypoints').find(
    { kind: 'add', eventKey: /^(SIGNUP_GIFT|REFERRAL_)/ }, { projection: { points: 1, createdAt: 1 } },
  ).toArray();
  for (const g of gifts) {
    const month = monthOf(g.createdAt);
    costs.gifts[month] = (costs.gifts[month] || 0) + Number(g.points || 0);
  }
  return costs;
}

async function readSettings(db) {
  const doc = await db.collection('customeranalyticssettings').findOne({ key: 'main' });
  return { companies: new Set((doc?.companies || []).map(String)), targets: doc?.targets || {} };
}

// Reads the database (or the copy kept CACHE_MS); `fresh` reads again
async function loadDataset({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const db = mongoose.connection;
  const [users, staffUsers, orders, deliveredAt, ratings, loyalty, costs, settings] = await Promise.all([
    db.collection('users').find({ 'roles.isClient': true }, { projection: USER_FIELDS }).toArray(),
    db.collection('users').find({ $or: [{ 'roles.isAdmin': true }, { 'roles.isEmployee': true }, { 'roles.isAccountant': true }] }, { projection: { firstName: 1, lastName: 1 } }).toArray(),
    db.collection('orders').find({ isCanceled: { $ne: true }, isDeleted: { $ne: true }, user: { $ne: null } }, { projection: ORDER_FIELDS }).toArray(),
    readDeliveredAt(db),
    readRatings(db),
    readLoyalty(db),
    readCosts(db),
    readSettings(db),
  ]);
  const staff = new Map(staffUsers.map((u) => [String(u._id), fullName(u)]));
  const data = build(users, orders, { staff, deliveredAt, ratings, loyalty, costs, companies: settings.companies, targets: settings.targets });
  cache = { at: Date.now(), data };
  return data;
}

const clearCache = () => { cache = null; };

module.exports = { build, toOrder, toCustomer, loadDataset, clearCache, CACHE_MS, readCosts, readDeliveredAt, readRatings, readLoyalty, readSettings };
