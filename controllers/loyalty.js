// Loyalty points over HTTP (spec 2026-11-16). Customers only read their own points; staff list
// customers, adjust, redeem on an order and mark an order "no points". Every write runs in one
// transaction; the rules live in accounting/services/loyalty.
const mongoose = require('mongoose');
const Order = require('../models/order');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');
const loyalty = require('../accounting/services/loyalty');
const levels = require('../accounting/services/loyalty/levels');
const tiers = require('../accounting/services/loyalty/tiers');
const { runInTransaction } = require('../accounting/services/transaction');

const HISTORY = { limit: loyalty.HISTORY_PAGE_SIZE };
const orderNotFound = () => new ErrorHandler(404, 'الطلبية غير موجودة');

const asList = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((id) => String(id).trim()).filter(Boolean);
  return list.length ? list : undefined;
};
const asPoints = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN);

// A customer's summary with the first page of their history and their level
async function customerPoints(userId) {
  const [summary, history, level] = await Promise.all([loyalty.summaryOf(userId), loyalty.historyOf(userId, { page: 1, ...HISTORY }), levels.levelOf(userId)]);
  return { ...summary, history, level };
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

// A customer whose points are switched off gets nothing but { off: true }: the app hides the points
module.exports.mine = handle(async (req) => (await loyalty.isOff(req.user._id) ? { off: true } : customerPoints(req.user._id)));

module.exports.myHistory = handle(async (req) => (await loyalty.isOff(req.user._id)
  ? { rows: [], total: 0 }
  : loyalty.historyOf(req.user._id, { page: req.query.page, type: req.query.type, ...HISTORY })));

module.exports.myOrders = handle((req) => loyalty.ordersPointsOf(req.user._id));

// Every level with its perks (customers and staff)
module.exports.tiers = handle(async () => ({ tiers: tiers.publicTiers() }));

// The app showed the celebration of the customer's new level
module.exports.levelSeen = handle((req) => levels.markSeen(req.user._id));

module.exports.myOrder = handle(async (req) => {
  const order = await findOrder(req.params.id, { user: req.user._id });
  if (await loyalty.isOff(req.user._id)) return { off: true };
  return orderPoints(order, wholeOrderTarget(order));
});

// ---- Staff ----

// The programme at a glance: this month and the last, and the latest movements across customers
module.exports.overview = handle((req) => loyalty.overview({ recent: req.query.recent }));

module.exports.customers = handle((req) => loyalty.customersWithPoints({
  search: req.query.search,
  sort: req.query.sort,
  expiringOnly: req.query.expiringOnly === 'true' || req.query.expiringOnly === '1',
  page: req.query.page,
  limit: req.query.limit,
}));

// Staff see the level's history with the names of who changed it by hand
async function staffLevel(userId) {
  const level = await levels.levelOf(userId, { withHistory: true });
  const ids = [...new Set([level.manual?.by, ...(level.history || []).map((h) => h.by && String(h.by))].filter(Boolean))];
  const staff = new Map((await User.find({ _id: { $in: ids } }).select('firstName lastName').lean())
    .map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ')]));
  return {
    ...level,
    manual: level.manual && { ...level.manual, by: staff.get(level.manual.by) || level.manual.by || '' },
    history: (level.history || []).map((h) => ({ ...h, by: h.by ? staff.get(String(h.by)) || String(h.by) : '' })),
  };
}

module.exports.customer = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  const [summary, history, level] = await Promise.all([
    loyalty.summaryOf(user._id),
    loyalty.historyOf(user._id, { page: req.query.page, limit: req.query.limit || HISTORY.limit, type: req.query.type }),
    staffLevel(user._id),
  ]);
  return { ...summary, history, level, offInfo: summary.off ? await offInfo(user._id) : null };
});

// Who switched the customer's points off, when and why (staff only)
async function offInfo(userId) {
  const user = await User.findById(userId).select('loyaltyOff').lean();
  const off = user?.loyaltyOff;
  if (!off?.at) return null;
  const staff = off.by ? await User.findById(off.by).select('firstName lastName').lean() : null;
  return { at: off.at, reason: off.reason || '', by: staff ? [staff.firstName, staff.lastName].filter(Boolean).join(' ') : null };
}

// Switch a customer's points off (with a reason) or back on
module.exports.setOff = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  await runInTransaction((session) => loyalty.setOff({ userId: user._id, off: req.body?.off === true, reason: req.body?.reason }, { session, req }));
  const [summary, history, level] = await Promise.all([
    loyalty.summaryOf(user._id), loyalty.historyOf(user._id, { page: 1, ...HISTORY }), staffLevel(user._id),
  ]);
  return { ...summary, history, level, offInfo: summary.off ? await offInfo(user._id) : null };
});

// Just the level (badges on the customer and delivery screens)
module.exports.customerLevel = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  return levels.levelOf(user._id);
});

module.exports.setLevel = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  const change = await runInTransaction((session) => levels.setLevel({ userId: user._id, level: String(req.body?.level || ''), reason: req.body?.reason }, { session, req }));
  // Raised by staff: the customer hears of it (a lowered level is not announced)
  const { rankOf } = require('../accounting/services/loyalty/tiers');
  if (change && rankOf(change.to) > rankOf(change.from)) await require('../utils/customerPush').levelUp(user._id, change.to);
  return staffLevel(user._id);
});

module.exports.levelsReport = handle(() => levels.report());

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

// Staff also see each redemption of the order, who made it and whether it was cancelled (names, not ids)
async function withRedemptions(orderId, result) {
  const [redemptions, redeemedBy] = await Promise.all([loyalty.orderRedemptions(orderId), loyalty.redeemedByPart(orderId)]);
  const ids = [...new Set(redemptions.flatMap((r) => [r.by, r.canceled?.by]).filter(Boolean))];
  const staff = new Map((await User.find({ _id: { $in: ids } }).select('firstName lastName').lean())
    .map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ')]));
  const nameOf = (id) => (id ? staff.get(id) || id : '');
  return {
    ...result,
    redeemedBy,
    redemptions: redemptions.map((r) => ({ ...r, by: nameOf(r.by), canceled: r.canceled && { ...r.canceled, by: nameOf(r.canceled.by) } })),
  };
}

module.exports.order = handle(async (req) => {
  const order = await findOrder(req.params.id);
  return withRedemptions(order._id, await withNoPointsAudit(order._id, await orderPoints(order, staffTarget(order, req.query))));
});

// Points already paid on the order (net of cancels), for every staff member who can open it:
// the order page takes them off each due, so they must not depend on the points permission
module.exports.paid = handle(async (req) => {
  const order = await findOrder(req.params.id);
  const redeemedBy = await loyalty.redeemedByPart(order._id);
  const points = redeemedBy.invoice + Object.values(redeemedBy.packages).reduce((sum, value) => sum + value, 0);
  return { redeemedBy, redeemedUsd: points / 100 };
});

module.exports.cancelRedemption = handle(async (req) => {
  const order = await findOrder(req.params.id);
  return runInTransaction((session) => loyalty.cancelRedemption({ orderId: order._id, redemptionId: req.params.redemptionId, reason: req.body?.reason }, { session, req }));
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

// ---- Staff: points at a delivery (the customer page's delivery dialog) ----

// The packages' shipping a delivery can pay with points: { balance, maxPoints, owedCents, billedCents, usedOnTarget }
module.exports.deliveryQuote = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  return loyalty.packagesQuote({ userId: user._id, packageIds: asList(req.query.packageIds) });
});

module.exports.redeemPackages = handle(async (req) => {
  const user = await findCustomer(req.params.id);
  const packageIds = asList(req.body?.packageIds);
  return runInTransaction((session) => loyalty.redeemPackages({ userId: user._id, packageIds, points: asPoints(req.body?.points) }, { session, req }));
});
