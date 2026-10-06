// Deleting an order created by mistake (admins only, spec 19.10). Allowed only when nothing hangs
// on it: no payments, no delivery invoices, no delivered package, no debts, no supplier bills, no
// trip or warehouse holding its packages. An order that never reached the books (a shipment not
// priced yet, or before go-live) is removed for good. Any other is soft-deleted: its claims are
// taken back as for a cancellation (on their own dates, so no closed period moves), the claim
// entries are hidden with the cancelled ones, and the order disappears from the whole system while
// accounting still shows it with a "deleted" badge.
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SupplierBill } = require('../models/documents');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Invoice = require('../../models/invoice');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const Balance = require('../../models/balance');
const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { assertOpenPeriod } = require('./periodGuard');
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
async function deletionBlockers(order, { session } = {}) {
  const packageIds = (order.paymentList || []).map((pkg) => pkg._id);
  const queries = [
    OrderPaymentHistory.countDocuments({ order: order._id }),
    Invoice.countDocuments({
      isCanceled: { $ne: true },
      $or: [
        { 'list.orderId': { $in: [order.orderId, String(order._id), order._id] } },
        ...(packageIds.length ? [{ 'list.packageId': { $in: [...packageIds, ...packageIds.map(String)] } }] : []),
      ],
    }),
    Balance.countDocuments({ order: order._id }),
    SupplierBill.find({ 'lines.orderId': order._id, status: { $ne: 'canceled' } }).select('number').lean(),
    packageIds.length
      ? Inventory.find({ 'orders.paymentList._id': { $in: [...packageIds, ...packageIds.map(String)] } }).select('voyage inventoryType').lean()
      : [],
  ];
  const values = [];
  for (const query of queries) values.push(Array.isArray(query) ? query : await query.session(session || null));
  const [payments, invoices, debts, bills, holders] = values;
  const blockers = [];
  if (payments) blockers.push(`عليه ${payments} دفعة مسجلة؛ احذف الدفعات أولاً من تبويب Payments (تعود قيمتها إلى محفظة العميل).`);
  if (invoices) blockers.push(`له ${invoices} فاتورة تسليم؛ ألغِها أولاً.`);
  if ((order.paymentList || []).some((pkg) => pkg.status?.received)) blockers.push('بعض طروده سُلِّمت للعميل.');
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

async function deleteOrder(orderId, user, { session } = {}) {
  if (!session) return runInTransaction((session) => deleteOrder(orderId, user, { session }));
  if (!mongoose.isValidObjectId(orderId)) throw refuse('الطلب غير موجود');
  const order = await Order.findById(orderId).select('orderId isCanceled createdAt paymentList._id paymentList.status').session(session).lean();
  if (!order) throw new ErrorHandler(404, 'الطلب غير موجود');

  await assertOpenPeriod(user, order.createdAt, { session });
  const blockers = await deletionBlockers(order, { session });
  if (blockers.length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${blockers.join(' ')} يمكنك إلغاء الطلب بدل حذفه.`);

  const stillOpen = 'ما زالت عليه أرصدة في الدفاتر المحاسبية (قيود يدوية أو مدفوعات). سوِّها أولاً أو ألغِ الطلب بدل حذفه.';
  const id = new mongoose.Types.ObjectId(String(order._id));
  const inBooks = await JournalEntry.exists({ 'lines.orderId': id }).session(session);
  if (!inBooks) {
    // Never reached the books: nothing to keep
    await Order.deleteOne({ _id: order._id }, { session });
    return { orderId: order.orderId, removed: true, posted: 0 };
  }
  if (!(await isLive())) {
    // Entries from a migration: nothing is posted while live posting is off, so they must already be zero
    if ((await openLedgerAccounts(order._id, session)).length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${stillOpen}`);
    await Order.updateOne({ _id: order._id }, { $set: { isCanceled: true, isDeleted: true, deletedAt: new Date(), deletedBy: user?._id } }, { session });
    return { orderId: order.orderId, removed: false, posted: 0 };
  }

  {
    // A deleted order is billed nothing: the same reconciliation as a cancellation takes its
    // claims, revenue and costs back, and hides the claim entries once they net to zero
    await Order.updateOne({ _id: order._id }, { $set: { isCanceled: true } }).session(session);
    const result = await syncOrder(order._id, { session, user });
    if ((await openLedgerAccounts(order._id, session)).length) throw refuse(`لا يمكن حذف الطلب ${order.orderId}: ${stillOpen}`);
    await Order.updateOne({ _id: order._id }, { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: user?._id } }).session(session);
    return { orderId: order.orderId, removed: false, posted: result?.posted || 0 };
  }
}

module.exports = { deleteOrder, deletionBlockers };
