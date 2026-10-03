// The rate of an old dinar payment that was saved without one (owner's request 2026-10-04, order
// 6458-2723: 880 LYD paid on a 96$ invoice with no rate). Without it the order page cannot count
// the payment and shows the invoice unpaid, while the books valued the dinars at the wallet's
// average and called the difference an overpayment. An admin or the accountant writes the rate;
// the payment and its wallet line keep it, and the posting queue posts the line again at it.
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const UserStatement = require('../../models/userStatement');
const Order = require('../../models/order');
const { isOwner } = require('./access');
const { assertOpenPeriod } = require('./periodGuard');
const { emitAccountingEvent } = require('./events');

const fail = (message, code = 400) => new ErrorHandler(code, message);

// The wallet line a payment was made with: linked, or (older payments) the deduction of the same
// amount and currency for this order closest in time
async function statementOf(payment, order) {
  if (payment.statementId) return UserStatement.findById(payment.statementId).lean();
  const at = new Date(payment.createdAt).getTime();
  const near = await UserStatement.find({
    user: order.user, calculationType: '-', currency: payment.currency, amount: payment.receivedAmount,
    createdAt: { $gte: new Date(at - 10 * 60 * 1000), $lte: new Date(at + 10 * 60 * 1000) },
  }).lean();
  const forOrder = near.filter((s) => String(s.note || '').includes(order.orderId));
  return (forOrder.length ? forOrder : near).sort((a, b) => Math.abs(new Date(a.createdAt) - at) - Math.abs(new Date(b.createdAt) - at))[0] || null;
}

async function setPaymentRate(paymentId, rateInput, user) {
  if (!(user?.roles?.isAdmin || user?.roles?.isAccountant || await isOwner(user))) throw fail('للمدير أو المحاسب فقط', 403);
  if (!mongoose.isValidObjectId(paymentId)) throw fail('الدفعة غير موجودة', 404);
  const payment = await OrderPaymentHistory.findById(paymentId);
  if (!payment) throw fail('الدفعة غير موجودة', 404);
  if (!payment.currency || payment.currency === 'USD') throw fail('الدفعة بالدولار لا تحتاج سعراً');
  if (Number(payment.rate) > 0) throw fail(`للدفعة سعر مسجل (${payment.rate}). لتغييره احذف الدفعة وأعد إدخالها.`);
  if (payment.paymentType !== 'wallet') throw fail('هذه دفعة نقدية: احذفها وأعد إدخالها بالسعر.');
  const rate = Math.round(Number(rateInput) * 1e6) / 1e6;
  if (!(rate > 0)) throw fail('اكتب السعر (عدد الدنانير مقابل دولار واحد)');
  await assertOpenPeriod(user, payment.createdAt);
  const order = await Order.findById(payment.order).setOptions({ withDeleted: true }).select('orderId user').lean();
  if (!order) throw fail('الطلب غير موجود', 404);
  const statement = await statementOf(payment, order);
  if (!statement) throw fail('لم يُعثر على سطر المحفظة لهذه الدفعة');

  payment.rate = rate;
  payment.statementId = statement._id;
  await payment.save();
  await UserStatement.updateOne({ _id: statement._id }, { $set: { rate } });
  await emitAccountingEvent('paymentRate', payment._id, { statementId: String(statement._id), orderId: String(order._id), category: payment.category }, user);
  return OrderPaymentHistory.findById(payment._id).lean();
}

module.exports = { setPaymentRate };
