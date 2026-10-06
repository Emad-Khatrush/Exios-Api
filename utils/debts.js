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

module.exports = { syncOrderDebtsOwner, payOrderDebts, restoreOrderDebts, REASSIGNABLE_DEBT_STATUSES };
