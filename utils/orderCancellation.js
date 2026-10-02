// Cancelling an order that has payments gives everything paid back to the customer's wallet
// (owner's decision, 2026-10-02): "إلغاء وإرجاع للمحفظة". Nothing is kept; a charge the company
// wants to keep is billed on a new invoice.
//
// - A payment taken from the wallet goes back exactly as when one payment is cancelled: a
//   "cancellation" line in the wallet whose entry reverses that payment's entry.
// - Cash paid on the order stays in the cash box; the customer gets it as wallet credit (the
//   claim the cash paid is owed to the customer instead: receivable / wallet).
// The supplier cost already spent on the order stays in the accounting's "in progress" account,
// listed for the accountant to settle (a supplier refund, or moved to another order).
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const UserStatement = require('../models/userStatement');
const Wallet = require('../models/wallet');
const ErrorHandler = require('./errorHandler');
const { emitAccountingEvent } = require('../accounting/services/events');
const { refundWalletPayment } = require('./helperApi');
const { restoreOrderDebts } = require('./debts');

const roundToTwo = (num) => Math.round(num * 100) / 100;
const packageIdsOf = (payment) => (payment.list || []).map((p) => p?.id || p?._id).filter(Boolean);

async function creditWallet(user, payment, description, note) {
  const amount = roundToTwo(Number(payment.receivedAmount || 0));
  const { currency } = payment;
  const wallet = await Wallet.findOneAndUpdate({ user: payment.customer, currency }, { $inc: { balance: amount } }, { new: true });
  if (wallet) await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: roundToTwo(wallet.balance) });
  else await Wallet.create({ user: payment.customer, currency, balance: amount });
  const [last] = await UserStatement.find({ user: payment.customer, currency }).sort({ _id: -1 }).limit(1);
  const statement = await UserStatement.create({
    user: payment.customer, createdBy: user, calculationType: '+', paymentType: 'wallet', createdAt: new Date(),
    description, amount, currency, total: roundToTwo(Number(last?.total || 0) + amount), note,
    // The claim is owed back at the rate the cash was taken at
    ...(Number(payment.rate) > 0 && { rate: payment.rate }),
    actionType: 'cancellation',
  });
  // No `reverses`: the cash stays in the box; the entry moves the claim to the wallet
  await emitAccountingEvent('statement', statement._id, {
    target: { orderId: payment.order, category: payment.category, packageIds: packageIdsOf(payment) },
  }, user);
  await OrderPaymentHistory.deleteOne({ _id: payment._id });
  return amount;
}

// Gives every payment of the order back to the wallet; refused once a package was handed over
async function returnOrderPayments(order, user) {
  const payments = await OrderPaymentHistory.find({ order: order._id }).sort({ createdAt: 1 }).lean();
  if (!payments.length) return [];
  if ((order.paymentList || []).some((p) => p?.status?.received)) {
    throw new ErrorHandler(400, 'لا يمكن إلغاء طلب سُلِّم طرد منه للعميل وعليه دفعات. ألغِ فاتورة التسليم أولاً.');
  }
  const returned = [];
  for (const payment of payments) {
    const note = `إلغاء الطلب ${order.orderId}`;
    const description = `إلغاء الطلب ${order.orderId} واسترجاع ${payment.paymentType === 'wallet' ? 'الدفعة' : 'الدفعة النقدية'} الى المحفظة`;
    if (payment.paymentType === 'wallet') {
      await refundWalletPayment(user, payment, description, note);
      await restoreOrderDebts(payment.debtPayments);
    } else {
      await creditWallet(user, payment, description, note);
    }
    returned.push({ amount: roundToTwo(Number(payment.receivedAmount || 0)), currency: payment.currency, paymentType: payment.paymentType });
  }
  return returned;
}

module.exports = { returnOrderPayments };
