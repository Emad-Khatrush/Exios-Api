const Balance = require('../models/balance');

// Debts that are still owed follow their order: if the order moves to another customer, so do they.
// Only debts created with followsOrder (the new process) move; older debts keep their customer.
// Closed / waitingApproval / lost debts are history (their payments came out of the old customer's
// wallet and statements), so they stay with the customer who actually paid them.
const REASSIGNABLE_DEBT_STATUSES = ['open', 'overdue'];

const syncOrderDebtsOwner = async (orderId, newOwnerId) => {
  if (!orderId || !newOwnerId) return { modifiedCount: 0 };

  return Balance.updateMany(
    {
      order: orderId,
      balanceType: 'debt',
      followsOrder: true,
      status: { $in: REASSIGNABLE_DEBT_STATUSES },
      owner: { $ne: newOwnerId },
    },
    { $set: { owner: newOwnerId } }
  );
}

module.exports = { syncOrderDebtsOwner, REASSIGNABLE_DEBT_STATUSES };
