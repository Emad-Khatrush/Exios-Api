const { SupplierPayment } = require('../models/documents');
const { getConfig } = require('./config');

// What is still owed on a bill in its own currency. The ledger keeps a bill's payable in dollar
// cents, and a cent is worth half a lira: 11,850 TRY paid on a 35,350 TRY bill is $237.24, which
// read back from dollars alone is 11,850.10, leaving 23,499.90. So each payment made in the
// bill's currency keeps the amount it really paid (allocation.amount), and the remainder is the
// dollar proportion corrected by what those payments rounded away. A bill closed in dollars owes
// nothing.

// Half a cent, in the bill's currency: how far a native amount may sit from its dollar cents
const slackOf = (bill, decimals) => 0.5 * Number(bill.total) / bill.totalUsd + 1 / 10 ** decimals;
const proportional = (bill, usd) => Number(bill.total) * usd / bill.totalUsd;

// What an allocation paid in the bill's currency, when it is known: written on the allocation, or,
// for a payment saved before amounts were kept, read from a payment of that one bill alone
function paidNative(payment, allocation, bill, decimals) {
  if (Number.isFinite(allocation.amount)) return allocation.amount;
  if ((payment.allocations || []).length !== 1 || payment.currency !== bill.currency) return null;
  const amount = payment.fromAdvance ? (payment.advancePaymentId ? payment.advanceAmount : null) : (payment.advanceUsd ? null : payment.amount);
  if (!Number.isFinite(amount)) return null;
  return Math.abs(amount - proportional(bill, allocation.amountUsd)) <= slackOf(bill, decimals) ? amount : null;
}

// bills: [{ _id, currency, total, totalUsd }]; openUsd: Map of bill id → open dollar cents.
// Returns Map of bill id → open amount in the bill's currency (null when it cannot be told).
async function nativeOpenMap(bills, openUsd, session) {
  const { currencies } = await getConfig();
  const ids = bills.map(bill => bill._id);
  const payments = ids.length ? await SupplierPayment.find({ status: 'posted', 'allocations.billId': { $in: ids } })
    .select('currency amount fromAdvance advancePaymentId advanceAmount advanceUsd allocations').session(session || null).lean() : [];
  const result = new Map();
  for (const bill of bills) {
    const id = String(bill._id);
    const open = openUsd.get(id) || 0;
    const decimals = currencies.get(bill.currency)?.decimals ?? 2;
    const round = value => Math.round(value * 10 ** decimals) / 10 ** decimals;
    if (!(bill.totalUsd > 0)) { result.set(id, null); continue; }
    if (open <= 0) { result.set(id, round(proportional(bill, open))); continue; }
    let correction = 0;
    for (const payment of payments) for (const allocation of payment.allocations || []) {
      if (String(allocation.billId) !== id) continue;
      const native = paidNative(payment, allocation, bill, decimals);
      if (native !== null) correction += proportional(bill, allocation.amountUsd) - native;
    }
    result.set(id, Math.min(Number(bill.total), Math.max(0, round(proportional(bill, open) + correction))));
  }
  return result;
}

module.exports = { nativeOpenMap, slackOf, proportional };
