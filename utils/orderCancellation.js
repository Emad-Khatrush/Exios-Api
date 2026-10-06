const { lockWalletOwner } = require('./walletLock');
// Cancelling an order that has payments gives everything paid back to the customer's wallet
// (owner's decision, 2026-10-02): "إلغاء وإرجاع للمحفظة". Nothing is kept; a charge the company
// wants to keep is billed on a new invoice.
//
// - A payment taken from the wallet goes back exactly as when one payment is cancelled: a
//   "cancellation" line in the wallet whose entry reverses that payment's entry.
// - Cash paid on the order stays in the cash box; the customer gets it as wallet credit (the
//   claim the cash paid is owed to the customer instead: receivable / wallet).
// - What a supplier refund already gave the customer on this order is taken back from the wallet
//   afterwards, so in all the customer gets exactly what they paid (owner's report 2026-10-04: an
//   order paid 70.26$ with a 43$ refund would otherwise give back 113.26$).
// The supplier cost already spent on the order stays in the accounting's "in progress" account,
// listed for the accountant to settle (a supplier refund, or moved to another order).
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const UserStatement = require('../models/userStatement');
const Wallet = require('../models/wallet');
const ErrorHandler = require('./errorHandler');
const { emitAccountingEvent } = require('../accounting/services/events');
const { refundWalletPayment } = require('./helperApi');
const { restoreOrderDebts } = require('./debts');
const { CustomerRefund } = require('../accounting/models/documents');

const roundToTwo = (num) => Math.round(num * 100) / 100;
const packageIdsOf = (payment) => (payment.list || []).map((p) => p?.id || p?._id).filter(Boolean);

async function creditWallet(user, payment, description, note, session) {
  const amount = roundToTwo(Number(payment.receivedAmount || 0));
  await lockWalletOwner(payment.customer, session);
  const { currency } = payment;
  const wallet = await Wallet.findOneAndUpdate({ user: payment.customer, currency }, { $inc: { balance: amount } }, { ...({ new: true }), session });
  if (wallet) await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: roundToTwo(wallet.balance) }, { session });
  else await Wallet.create([{ user: payment.customer, currency, balance: amount }], { session });
  const [last] = await UserStatement.find({ user: payment.customer, currency }).sort({ _id: -1 }).limit(1).session(session);
  const [statement] = await UserStatement.create([{
    user: payment.customer, createdBy: user, calculationType: '+', paymentType: 'wallet', createdAt: new Date(),
    description, amount, currency, total: roundToTwo(Number(last?.total || 0) + amount), note,
    // The claim is owed back at the rate the cash was taken at
    ...(Number(payment.rate) > 0 && { rate: payment.rate }),
    actionType: 'cancellation',
  }], { session });
  // No `reverses`: the cash stays in the box; the entry moves the claim to the wallet
  await emitAccountingEvent('statement', statement._id, {
    target: { orderId: payment.order, category: payment.category, packageIds: packageIdsOf(payment) },
  }, user, { session });
  await OrderPaymentHistory.deleteOne({ _id: payment._id }, { session });
  return amount;
}

// The refunds already in the wallet come off it: a payment on the order's purchase claim, which
// the cancellation left owed by them
async function takeBackRefunds(order, user, amount, refunds, session) {
  const wallet = await Wallet.findOneAndUpdate({ user: order.user, currency: 'USD', balance: { $gte: amount - 0.001 } }, { $inc: { balance: -amount } }, { ...({ new: true }), session });
  if (!wallet) throw new ErrorHandler(400, 'رصيد الدولار في المحفظة تغيّر ولا يكفي لخصم الريفاند. أعد المحاولة.');
  await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: roundToTwo(wallet.balance) }, { session });
  const [last] = await UserStatement.find({ user: order.user, currency: 'USD' }).sort({ _id: -1 }).limit(1).session(session);
  const [statement] = await UserStatement.create([{
    user: order.user, createdBy: user, calculationType: '-', paymentType: 'wallet', createdAt: new Date(), amount, currency: 'USD',
    total: roundToTwo(Number(last?.total || 0) - amount), actionType: 'wallet',
    description: `خصم ما أُرجع بالريفاند (${refunds.map((r) => r.number).join('، ')}) عند إلغاء الطلب ${order.orderId}`,
    note: `Order Id (${order.orderId}) => إلغاء الطلب: الريفاند كان جزءاً من المدفوع`,
  }], { session });
  await emitAccountingEvent('statement', statement._id, { target: { arKeys: [`PUR:${order._id}`] } }, user, { session });
}

// Gives every payment of the order back to the wallet; refused once a package was handed over
async function returnOrderPayments(order, user, { session } = {}) {
  const payments = await OrderPaymentHistory.find({ order: order._id }).sort({ createdAt: 1 }).lean().session(session);
  if (!payments.length) return [];
  const unsupported = payments.find(payment => !['USD', 'LYD'].includes(payment.currency));
  if (unsupported) throw new ErrorHandler(400, `Cannot return ${unsupported.currency} to a wallet: customer wallets support USD and LYD. The payment and order have not been changed.`);
  if ((order.paymentList || []).some((p) => p?.status?.received)) {
    throw new ErrorHandler(400, 'لا يمكن إلغاء طلب سُلِّم طرد منه للعميل وعليه دفعات. ألغِ فاتورة التسليم أولاً.');
  }
  // Dollars already given back to the wallet by supplier refunds on this order
  const refunds = await CustomerRefund.find({ orderId: order._id, status: 'posted', walletUsd: { $gt: 0 } }).select('number walletUsd').lean().session(session);
  const refunded = roundToTwo(refunds.reduce((sum, r) => sum + r.walletUsd, 0) / 100);
  if (refunded > 0) {
    const usdWallet = Number((await Wallet.findOne({ user: order.user, currency: 'USD' }).lean().session(session))?.balance || 0);
    // Every dollar payment comes back to the dollar wallet first (wallet or cash)
    const usdBack = payments.filter((p) => p.currency === 'USD').reduce((sum, p) => sum + Number(p.receivedAmount || 0), 0);
    if (usdWallet + usdBack < refunded - 0.001) {
      throw new ErrorHandler(400, `أُرجع للعميل ${refunded}$ بالريفاند (${refunds.map((r) => r.number).join('، ')}) ولا يكفي رصيد الدولار في محفظته لخصمها عند الإلغاء. ألغِ الريفاند أولاً أو أضف الرصيد.`);
    }
  }
  const returned = [];
  for (const payment of payments) {
    const note = `إلغاء الطلب ${order.orderId}`;
    const description = `إلغاء الطلب ${order.orderId} واسترجاع ${payment.paymentType === 'wallet' ? 'الدفعة' : 'الدفعة النقدية'} الى المحفظة`;
    if (payment.paymentType === 'wallet') {
      await refundWalletPayment(user, payment, description, note, session);
      await restoreOrderDebts(payment.debtPayments, { session });
    } else {
      await creditWallet(user, payment, description, note, session);
    }
    returned.push({ amount: roundToTwo(Number(payment.receivedAmount || 0)), currency: payment.currency, paymentType: payment.paymentType });
  }
  if (refunded > 0) {
    await takeBackRefunds(order, user, refunded, refunds, session);
    returned.push({ amount: -refunded, currency: 'USD', paymentType: 'refundTakenBack' });
  }
  return returned;
}

module.exports = { returnOrderPayments };
