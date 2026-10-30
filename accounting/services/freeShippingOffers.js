const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../../models/order');
const User = require('../../models/user');
const Balance = require('../../models/balance');
const Payment = require('../../models/orderPaymentHistory');
const { JournalEntry, AccountingEvent } = require('../models');
const { resolveAccount } = require('./roles');
const { getConfig } = require('./config');
const { lockPeriod } = require('./periodLock');
const { lockWalletOwner } = require('../../utils/walletLock');
const { runInTransaction } = require('./transaction');
const { syncOrder, tripAllocation } = require('./claims/sync');
const { shipmentKey, CLAIM_EVENTS, packageChargeCents } = require('./claims/keys');
const { today, addDays } = require('./dates');
const { logAudit } = require('./audit');
const ErrorHandler = require('../../utils/errorHandler');
const fail = (code, text) => new ErrorHandler(code, text);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasShippingData = pkg => !!(String(pkg.deliveredPackages?.trackingNumber || '').trim() ||
  Number(pkg.deliveredPackages?.weight?.total) > 0 || pkg.tripId || pkg.domesticTripId);

// These are candidates for HUMAN review, never inferred to be free merely because unpaid.
async function review({ orderId, session } = {}) {
  if (orderId && !mongoose.isValidObjectId(orderId)) throw fail(400, 'رقم الطلبية غير صالح');
  const { settings } = await getConfig();
  const orders = await Order.find({ isPayment: true, isRemittance: { $ne: true }, isCanceled: { $ne: true },
    isDeleted: { $ne: true }, unsureOrder: { $ne: true }, ...(orderId && { _id: orderId }),
    paymentList: { $elemMatch: { $or: [
      { 'deliveredPackages.trackingNumber': /\S/ }, { 'deliveredPackages.weight.total': { $gt: 0 } },
      { tripId: { $ne: null } }, { domesticTripId: { $ne: null } },
    ] } } })
    .select('orderId user isShipment totalInvoice createdAt updatedAt paymentList').sort({ _id: 1 }).session(session || null).lean();
  const ids = orders.map(order => order._id);
  const roles = ['customer_receivable', 'revenue_shipping_air', 'revenue_shipping_sea', 'revenue_other',
    'trip_cost_wip', 'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices'];
  const accounts = {};
  for (const role of roles) accounts[role] = await resolveAccount(role);
  const rows = ids.length ? await JournalEntry.aggregate([
    { $match: { 'lines.orderId': { $in: ids } } }, { $unwind: '$lines' }, { $match: { 'lines.orderId': { $in: ids } } },
    { $group: { _id: { order: '$lines.orderId', package: '$lines.packageId', key: '$lines.arKey', account: '$lines.accountId', claim: { $in: ['$eventType', CLAIM_EVENTS] } },
      net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, count: { $sum: 1 }, updated: { $max: '$updatedAt' } } },
    { $sort: { '_id.order': 1, '_id.package': 1, '_id.key': 1, '_id.account': 1, '_id.claim': 1 } },
  ]).session(session || null) : [];
  const users = new Map((await User.find({ _id: { $in: orders.map(order => order.user) } }).select('customerId firstName lastName').session(session || null).lean()).map(user => [String(user._id), user]));
  const payments = await Payment.find({ order: { $in: ids }, category: 'receivedGoods', receivedAmount: { $gt: 0 } }).select('order updatedAt').session(session || null).lean();
  const debts = await Balance.find({ order: { $in: ids }, balanceType: 'debt', debtType: 'receivedGoods', status: { $ne: 'canceled' } }).select('order updatedAt').session(session || null).lean();
  const pending = await AccountingEvent.find({ status: { $in: ['pending', 'failed'] }, $or: [{ refId: { $in: ids } }, { 'payload.target.orderId': { $in: ids } }] }).select('refId payload.target.orderId').session(session || null).lean();
  const ctx = { accounts, session, allocations: new Map() };
  const ledgerByOrder = new Map();
  for (const row of rows) {
    const id = String(row._id.order);
    if (!ledgerByOrder.has(id)) ledgerByOrder.set(id, []);
    ledgerByOrder.get(id).push(row);
  }
  const results = [];
  const revenueIds = new Set(['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_other'].map(role => String(accounts[role]._id)));
  const day = settings?.lockDate && today() <= settings.lockDate ? addDays(settings.lockDate, 1) : today();
  for (const order of orders) {
    const ledger = ledgerByOrder.get(String(order._id)) || [];
    for (const pkg of order.paymentList) {
      // A payment/purchase link alone is not a shipment or an offer candidate.
      if (!hasShippingData(pkg)) continue;
      if (pkg.freeShippingOffer?.enabled && !orderId) continue;
      const key = shipmentKey(order._id, pkg._id);
      const claim = ledger.filter(row => row._id.key === key);
      const receivable = claim.filter(row => String(row._id.account) === String(accounts.customer_receivable._id));
      const billed = receivable.filter(row => row._id.claim).reduce((sum, row) => sum + row.net, 0);
      const open = receivable.reduce((sum, row) => sum + row.net, 0);
      const paid = billed - open;
      const recognized = -claim.filter(row => revenueIds.has(String(row._id.account))).reduce((sum, row) => sum + row.net, 0);
      const price = Number(pkg.deliveredPackages?.exiosPrice || 0);
      const charge = packageChargeCents(pkg);
      const hasPayment = payments.some(payment => String(payment.order) === String(order._id));
      const hasDebt = debts.some(debt => String(debt.order) === String(order._id));
      const hasPending = pending.some(event => String(event.refId) === String(order._id) || String(event.payload?.target?.orderId) === String(order._id));
      let blocked = pkg.freeShippingOffer?.enabled ? 'الشحن مجاني ضمن عرض معتمد بالفعل' : !users.has(String(order.user)) ? 'بيانات العميل غير موجودة؛ راجع الطلبية' : !(Number(order.totalInvoice) > 0) ? 'قيمة فاتورة الشراء غير صالحة' :
        !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(charge) || charge < 0 ? 'راجع سعر الشحن أو الوزن' :
        pkg.creditDeliveryInvoiceId ? 'تسليم مرتبط بدفع جزئي أو دين؛ يحتاج معالجة مستقلة' :
        hasPayment || paid !== 0 || Number(pkg.deliveredPackages?.receivedShipmentUSD) > 0 || Number(pkg.deliveredPackages?.receivedShipmentLYD) > 0 ? 'يوجد تحصيل أو تعديل سابق على الشحن؛ لا يُلغى تلقائيًا' :
        hasDebt ? 'يوجد سجل دين شحن مرتبط بالطلبية؛ راجعه أولًا' :
        pkg.deliveredPackages?.abandoned?.status ? 'الطرد ضمن معالجة بضائع متروكة' :
        hasPending ? 'توجد عملية محاسبية معلقة؛ انتظر ترحيلها ثم حدّث القائمة' :
        !settings?.liveEnabled && ledger.length ? 'فعّل المحاسبة قبل تصحيح القيود القديمة' : '';
      let expectedCost = 0;
      if (pkg.status?.received) for (const tripId of new Set([pkg.tripId, pkg.domesticTripId].filter(Boolean).map(String))) {
        expectedCost += (await tripAllocation(tripId, ctx)).shares.get(String(pkg._id)) || 0;
      }
      const currentCost = ledger.filter(row => String(row._id.package) === String(pkg._id) &&
        ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices'].some(role => String(row._id.account) === String(accounts[role]._id)))
        .reduce((sum, row) => sum + row.net, 0);
      const purchaseBookedCost = ledger.filter(row => String(row._id.package) === String(pkg._id) && String(row._id.account) === String(accounts.cost_purchase_invoices._id)).reduce((sum, row) => sum + row.net, 0);
      if (pkg.status?.received && currentCost > 0 && expectedCost === 0) blocked ||= 'توجد تكلفة سابقة دون توزيع رحلة صالح؛ راجع ربط الرحلة أولًا';
      if (![billed, open, paid, recognized, expectedCost, currentCost].every(Number.isSafeInteger) || open < 0 || recognized < 0) blocked ||= 'رصيد غير صالح أو دائن يحتاج مراجعة';
      const row = { key: `${order._id}:${pkg._id}`, orderId: String(order._id), packageId: String(pkg._id), orderNumber: order.orderId,
        customer: users.get(String(order.user)) || null, tracking: pkg.deliveredPackages?.trackingNumber || '', date: order.createdAt,
        invoiceType: order.isShipment ? 'combined' : 'purchase',
        invoiceMinor: Math.round(Number(order.totalInvoice) * 100), chargeMinor: charge, billedMinor: billed,
        openMinor: open, paidMinor: paid, revenueMinor: recognized, currentCostMinor: currentCost,
        purchaseCostMinor: expectedCost, purchaseBookedCostMinor: purchaseBookedCost, profitImpactMinor: -recognized - (expectedCost - currentCost),
        delivered: !!pkg.status?.received, enabled: !!pkg.freeShippingOffer?.enabled, offerReason: pkg.freeShippingOffer?.reason,
        postingDay: day, blocked };
      row.fingerprint = hash({ order: { id: order._id, updated: order.updatedAt, total: order.totalInvoice, user: order.user }, pkg, ledger,
        paid, hasPayment, hasDebt, hasPending, expectedCost, settings: { live: settings?.liveEnabled, lock: settings?.lockDate, guard: settings?.migrationGuardDay, roles: settings?.accountRoles }, day });
      results.push(row);
    }
  }
  return { results, count: results.length, ready: results.filter(row => !row.blocked).length };
}

async function apply(input, req) {
  const items = input.items;
  const reason = String(input.reason || '').trim();
  if (!Array.isArray(items) || !items.length || items.length > 100 || !reason || reason.length > 1000 || input.confirmFreeShipping !== true) throw fail(400, 'اختر حتى 100 طرد واكتب السبب وأكد أنها عروض شحن مجاني فعلًا');
  if (items.some(item => !mongoose.isValidObjectId(item.orderId) || !mongoose.isValidObjectId(item.packageId) || typeof item.fingerprint !== 'string')) throw fail(400, 'اختيار غير صالح');
  if (new Set(items.map(item => `${item.orderId}:${item.packageId}`)).size !== items.length) throw fail(400, 'لا تكرر الطرد في الدفعة');
  const batchId = crypto.randomUUID();
  return runInTransaction(async session => {
    const settings = await lockPeriod(session);
    const orderIds = [...new Set(items.map(item => String(item.orderId)))].sort();
    const orders = [];
    for (const id of orderIds) {
      const order = await Order.findOneAndUpdate({ _id: id }, { $inc: { accountingMutationVersion: 1 } }, { new: true, session, timestamps: false });
      if (!order) throw fail(409, 'الطلبية لم تعد موجودة');
      orders.push(order);
    }
    for (const id of [...new Set(orders.map(order => String(order.user)))].sort()) await lockWalletOwner(id, session);
    // The lock does not change updatedAt; the approved source fingerprint stays comparable.
    const current = new Map();
    for (const id of orderIds) for (const row of (await review({ orderId: id, session })).results) current.set(row.key, row);
    const day = settings?.lockDate && today() <= settings.lockDate ? addDays(settings.lockDate, 1) : today();
    let entries = 0;
    for (const item of items) {
      const row = current.get(`${item.orderId}:${item.packageId}`);
      if (!row || row.fingerprint !== item.fingerprint) throw fail(409, 'تغيرت بيانات الطلبية أو القيود؛ حدّث المعاينة قبل الاعتماد');
      if (row.blocked) throw fail(400, row.blocked);
    }
    for (const order of orders) {
      for (const item of items.filter(item => String(item.orderId) === String(order._id))) {
        const pkg = order.paymentList.id(item.packageId);
        const before = pkg.toObject();
        pkg.freeShippingOffer = { enabled: true, reason, previousUnitPrice: Number(pkg.deliveredPackages.exiosPrice || 0), appliedAt: new Date(), effectiveFrom: new Date(day), appliedBy: req.user._id };
        pkg.deliveredPackages.exiosPrice = 0;
        await logAudit({ req, action: 'shipping.freeOffer.apply', model: 'Order', docId: order._id,
          before: { package: before }, after: { package: pkg.toObject(), day, fingerprint: item.fingerprint, reason, batchId } }, session);
      }
      await order.save({ session });
      if (settings?.liveEnabled) entries += (await syncOrder(order._id, { session, user: req.user, date: day })).posted || 0;
      else await require('./events').emitAccountingEvent('order', order._id, {}, req.user, { session });
    }
    if (settings?.liveEnabled) {
      for (const id of orderIds) {
        const checked = (await review({ orderId: id, session })).results.filter(row => items.some(item => String(item.orderId) === id && String(item.packageId) === row.packageId));
        if (checked.some(row => row.openMinor !== 0 || row.revenueMinor !== 0 || row.billedMinor !== 0 || row.purchaseBookedCostMinor !== row.purchaseCostMinor)) throw fail(409, 'لم تكتمل معالجة مطالبة الشحن أو إيراده أو نقل تكلفته؛ أُلغيت الدفعة');
      }
    }
    return { packages: items.length, orders: orderIds.length, entries, day, batchId };
  });
}

module.exports = { review, apply };
