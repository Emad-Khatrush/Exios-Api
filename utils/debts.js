const Balance = require('../models/balance');

// Debts that are still owed follow their order: if the order moves to another customer, so do they.
// Only debts created with followsOrder (the new process) move; older debts keep their customer.
// Closed / waitingApproval / lost debts are history (their payments came out of the old customer's
// wallet and statements), so they stay with the customer who actually paid them.
const REASSIGNABLE_DEBT_STATUSES = ['open', 'overdue'];

const syncOrderDebtsOwner = async (orderId, newOwnerId, { session } = {}) => {
  if (!orderId || !newOwnerId) return { modifiedCount: 0 };

  return Balance.updateMany(
    {
      order: orderId,
      balanceType: 'debt',
      followsOrder: true,
      status: { $in: REASSIGNABLE_DEBT_STATUSES },
      owner: { $ne: newOwnerId },
    },
    { $set: { owner: newOwnerId } }, { session }
  );
}

const truncateToTwo = (num) => Math.trunc(num * 100) / 100;

// A payment made on the order itself (not from the debts screen) also pays down the debts that
// were opened for the same thing on that order: the invoice, or its received goods. The money
// has already left the wallet, so nothing else is charged here. Returns what was taken off
// each debt, to be kept on the payment so it can be undone.
const payOrderDebts = async ({ orderId, category, amount, currency, rate, createdAt, orderNumber }, { session } = {}) => {
  if (!orderId || !category || !(Number(amount) > 0)) return [];
  const debts = await Balance.find({ order: orderId, balanceType: 'debt', debtType: category, status: { $in: REASSIGNABLE_DEBT_STATUSES }, amount: { $gt: 0 } }).sort({ createdAt: 1 }).session(session);

  const applied = [];
  if (debts.some(debt => debt.deliveryInvoiceId)) {
    throw new (require('./errorHandler'))(400, 'سدد متبقي فاتورة التسليم من قسم الديون لضمان ربط الدفعة بالطرد الصحيح');
  }
  // What is left of the payment, in its own currency
  let left = Number(amount);
  for (const debt of debts) {
    if (left <= 0) break;
    // The payment counted in the debt's currency; dollars are not taken against a dinar debt
    let factor;
    if (debt.currency === currency) factor = 1;
    else if (debt.currency === 'USD' && currency === 'LYD' && Number(rate) > 0) factor = 1 / Number(rate);
    else continue;

    // A remainder below one cent is the rounding of the rate, not a real debt
    const covers = left * factor >= debt.amount - 0.01;
    const taken = covers ? debt.amount : truncateToTwo(left * factor);
    if (!(taken > 0)) continue;
    const used = covers ? Math.min(left, debt.amount / factor) : left;
    const remaining = covers ? 0 : truncateToTwo(debt.amount - taken);

    const historyId = new Balance.base.Types.ObjectId();
    await Balance.updateOne({ _id: debt._id }, {
      $set: { amount: remaining, ...(remaining === 0 && { status: 'waitingApproval' }) },
      $push: { paymentHistory: { _id: historyId, createdAt: createdAt || new Date(), rate: Number(rate) || 0, amount: truncateToTwo(used), currency, notes: `Paid with the ${category === 'invoice' ? 'invoice' : 'shipping'} payment of order ${orderNumber || ''}`.trim() } },
    }, { session });
    applied.push({ balance: debt._id, amount: taken, historyId });
    left -= used;
  }
  return applied;
};

// Undoes payOrderDebts when the payment is cancelled: the amounts go back on the debts
const restoreOrderDebts = async (debtPayments = [], { session } = {}) => {
  for (const item of debtPayments || []) {
    if (!item?.balance || !(Number(item.amount) > 0)) continue;
    const debt = await Balance.findById(item.balance).session(session || null);
    if (!debt) continue;
    await Balance.updateOne({ _id: debt._id }, {
      $set: { amount: truncateToTwo(debt.amount + Number(item.amount)), ...(['waitingApproval', 'closed'].includes(debt.status) && { status: 'open' }) },
      ...(item.historyId && { $pull: { paymentHistory: { _id: item.historyId } } }),
    }, { session });
  }
};

// Points used on the order page (a wallet or cash payment with points, or points alone) pay down the
// order's debts for the same thing, as the money of a payment does (gap closed 2026-11-25: before,
// only the money lowered the debt, so it stayed above what was owed). Dollar debts only, oldest first.
// A delivery invoice's remainder is paid from the debts screen, as with money. Each debt keeps the
// redemption (its first movement), so cancelling the points puts the amount back
// (restoreDebtsOfRedemption).
const DELIVERY_DEBT_MESSAGE = 'سدد متبقي فاتورة التسليم من قسم الديون لضمان ربط الدفعة بالطرد الصحيح';
const payOrderDebtsWithPoints = async ({ orderId, category, usd, redemptionId, packageIds, orderNumber, createdAt }, { session } = {}) => {
  if (!orderId || !['invoice', 'receivedGoods'].includes(category) || !(Number(usd) > 0)) return [];
  const debts = await Balance.find({ order: orderId, balanceType: 'debt', debtType: category, status: { $in: REASSIGNABLE_DEBT_STATUSES }, amount: { $gt: 0 } })
    .sort({ createdAt: 1 }).session(session);
  const chosen = (packageIds || []).map(String);
  if (debts.some((debt) => debt.deliveryInvoiceId && (!chosen.length || chosen.includes(String(debt.deliveryPackageId))))) {
    throw new (require('./errorHandler'))(400, DELIVERY_DEBT_MESSAGE);
  }
  const applied = [];
  let left = Math.round(Number(usd) * 100) / 100;
  for (const debt of debts) {
    if (left <= 0) break;
    if (debt.deliveryInvoiceId || debt.currency !== 'USD') continue;
    const taken = Math.min(left, truncateToTwo(debt.amount));
    if (!(taken > 0)) continue;
    const remaining = truncateToTwo(debt.amount - taken);
    const historyId = new Balance.base.Types.ObjectId();
    await Balance.updateOne({ _id: debt._id, amount: debt.amount }, {
      $set: { amount: remaining, ...(remaining <= 0 && { status: 'waitingApproval' }) },
      $push: { paymentHistory: { _id: historyId, createdAt: createdAt || new Date(), rate: 0, amount: taken, currency: 'USD', paymentType: 'points', points: Math.round(taken * 100),
        fromOrder: true, ...(redemptionId && { redemptionId }), notes: `Paid with the points of order ${orderNumber || ''}`.trim() } },
    }, { session });
    applied.push({ balance: debt._id, amount: taken, historyId });
    left = Math.round((left - taken) * 100) / 100;
  }
  return applied;
};

// Cancelled points (from the order page, the debts screen, or with their order): the debts they
// paid are owed again. A debt closed by hand or lost keeps its history.
const restoreDebtsOfRedemption = async (redemptionId, { session } = {}) => {
  if (!redemptionId) return 0;
  const debts = await Balance.find({ 'paymentHistory.redemptionId': redemptionId }).session(session || null);
  let restored = 0;
  for (const debt of debts) {
    if (debt.manualClosure?.closedAt || ['lost', 'canceled'].includes(debt.status)) continue;
    for (const payment of debt.paymentHistory.filter((p) => String(p.redemptionId) === String(redemptionId))) {
      const current = await Balance.findById(debt._id).session(session || null);
      const amount = Math.min(truncateToTwo(Number(current.amount) + Number(payment.amount)), Number(current.initialAmount));
      await Balance.updateOne({ _id: debt._id }, {
        $set: { amount, ...(['waitingApproval', 'closed'].includes(current.status) && amount > 0 && { status: 'open' }) },
        $pull: { paymentHistory: { _id: payment._id } },
      }, { session });
      restored += 1;
    }
  }
  return restored;
};

module.exports = { syncOrderDebtsOwner, payOrderDebts, restoreOrderDebts, payOrderDebtsWithPoints, restoreDebtsOfRedemption, REASSIGNABLE_DEBT_STATUSES };
