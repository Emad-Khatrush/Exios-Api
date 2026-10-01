// Deleting an order for good (admins only). An order may only disappear when nothing hangs on
// it: no payments, no debts, no supplier bills, no trip or warehouse holding its packages. The
// ledger is then brought to zero for it (its claims are taken back as for a cancellation) and
// the order is removed in the same transaction, so the books never point at a missing order.
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SupplierBill } = require('../models/documents');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const Balance = require('../../models/balance');
const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { syncOrder } = require('./claims/sync');

const refuse = (message) => new ErrorHandler(400, message);

async function isLive() {
  try {
    return !!(await getConfig()).settings?.liveEnabled;
  } catch {
    return false;
  }
}

// What stops this order from being deleted, as sentences for the admin (empty = nothing)
async function deletionBlockers(order) {
  const packageIds = (order.paymentList || []).map((pkg) => pkg._id);
  const [payments, debts, bills, holders] = await Promise.all([
    OrderPaymentHistory.countDocuments({ order: order._id }),
    Balance.countDocuments({ order: order._id }),
    SupplierBill.find({ 'lines.orderId': order._id, status: { $ne: 'canceled' } }).select('number').lean(),
    packageIds.length
      ? Inventory.find({ 'orders.paymentList._id': { $in: [...packageIds, ...packageIds.map(String)] } }).select('voyage inventoryType').lean()
      : [],
  ]);
  const blockers = [];
  if (payments) blockers.push(`عليه ${payments} دفعة مسجلة؛ احذف الدفعات أولاً من تبويب Payments (تعود قيمتها إلى محفظة العميل).`);
  if (debts) blockers.push(`مرتبط به ${debts} دين؛ احذف الديون أو انقلها أولاً.`);
  if (bills.length) blockers.push(`عليه فواتير موردين (${bills.map((bill) => bill.number || 'مسودة').join('، ')})؛ ألغِها أولاً من المحاسبة.`);
  if (holders.length) blockers.push(`طروده موجودة في ${holders.map((holder) => holder.voyage || (holder.inventoryType === 'inventoryGoods' ? 'رحلة' : 'مخزن')).join('، ')}؛ أخرجها منها أولاً.`);
  return blockers;
}

// Accounts on which the ledger still holds something for this order
async function openLedgerAccounts(orderId, session) {
  const id = new mongoose.Types.ObjectId(String(orderId));
  return JournalEntry.aggregate([
    { $match: { 'lines.orderId': id } },
    { $unwind: '$lines' },
    { $match: { 'lines.orderId': id } },
    { $group: { _id: '$lines.accountId', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $match: { net: { $ne: 0 } } },
  ]).session(session || null);
}

async function deleteOrder(orderId, user) {
  if (!mongoose.isValidObjectId(orderId)) throw refuse('الطلب غير موجود');
  const order = await Order.findById(orderId).select('orderId paymentList._id').lean();
  if (!order) throw new ErrorHandler(404, 'الطلب غير موجود');

  const blockers = await deletionBlockers(order);
  if (blockers.length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${blockers.join(' ')} يمكنك إلغاء الطلب بدل حذفه.`);

  const stillOpen = 'ما زالت عليه أرصدة في الدفاتر المحاسبية (قيود يدوية أو مدفوعات). سوِّها أولاً أو ألغِ الطلب بدل حذفه.';
  if (!(await isLive())) {
    // Nothing is posted while live posting is off; entries from a migration still count
    if ((await openLedgerAccounts(order._id)).length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${stillOpen}`);
    await Order.deleteOne({ _id: order._id });
    return { orderId: order.orderId, posted: 0 };
  }

  return runInTransaction(async (session) => {
    // A deleted order is billed nothing: the same reconciliation as a cancellation takes its
    // claims, revenue and costs back
    await Order.updateOne({ _id: order._id }, { $set: { isCanceled: true } }).session(session);
    const result = await syncOrder(order._id, { session, user });
    if ((await openLedgerAccounts(order._id, session)).length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${stillOpen}`);
    await Order.deleteOne({ _id: order._id }).session(session);
    return { orderId: order.orderId, posted: result?.posted || 0 };
  });
}

module.exports = { deleteOrder, deletionBlockers };
