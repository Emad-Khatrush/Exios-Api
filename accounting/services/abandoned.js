// Abandoned goods (spec v8). A package that reached Libya and was not collected for
// `abandonAfterDays` (365 by default) is listed; an admin or the owner declares it abandoned from
// the order page. syncOrder then bills the customer only what was paid on it, recognises that as
// revenue, and moves the package's whole cost to cost of sales; the wallet is not touched. The
// declaration can be undone until the goods are sold. Selling them: money into a box or bank
// against 410800 (abandoned goods sales).
const mongoose = require('mongoose');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { postEntry } = require('./ledger');
const { logAudit } = require('./audit');
const { isDay, today, addDays } = require('./dates');
const { isOwner } = require('./access');

const fail = (message, status = 400) => new ErrorHandler(status, message);
const oid = (value) => new mongoose.Types.ObjectId(String(value));

async function assertManager(user) {
  if (user?.roles?.isAdmin || await isOwner(user)) return;
  throw fail('إعلان البضائع المتروكة وبيعها للمدير أو المالك فقط', 403);
}

async function findPackage(orderId, packageId, session) {
  if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(packageId)) throw fail('الطرد غير موجود', 404);
  const order = await Order.findById(orderId).select('orderId placedAt isCanceled paymentList').session(session || null).lean();
  const pkg = order?.paymentList?.find((p) => String(p._id) === String(packageId));
  if (!pkg) throw fail('الطرد غير موجود', 404);
  return { order, pkg };
}

// The day the package reached Libya: its trip's arrival, else its arrival abroad, else the order
async function arrivalOf(pkg, order, trips) {
  const trip = pkg.tripId && trips.get(String(pkg.tripId));
  return trip?.arrivalDate || trip?.inventoryFinishedDate || pkg.deliveredPackages?.arrivedAt || order.createdAt;
}

const sync = async (orderId, session, user) => {
  const { settings } = await getConfig();
  if (!settings?.liveEnabled) return;
  await require('./claims/sync').syncOrder(orderId, { session, user });
};

async function setStatus(orderId, packageId, value, session) {
  await Order.updateOne({ _id: oid(orderId), 'paymentList._id': oid(packageId) }, value
    ? { $set: { 'paymentList.$.deliveredPackages.abandoned': value } }
    : { $unset: { 'paymentList.$.deliveredPackages.abandoned': '' } }, { session });
}

async function declareAbandoned(orderId, packageId, req) {
  await assertManager(req.user);
  return runInTransaction(async (session) => {
    const { order, pkg } = await findPackage(orderId, packageId, session);
    if (order.isCanceled) throw fail('الطلب ملغى');
    if (pkg.status?.received) throw fail('الطرد سُلِّم للعميل');
    if (pkg.deliveredPackages?.abandoned?.status) throw fail('الطرد معلن متروكاً مسبقاً');
    await setStatus(orderId, packageId, { status: 'abandoned', declaredAt: new Date(), declaredBy: req.user._id }, session);
    await sync(order._id, session, req.user);
    await logAudit({ req, action: 'package.abandon', model: 'Order', docId: order._id, after: { packageId, tracking: pkg.deliveredPackages?.trackingNumber } }, session);
    return { status: 'abandoned' };
  });
}

async function restoreAbandoned(orderId, packageId, req) {
  await assertManager(req.user);
  return runInTransaction(async (session) => {
    const { order, pkg } = await findPackage(orderId, packageId, session);
    const state = pkg.deliveredPackages?.abandoned?.status;
    if (!state) throw fail('الطرد غير معلن متروكاً');
    if (state === 'sold') throw fail('بيعت البضاعة؛ لا تراجع بعد البيع');
    await setStatus(orderId, packageId, null, session);
    // The claim and the cost come back as they were
    await sync(order._id, session, req.user);
    await logAudit({ req, action: 'package.abandonUndo', model: 'Order', docId: order._id, after: { packageId } }, session);
    return { status: null };
  });
}

// { day, amount, accountId } in the account's currency; `usdValue` for an account not in dollars
async function sellAbandoned(orderId, packageId, input, req) {
  await assertManager(req.user);
  const { getAccount, toCurrencyMinor, moneyLine, currencyOf, RateBook, resolveAccount } = require('./posting/common');
  return runInTransaction(async (session) => {
    const { order, pkg } = await findPackage(orderId, packageId, session);
    if (pkg.deliveredPackages?.abandoned?.status !== 'abandoned') throw fail('أعلن الطرد متروكاً أولاً');
    const day = input.day || today();
    if (!isDay(day)) throw fail('التاريخ غير صالح');
    const to = await getAccount(input.accountId, 'الخزينة');
    if (!to.isCash) throw fail('اختر الخزينة أو البنك الذي دخل فيه المال');
    const minor = await toCurrencyMinor(input.amount, currencyOf(to));
    if (!minor) throw fail('مبلغ البيع مطلوب');
    const rates = new RateBook(session);
    const usd = currencyOf(to) === 'USD' ? minor : (Number(input.usdValue) > 0 ? Math.round(Number(input.usdValue) * 100) : await rates.toUsd(minor, currencyOf(to), day, input.rate));
    const tracking = pkg.deliveredPackages?.trackingNumber || packageId;
    const label = `بيع بضاعة متروكة ${tracking} - طلب ${order.orderId}`;
    const { offices, settings } = await getConfig();
    const entry = await postEntry({
      eventType: 'ABANDONED_SALE', eventKey: `ABANDONED_SALE:${packageId}`, date: day, description: label,
      source: { model: 'Order', id: order._id }, fallbacks: rates.fallbacks,
      lines: [
        moneyLine(to, 'debit', minor, usd, { label }),
        { accountId: (await resolveAccount('revenue_abandoned_sale'))._id, credit: usd, orderId: order._id, packageId: oid(packageId), office: offices.has(order.placedAt) ? order.placedAt : settings.defaultOffice, label },
      ],
    }, { session, user: req.user });
    await rates.lock();
    await setStatus(orderId, packageId, {
      ...pkg.deliveredPackages.abandoned, status: 'sold',
      sale: { day, amount: Number(input.amount), currency: currencyOf(to), accountId: to._id, usd, entryId: entry._id },
    }, session);
    await logAudit({ req, action: 'package.abandonSale', model: 'Order', docId: order._id, after: { packageId, usd } }, session);
    return { status: 'sold', entryId: entry._id };
  });
}

// The packages of one order with their abandoned state, for the order page
async function orderPackages(orderId, user) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلب غير موجود', 404);
  const order = await Order.findById(orderId).select('orderId createdAt isCanceled paymentList').lean();
  if (!order) throw fail('الطلب غير موجود', 404);
  const { settings } = await getConfig();
  const days = settings?.abandonAfterDays || 365;
  const trips = new Map((await Inventory.find({ _id: { $in: (order.paymentList || []).map((p) => p.tripId).filter(Boolean) } }).select('arrivalDate inventoryFinishedDate').lean()).map((t) => [String(t._id), t]));
  const results = [];
  for (const pkg of order.paymentList || []) {
    const arrived = await arrivalOf(pkg, order, trips);
    const age = arrived ? Math.floor((Date.now() - new Date(arrived).getTime()) / 86400000) : null;
    results.push({
      _id: pkg._id, tracking: pkg.deliveredPackages?.trackingNumber, received: !!pkg.status?.received, arrivedLibya: !!pkg.status?.arrivedLibya,
      arrived, age, overdue: !pkg.status?.received && age !== null && age >= days, abandoned: pkg.deliveredPackages?.abandoned || null,
    });
  }
  return { abandonAfterDays: days, canManage: !!(user?.roles?.isAdmin || await isOwner(user)), results };
}

// Every package not collected for too long, and every one declared abandoned (exceptions, report)
async function abandonedList() {
  const { settings } = await getConfig();
  const days = settings?.abandonAfterDays || 365;
  const cutoff = new Date(`${addDays(today(), -days)}T00:00:00Z`);
  const orders = await Order.find({
    isCanceled: { $ne: true }, unsureOrder: { $ne: true },
    $or: [
      { paymentList: { $elemMatch: { 'status.received': { $ne: true }, 'status.arrivedLibya': true } } },
      { 'paymentList.deliveredPackages.abandoned.status': { $exists: true } },
    ],
  }).select('orderId user createdAt customerInfo.fullName paymentList').lean();
  const tripIds = [...new Set(orders.flatMap((o) => (o.paymentList || []).map((p) => p.tripId).filter(Boolean).map(String)))];
  const trips = new Map((await Inventory.find({ _id: { $in: tripIds.map(oid) } }).select('arrivalDate inventoryFinishedDate').lean()).map((t) => [String(t._id), t]));
  const results = [];
  for (const order of orders) {
    for (const pkg of order.paymentList || []) {
      const state = pkg.deliveredPackages?.abandoned?.status;
      if (pkg.status?.received && !state) continue;
      const arrived = await arrivalOf(pkg, order, trips);
      if (!state && (!pkg.status?.arrivedLibya || !arrived || new Date(arrived) >= cutoff)) continue;
      results.push({
        orderId: order._id, orderNumber: order.orderId, customer: order.customerInfo?.fullName, packageId: pkg._id,
        tracking: pkg.deliveredPackages?.trackingNumber, arrived, status: state || 'waiting',
        charge: require('./claims/keys').packageChargeCents(pkg),
      });
    }
  }
  return { abandonAfterDays: days, results };
}

module.exports = { declareAbandoned, restoreAbandoned, sellAbandoned, orderPackages, abandonedList };
