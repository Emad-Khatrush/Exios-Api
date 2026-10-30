const mongoose = require('mongoose');
const { SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const Order = require('../../models/order');
const { postEntry } = require('./ledger');
const { lockPeriod } = require('./periodLock');
const { fail, resolveAccount } = require('./posting/common');
const { logAudit } = require('./audit');
const id = v => String(v?._id || v || '');

// Reclassifies an already recorded expense. It never creates another supplier invoice/payment.
async function link(billId, input, { session, req }) {
  if (!mongoose.isValidObjectId(billId) || !mongoose.isValidObjectId(input.orderId)) throw fail('الفاتورة أو الطلبية غير صالحة');
  const settings = await lockPeriod(session);
  const bill = await SupplierBill.findById(billId).session(session);
  const order = await Order.findById(input.orderId).select('orderId isCanceled purchaseItems placedAt').session(session);
  if (!bill || bill.status !== 'posted' || bill.isCreditNote || !order || order.isCanceled) throw fail('اختر فاتورة مرحلة وطلبية نشطة');
  if (bill.lines.every(l => id(l.orderId) === id(order))) return { billId: bill._id, linked: true, existing: true };
  const { count } = await require('./config').getConfig();
  if ((settings?.lockDate && bill.day <= settings.lockDate) || (count && bill.day <= count.day)) throw fail('هذه تكلفة في فترة مقفلة أو قبل الجرد؛ تحتاج تسوية تاريخية مخصصة حتى لا تتغير أرباح الفترة الجديدة');
  if (bill.lines.length !== 1 || bill.lines[0].target !== 'expense' || bill.lines[0].orderId) throw fail('الربط المباشر يدعم فاتورة مصروف واحدة السطر وغير مرتبطة؛ الفاتورة الموزعة تحتاج مراجعة توزيعها');
  if (String(input.reason || '').trim().length < 10) throw fail('اذكر سبب ربط الفاتورة بهذه الطلبية');
  if (await SupplierBill.exists({ originalBillId: bill._id, status: { $ne: 'canceled' } }).session(session)) throw fail('للفاتورة مرتجعات: راجع أصلها ومرتجعاتها قبل إعادة توزيع التكلفة');
  const payments = await SupplierPayment.find({ 'allocations.billId': bill._id, status: 'posted' }).session(session).lean();
  if (payments.some(p => p.costDifferenceUsd)) throw fail('لهذه الفاتورة فروقات سداد موزعة؛ تحتاج مراجعة توزيع الفرق قبل الربط');
  const line = bill.lines[0];
  if (input.itemId) {
    const item = order.purchaseItems.find(i => id(i) === String(input.itemId));
    if (!item || (item.currency || 'USD') !== bill.currency || Math.abs(Number(item.unitPrice) - Number(line.amount)) > 0.0005) throw fail('بند مشتريات الطلبية لا يطابق الفاتورة');
    if (await SupplierBill.exists({ _id: { $ne: bill._id }, status: { $ne: 'canceled' }, $or: [{ idempotencyKey: `MIG:PURCH:${item._id}` }, { 'lines.purchaseItemId': item._id }] }).session(session)
      || await BankStatementLine.exists({ purchaseItemId: item._id, lineStatus: 'created_entry', billId: { $ne: bill._id } }).session(session)) throw fail('هذا البند له تكلفة مسجلة أخرى؛ عالج التكرار أولاً');
    line.purchaseItemId = item._id;
  }
  const before = bill.toObject();
  const entry = await postEntry({ eventType: 'BILL_COST_LINK', eventKey: `BILL_COST_LINK:${bill._id}`, date: bill.day,
    description: `ربط تكلفة ${bill.number} بالطلبية ${order.orderId} · ${input.reason}`,
    source: { model: 'AccountingSupplierBill', id: bill._id },
    lines: [
      { accountId: (await resolveAccount('purchase_cost_wip'))._id, debit: line.usd, orderId: order._id, office: order.placedAt || line.office, label: line.description },
      { accountId: line.accountId, credit: line.usd, office: line.office, label: 'إعادة تصنيف تكلفة مسجلة سابقاً' },
    ],
  }, { session, user: req?.user });
  line.target = 'order'; line.orderId = order._id; line.accountId = undefined;
  bill.markModified('lines'); await bill.save({ session });
  await require('./claims/sync').syncOrder(order._id, { session, user: req?.user, date: entry.day });
  await logAudit({ req, action: 'cost.linkExisting', model: 'AccountingSupplierBill', docId: bill._id, before, after: bill }, session);
  return { linked: true, billId: bill._id, entryId: entry._id };
}
module.exports = { link };
