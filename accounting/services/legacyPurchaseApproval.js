const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../../models/order');
const { SupplierBill, Vendor } = require('../models/documents');
const { createBill } = require('./posting/payables');
const { assertOpenPeriod } = require('./periodGuard');
const { logAudit } = require('./audit');
const { today, isDay, toDay } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');
const fail = (status, text) => new ErrorHandler(status, text);
const same = (a, b) => String(a || '') === String(b || '');
const fingerprint = item => crypto.createHash('sha256').update(JSON.stringify([
  String(item._id), Number(item.unitPrice), item.currency || 'USD', item.description || '', item.date || null,
])).digest('hex');
const active = itemId => ({ status: { $ne: 'canceled' }, isCreditNote: { $ne: true },
  $or: [{ idempotencyKey: `MIG:PURCH:${itemId}` }, { 'lines.purchaseItemId': itemId }] });
const readOrder = async (orderId, session) => {
  if (!mongoose.isValidObjectId(orderId)) throw fail(400, 'مرجع الطلبية غير صالح');
  const order = await Order.findById(orderId).select('orderId isCanceled purchaseItems placedAt').session(session || null).lean();
  if (!order) throw fail(404, 'الطلبية غير موجودة');
  return order;
};

async function list(orderId) {
  const order = await readOrder(orderId);
  const items = order.purchaseItems || [];
  const bills = await SupplierBill.find({ status: { $ne: 'canceled' }, isCreditNote: { $ne: true },
    $or: [{ 'lines.orderId': order._id }, { idempotencyKey: { $in: items.map(item => `MIG:PURCH:${item._id}`) } }] })
    .select('number status currency day total lines idempotencyKey').lean();
  return { orderNumber: order.orderId, canceled: !!order.isCanceled, results: items.map(item => {
    const linked = bills.filter(bill => bill.idempotencyKey === `MIG:PURCH:${item._id}` || bill.lines.some(line => same(line.purchaseItemId, item._id)));
    const candidates = bills.flatMap(bill => bill.currency === (item.currency || 'USD') ? bill.lines.filter(line => line.target === 'order'
      && same(line.orderId, order._id) && !line.purchaseItemId && Math.abs(Number(line.amount) - Number(item.unitPrice)) < 0.0005)
      .map(line => ({ billId: bill._id, lineId: line._id, number: bill.number, day: bill.day, description: line.description, amount: line.amount, currency: bill.currency })) : []);
    return { ...item, fingerprint: fingerprint(item), linkedBills: linked.map(bill => ({ _id: bill._id, number: bill.number, status: bill.status })), candidates };
  }) };
}

async function approve(orderId, itemId, input, { session, req }) {
  if (!mongoose.isValidObjectId(itemId)) throw fail(400, 'مرجع بند المشتريات غير صالح');
  // All paths which attach purchaseItemId also contend on the order's version.
  await readOrder(orderId, session);
  await Order.updateOne({ _id: orderId }, { $inc: { accountingMutationVersion: 1 } }, { session });
  const order = await readOrder(orderId, session);
  if (order.isCanceled) throw fail(400, 'الطلبية ملغاة؛ راجع تكلفتها من المحاسبة بدل إضافة تكلفة جديدة');
  const item = order.purchaseItems?.find(row => same(row._id, itemId));
  if (!item || !(Number(item.unitPrice) > 0)) throw fail(400, 'بند المشتريات غير موجود أو مبلغه غير صالح');
  const existing = await SupplierBill.find(active(item._id)).session(session).lean();
  if (existing.length > 1) throw fail(409, 'البند مرتبط بأكثر من فاتورة؛ راجع الارتباطات قبل المتابعة');
  if (existing.length) return { bill: existing[0], replayed: true };
  if (input.fingerprint !== fingerprint(item)) throw fail(409, 'تغير بند المشتريات؛ حدّث الصفحة وراجعه مجددًا');
  if (!['create', 'link'].includes(input.mode)) throw fail(400, 'اختر اعتماد فاتورة جديدة أو ربط فاتورة موجودة');

  if (input.mode === 'link') {
    if (!mongoose.isValidObjectId(input.billId) || !mongoose.isValidObjectId(input.lineId)) throw fail(400, 'اختر فاتورة المورد وسطرها');
    const bill = await SupplierBill.findOne({ _id: input.billId, status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true } }).session(session);
    const line = bill?.lines?.id(input.lineId);
    if (!line || line.target !== 'order' || !same(line.orderId, order._id) || line.purchaseItemId
      || bill.currency !== (item.currency || 'USD') || Math.abs(Number(line.amount) - Number(item.unitPrice)) > 0.0005) throw fail(400, 'السطر يجب أن يكون لنفس الطلبية وبنفس المبلغ والعملة، ودون ارتباط ببند آخر');
    await assertOpenPeriod(req.user, bill.day, { session });
    const before = { billId: bill._id, lineId: line._id };
    line.purchaseItemId = item._id;
    await bill.save({ session });
    await logAudit({ req, action: 'bill.link.purchaseItem', model: 'AccountingSupplierBill', docId: bill._id, before,
      after: { orderId: order._id, purchaseItemId: item._id, lineId: line._id, amount: line.amount, currency: bill.currency } }, session);
    return { bill, linkedExisting: true };
  }

  if (!isDay(input.day) || input.day > today()) throw fail(400, 'اختر تاريخ اعتماد صحيحًا لا يتجاوز اليوم');
  if (input.confirmNewCost !== true) throw fail(400, 'أكد مراجعة البند وعدم تسجيل تكلفته سابقًا');
  if (input.rate !== undefined && (!Number.isFinite(Number(input.rate)) || Number(input.rate) <= 0)) throw fail(400, 'سعر الصرف غير صالح');
  await assertOpenPeriod(req.user, input.day, { session });
  if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)) throw fail(400, 'مرجع الاعتماد غير صالح؛ أعد فتح النافذة');
  if (input.payFromAccountId && input.confirmNewPayment !== true) throw fail(400, 'أكد أن هذه دفعة جديدة؛ لا تُكرر دفعة مسجلة في كشف الحساب');
  let vendorId = input.vendorId;
  if (vendorId && !mongoose.isValidObjectId(vendorId)) throw fail(400, 'المورد غير صالح');
  if (!vendorId) {
    const name = String(input.vendorName || '').trim();
    if (name.length < 2 || name.length > 150) throw fail(400, 'اختر المورد أو اكتب اسمه');
    const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const found = await Vendor.findOne({ name: pattern }).session(session);
    vendorId = found?._id || (await Vendor.create([{ name, type: 'supplier', defaultCurrency: item.currency || 'USD' }], { session }))[0]._id;
  }
  const bill = await createBill({ vendorId, day: input.day, currency: item.currency || 'USD', rate: input.rate,
    enteredFrom: 'order', idempotencyKey: `LEGACY_PURCH:${item._id}:${input.requestKey}`,
    paidImmediatelyFrom: input.payFromAccountId || undefined,
    duplicateDecision: input.duplicateDecision, duplicateReason: input.duplicateReason, duplicateFingerprint: input.duplicateFingerprint,
    note: `اعتماد بند مشتريات الطلبية ${order.orderId} — تاريخ البند الأصلي ${item.date ? toDay(item.date) : 'غير محدد'}`,
    lines: [{ target: 'order', orderId: order._id, purchaseItemId: item._id, amount: Number(item.unitPrice), description: item.description || 'مشتريات الطلبية' }],
  }, { session, req });
  if (bill.status === 'canceled') throw fail(409, 'تم إلغاء اعتماد هذه المحاولة؛ أعد فتح النافذة لمحاولة جديدة');
  return { bill };
}
module.exports = { list, approve };
