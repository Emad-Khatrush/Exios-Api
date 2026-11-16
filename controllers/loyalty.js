// Loyalty points over HTTP (spec 2026-11-16). Customers only read their own points; staff list
// customers, adjust, redeem on an order and mark an order "no points". Every write runs in one
// transaction; the rules live in accounting/services/loyalty.
const mongoose = require('mongoose');
const Order = require('../models/order');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');
const loyalty = require('../accounting/services/loyalty');
const { runInTransaction } = require('../accounting/services/transaction');

const HISTORY = { limit: loyalty.HISTORY_PAGE_SIZE };
const orderNotFound = () => new ErrorHandler(404, 'الطلبية غير موجودة');

const asList = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((id) => String(id).trim()).filter(Boolean);
  return list.length ? list : undefined;
};
const asPoints = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN);

// A customer's summary with the first page of their history
async function customerPoints(userId) {
  const [summary, history] = await Promise.all([loyalty.summaryOf(userId), loyalty.historyOf(userId, { page: 1, ...HISTORY })]);
  return { ...summary, history };
}

// The claims the app shows a quote for: the invoice of a purchase order, every package of a shipment
async function orderPoints(order, target) {
  const [points, quote] = await Promise.all([
    loyalty.orderLoyalty(order._id),
    loyalty.redeemQuote({ userId: order.user, target }),
  ]);
  return { ...points, quote };
}
const wholeOrderTarget = (order) => (order.isPayment
  ? { orderId: order._id, category: 'invoice' }
  : { orderId: order._id, category: 'receivedGoods', packageIds: (order.paymentList || []).map((p) => p._id) });

async function findOrder(id, filter = {}) {
  if (!mongoose.isValidObjectId(id)) throw orderNotFound();
  const order = await Order.findOne({ _id: id, ...filter }).select('user isPayment paymentList._id').lean();
  if (!order) throw orderNotFound();
  return order;
}

async function findCustomer(id) {
  if (!mongoose.isValidObjectId(id)) throw new ErrorHandler(404, 'العميل غير موجود');
  const user = await User.findById(id).select('_id').lean();
  if (!user) throw new ErrorHandler(404, 'العميل غير موجود');
  return user;
}

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error);
  }
};

// ---- Customers (their own data only) ----

module.exports.mine = handle((req) => customerPoints(req.user._id));

module.exports.myHistory = handle((req) => loyalty.historyOf(req.user._id, { page: req.query.page, ...HISTORY }));

module.exports.myOrder = handle(async (req) => {
  const order = await findOrder(req.params.id, { user: req.user._id });
  return orderPoints(order, wholeOrderTarget(order));
});

// ---- Staff ----

module.exports.customers = handle((req) => loyalty.customersWithPoints({
  search: req.query.search,
  sort: req.query.sort,
  expiringOnly: req.query.expiringOnly === 'true' || req.query.expiringOnly === '1',
  page: req.query.page,
  limit: req.query.limit,
}));

module.exports.customer = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  const [summary, history] = await Promise.all([
    loyalty.summaryOf(user._id),
    loyalty.historyOf(user._id, { page: req.query.page, limit: req.query.limit || HISTORY.limit }),
  ]);
  return { ...summary, history };
});

module.exports.adjust = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  await runInTransaction((session) => loyalty.adjust({ userId: user._id, points: asPoints(req.body?.points), reason: req.body?.reason }, { session, req }));
  return customerPoints(user._id);
});

const staffTarget = (order, source) => {
  const category = source.category ? String(source.category) : undefined;
  const packageIds = asList(source.packageIds);
  if (!category && !packageIds) return wholeOrderTarget(order);
  return { orderId: order._id, ...(category && { category }), ...(packageIds && { packageIds }) };
};

// Staff also see who marked the order "no points" and when
async function withNoPointsAudit(orderId, result) {
  if (!result.noPoints) return result;
  const saved = await Order.findById(orderId).select('loyalty').lean();
  const byId = saved?.loyalty?.by;
  const staff = byId ? await User.findById(byId).select('firstName lastName').lean() : null;
  const name = staff ? [staff.firstName, staff.lastName].filter(Boolean).join(' ') : '';
  return { ...result, noPoints: { ...result.noPoints, by: name || (byId ? String(byId) : ''), at: saved?.loyalty?.at || null } };
}

module.exports.order = handle(async (req) => {
  const order = await findOrder(req.params.id);
  return withNoPointsAudit(order._id, await orderPoints(order, staffTarget(order, req.query)));
});

module.exports.redeem = handle(async (req) => {
  const order = await findOrder(req.params.id);
  const target = staffTarget(order, req.body || {});
  return runInTransaction((session) => loyalty.redeem({ userId: order.user, target, points: asPoints(req.body?.points) }, { session, req }));
});

module.exports.noPoints = handle(async (req) => {
  const order = await findOrder(req.params.id);
  await runInTransaction((session) => loyalty.setNoPoints(order._id, { enabled: req.body?.enabled === true || req.body?.enabled === 'true', reason: req.body?.reason }, { session, req }));
  return withNoPointsAudit(order._id, await loyalty.orderLoyalty(order._id));
});
