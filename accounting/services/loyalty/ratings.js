// Rating rewards (spec 2026-11-19-rating-rewards-design.md): every order a customer rates within 30
// days of receiving it earns 2 points (owner, 2026-11-19; only orders from the programme's start), and one rating covers every order they received and have not
// rated yet. A shipment is received once a package was handed over; a purchase once it was bought.
const mongoose = require('mongoose');
const Order = require('../../../models/order');
const OrderRating = require('../../../models/orderRating');
const ErrorHandler = require('../../../utils/errorHandler');

const POINTS_EACH = 2;
const DAYS = 30;
const REASON = 'مكافأة تقييم الخدمة';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORDERS = 50;
const FIELDS = 'orderId user createdAt updatedAt isCanceled isPayment isShipment isRemittance isFinished orderStatus '
  + 'paymentList.status paymentList.deliveredPackages.deliveredInfo paymentList.deliveredPackages.trackingNumber';

const isPurchase = (o) => !!o.isPayment && !o.isShipment;

// When the service was delivered, or null when it was not yet
function deliveredAt(o) {
  if (isPurchase(o)) return Number(o.orderStatus) >= 1 ? new Date(o.updatedAt || o.createdAt) : null;
  const received = (o.paymentList || []).filter((p) => p?.status?.received);
  if (!received.length && !o.isFinished) return null;
  const dates = received.map((p) => p.deliveredPackages?.deliveredInfo?.deliveredDate).filter(Boolean).map((d) => new Date(d).getTime());
  return new Date(dates.length ? Math.max(...dates) : new Date(o.updatedAt || o.createdAt).getTime());
}

// Points start with the loyalty programme, and only within 30 days of delivery
function earns(o, at, now) {
  const start = require('./index').loyaltyStartDate();
  return !!start && new Date(o.createdAt) >= start && at.getTime() >= now.getTime() - DAYS * DAY_MS;
}

// The customer's delivered orders that have no rating (some of them, when ids are given)
async function rateable(userId, { ids, session } = {}) {
  const filter = { user: userId, isCanceled: { $ne: true }, ...(ids && { _id: { $in: ids } }) };
  const orders = await Order.find(filter).select(FIELDS).session(session || null).lean();
  const rated = new Set((await OrderRating.distinct('order', { order: { $in: orders.map((o) => o._id) } }).session(session || null)).map(String));
  return orders
    .filter((o) => !rated.has(String(o._id)))
    .map((o) => ({ order: o, at: deliveredAt(o) }))
    .filter((r) => r.at);
}

// What awaits rating now (and earns): newest delivery first
async function pendingFor(userId, { now = new Date() } = {}) {
  return (await rateable(userId))
    .filter(({ order, at }) => earns(order, at, now))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ORDERS)
    .map(({ order, at }) => ({
      _id: order._id,
      orderId: order.orderId,
      kind: isPurchase(order) ? (order.isRemittance ? 'remittance' : 'purchase') : 'shipping',
      trackingNumbers: (order.paymentList || []).map((p) => String(p?.deliveredPackages?.trackingNumber || '').trim()).filter(Boolean),
      deliveredAt: at,
    }));
}

// The answers the order page asks: two ratings of 1 to 5 and a few words
const QUESTION_NAMES = ['employeeQuestion', 'generalQuestion', 'reviewQuestion'];
function checkQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const byName = new Map(list.map((q) => [q?.name, q]));
  const ok = QUESTION_NAMES.every((name) => byName.has(name))
    && ['employeeQuestion', 'generalQuestion'].every((name) => [1, 2, 3, 4, 5].includes(Number(byName.get(name).value)))
    && String(byName.get('reviewQuestion').value || '').trim();
  if (!ok) throw new ErrorHandler(400, 'قيّم بالنجوم واكتب رأيك قبل الإرسال.');
  return QUESTION_NAMES.map((name) => {
    const q = byName.get(name);
    return { name, type: name === 'reviewQuestion' ? 'text' : 'rating', label: String(q.label || name).slice(0, 200),
      value: name === 'reviewQuestion' ? String(q.value).trim().slice(0, 2000) : Number(q.value) };
  });
}

// One rating for these orders: each of the customer's own delivered, unrated ones gets the rating, and
// 2 points when it earns (once ever: the gift's eventKey). Runs inside the caller's transaction.
async function rate({ userId, orderIds, questions }, { now = new Date(), session } = {}) {
  const answers = checkQuestions(questions);
  const ids = [...new Set((orderIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, MAX_ORDERS);
  const rows = ids.length ? await rateable(userId, { ids, session }) : [];
  if (!rows.length) throw new ErrorHandler(400, 'لا توجد طلبيات تنتظر تقييمك.');
  const loyalty = require('./index');
  const off = await loyalty.isOff(userId, session);
  let points = 0;
  for (const { order, at } of rows) {
    await OrderRating.create([{ user: userId, order: order._id, questions: answers }], { session });
    if (off || !earns(order, at, now)) continue;
    const gift = await loyalty.grantGift({ userId, points: POINTS_EACH, reason: REASON, eventKey: `RATING:${order._id}`, now }, session);
    if (gift) points += POINTS_EACH;
  }
  return { rated: rows.length, points };
}

// Customers who received orders they can rate for points, told once per order: each order is claimed
// atomically (ratingRemindedAt), then one push per customer with how many it was. The hourly job.
// One run at a time: two at once could each claim a different order of one customer and both push
let reminding = null;
function remindDue(options) {
  if (reminding) return reminding.then(() => ({ reminded: 0 }));
  reminding = remindOnce(options).finally(() => { reminding = null; });
  return reminding;
}

async function remindOnce({ now = new Date() } = {}) {
  const start = require('./index').loyaltyStartDate();
  if (!start) return { reminded: 0 };
  const since = new Date(now.getTime() - DAYS * DAY_MS);
  const candidates = await Order.find({
    isCanceled: { $ne: true }, createdAt: { $gte: start }, ratingRemindedAt: { $exists: false },
    $or: [{ 'paymentList.status.received': true }, { isFinished: true }, { isPayment: true, isShipment: { $ne: true }, orderStatus: { $gte: 1 } }],
  }).select(FIELDS).lean();
  const rated = new Set((await OrderRating.distinct('order', { order: { $in: candidates.map((o) => o._id) } })).map(String));
  const loyalty = require('./index');
  const byUser = new Map();
  for (const o of candidates) {
    const at = deliveredAt(o);
    if (!at || at < since || rated.has(String(o._id))) continue;
    const key = String(o.user);
    byUser.set(key, [...(byUser.get(key) || []), o]);
  }
  let reminded = 0;
  for (const [userId, orders] of byUser) {
    if (await loyalty.isOff(userId)) continue;
    let claimed = 0;
    for (const o of orders) {
      const res = await Order.updateOne({ _id: o._id, ratingRemindedAt: { $exists: false } }, { $set: { ratingRemindedAt: now } });
      if (res.modifiedCount) claimed += 1;
    }
    if (!claimed) continue;
    reminded += 1;
    await require('../../../utils/customerPush').ratingReminder(userId, claimed);
  }
  return { reminded };
}

module.exports = { POINTS_EACH, DAYS, REASON, deliveredAt, pendingFor, rate, remindDue };
