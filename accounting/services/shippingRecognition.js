// Review legacy delivered packages before moving their remaining deferred revenue.
// Corrections are dated in the current open period; historical entries are preserved.
const crypto = require('crypto');
const { JournalEntry } = require('../models');
const Order = require('../../models/order');
const { resolveAccount } = require('./roles');
const { lockPeriod } = require('./periodLock');
const { runInTransaction } = require('./transaction');
const { syncOrder, tripAllocation } = require('./claims/sync');
const { logAudit } = require('./audit');
const { today, addDays } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');

async function review({ session } = {}) {
  const orders = await Order.find({ isCanceled: { $ne: true }, unsureOrder: { $ne: true }, 'paymentList.status.received': true })
    .select('orderId createdAt paymentList._id paymentList.tripId paymentList.domesticTripId paymentList.status.received paymentList.freeShippingOffer paymentList.deliveredPackages').session(session || null).lean();
  const delivered = new Map();
  orders.forEach(order => order.paymentList.forEach(pkg => {
    if (pkg.status?.received) delivered.set(String(pkg._id), { orderId: order._id, orderNumber: order.orderId, date: order.createdAt, packageId: pkg._id, tripId: pkg.tripId, domesticTripId: pkg.domesticTripId, tracking: pkg.deliveredPackages?.trackingNumber, zeroCharge: require('./claims/keys').packageChargeCents(pkg) === 0 });
  }));
  const deferred = await resolveAccount('deferred_shipping_revenue');
  const match = { 'lines.accountId': deferred._id, 'lines.packageId': { $in: [...delivered.values()].map(pkg => pkg.packageId) }, 'lines.arKey': /^SHP:/ };
  const amounts = delivered.size ? await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' }, { $match: match },
    { $group: { _id: '$lines.packageId', amount: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null) : [];
  const remaining = new Map(amounts.map(item => [String(item._id), item.amount]));
  let rows = [...delivered.values()].filter(item => remaining.has(String(item.packageId)) || item.zeroCharge)
    .map(item => ({ ...item, revenueToRecognize: Math.max(remaining.get(String(item.packageId)) || 0, 0) }))
    .sort((a, b) => String(a.packageId).localeCompare(String(b.packageId)));
  if (rows.length) {
    const costRoles = ['trip_cost_wip', 'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices', 'customs_cost_wip'];
    const accounts = {};
    for (const role of costRoles) accounts[role] = await resolveAccount(role);
    const costMatch = { 'lines.packageId': { $in: rows.map(row => row.packageId) }, 'lines.accountId': { $in: costRoles.slice(1).map(role => accounts[role]._id) } };
    const costs = await JournalEntry.aggregate([
      { $match: costMatch }, { $unwind: '$lines' }, { $match: costMatch },
      { $group: { _id: { packageId: '$lines.packageId', accountId: '$lines.accountId' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]).session(session || null);
    const ctx = { session, accounts, allocations: new Map() };
    for (const row of rows) {
      let expected = 0;
      for (const tripId of new Set([row.tripId, row.domesticTripId].filter(Boolean).map(String))) {
        expected += (await tripAllocation(tripId, ctx)).shares.get(String(row.packageId)) || 0;
      }
      const existing = costs.filter(cost => String(cost._id.packageId) === String(row.packageId));
      const recognized = existing.filter(cost => String(cost._id.accountId) !== String(accounts.customs_cost_wip._id)).reduce((sum, cost) => sum + cost.net, 0);
      const customs = existing.filter(cost => String(cost._id.accountId) === String(accounts.customs_cost_wip._id)).reduce((sum, cost) => sum + cost.net, 0);
      row.costToRecognize = expected - recognized + customs;
      row.profitImpact = row.revenueToRecognize - row.costToRecognize;
    }
  }
  // Cost-only differences (including free shipping) also need review. An already
  // recognised sale is not posted again just to release the remaining trip cost.
  rows = rows.filter(row => row.revenueToRecognize > 0 || row.costToRecognize !== 0);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { rows, fingerprint, packages: rows.length, orders: new Set(rows.map(row => String(row.orderId))).size,
    revenueToRecognize: rows.reduce((sum, row) => sum + row.revenueToRecognize, 0),
    costToRecognize: rows.reduce((sum, row) => sum + row.costToRecognize, 0),
    profitImpact: rows.reduce((sum, row) => sum + row.profitImpact, 0) };
}

async function apply(input, req) {
  if (!Array.isArray(input.orderIds) || !input.orderIds.length || input.orderIds.length > 100) throw new ErrorHandler(400, 'اختر من طلبية إلى 100 طلبية للمراجعة في الدفعة الواحدة');
  return runInTransaction(async session => {
    const settings = await lockPeriod(session);
    if (!settings?.liveEnabled) throw new ErrorHandler(400, 'فعّل الترحيل الحي قبل تطبيق تسوية التسليمات القديمة');
    const current = await review({ session });
    if (input.fingerprint !== current.fingerprint) throw new ErrorHandler(409, 'تغيرت البيانات؛ أعد معاينة الأثر قبل التطبيق');
    const allowed = new Set(current.rows.map(row => String(row.orderId)));
    const orderIds = [...new Set(input.orderIds.map(String))];
    if (orderIds.some(id => !allowed.has(id))) throw new ErrorHandler(400, 'بعض الطلبيات لم تعد ضمن التسليمات المحتاجة للتسوية');
    const day = settings.lockDate && today() <= settings.lockDate ? addDays(settings.lockDate, 1) : today();
    let entries = 0;
    for (const id of orderIds) {
      await Order.updateOne({ _id: id }, {
        $inc: { accountingMutationVersion: 1 },
        $set: { 'paymentList.$[delivered].shippingRecognitionFrom': new Date(day) },
      }, { session, arrayFilters: [{ 'delivered.status.received': true, 'delivered.shippingRecognitionFrom': { $exists: false } }] });
      const result = await syncOrder(id, { session, user: req.user, date: day, shippingRecognitionOnly: true });
      entries += result.posted || 0;
    }
    await logAudit({ req, action: 'shipping.recognition.reconcile', model: 'Order', after: {
      day, orderIds, entries, reviewedFingerprint: input.fingerprint,
      revenueToRecognize: current.rows.filter(row => orderIds.includes(String(row.orderId))).reduce((sum, row) => sum + row.revenueToRecognize, 0),
    } }, session);
    return { day, orders: orderIds.length, entries };
  });
}

module.exports = { review, apply };
