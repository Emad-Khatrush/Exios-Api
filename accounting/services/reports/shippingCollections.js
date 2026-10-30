// Settlements allocated to shipping claims, not revenue, deposits or debt write-offs.
// All numbers are USD cents, as stored in journal lines. Reversals net against the
// original settlement, including cancelled cash and wallet payments.
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { resolveAccount } = require('../roles');

async function shippingCollections(packageIds) {
  if (!packageIds.length) return new Map();
  const account = await resolveAccount('customer_receivable');
  const match = {
    'lines.accountId': account._id,
    'lines.packageId': { $in: [...new Set(packageIds.map(String))].map(id => new mongoose.Types.ObjectId(id)) },
    'lines.arKey': /^SHP:/,
  };
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $lookup: { from: JournalEntry.collection.name, localField: 'reversalOf', foreignField: '_id', as: 'original' } },
    { $unwind: '$lines' }, { $match: match },
    { $group: {
      _id: '$lines.arKey',
      open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
      collected: { $sum: { $cond: [
        { $in: [{ $ifNull: [{ $arrayElemAt: ['$original.eventType', 0] }, '$eventType'] }, ['WALLET_PAYMENT', 'CASH_PAYMENT']] },
        { $subtract: ['$lines.credit', '$lines.debit'] }, 0,
      ] } },
    } },
  ]);
  return new Map(rows.map(row => [row._id, { collected: row.collected, open: row.open }]));
}

const sumPackages = (balances, packages, suffix = '') => packages.reduce((total, pkg) => {
  const key = `SHP:${pkg.orderId}:${pkg._id}${suffix}`;
  const value = balances.get(key);
  total.collected += value?.collected || 0;
  total.open += Math.max(0, value?.open || 0);
  return total;
}, { collected: 0, open: 0 });

module.exports = { shippingCollections, sumPackages };
