const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { resolveAccount } = require('../roles');

// Net active write-offs, reduced by later recoveries. Reversed write-offs are excluded.
async function writeOffBalances(orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean).map(id => String(id?._id || id)))].filter(mongoose.isValidObjectId).map(id => new mongoose.Types.ObjectId(id));
  const byKey = new Map(), byOrder = new Map();
  if (!ids.length) return { byKey, byOrder };
  if (!await JournalEntry.exists({ 'lines.orderId': { $in: ids }, eventType: { $in: ['CLAIM_WRITEOFF', 'WRITEOFF_RECOVERY'] } })) return { byKey, byOrder };
  const receivable = await resolveAccount('customer_receivable');
  const lineMatch = { 'lines.orderId': { $in: ids }, 'lines.accountId': receivable._id };
  const rows = await JournalEntry.aggregate([
    { $match: { ...lineMatch, status: 'posted', reversalOf: null, eventType: { $in: ['CLAIM_WRITEOFF', 'WRITEOFF_RECOVERY'] } } },
    { $unwind: '$lines' }, { $match: lineMatch },
    { $group: { _id: { key: '$lines.arKey', orderId: '$lines.orderId' }, amount: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]);
  rows.forEach(row => {
    const amount = Math.max(0, row.amount);
    if (!row._id.key || !amount) return;
    byKey.set(row._id.key, amount);
    const orderId = String(row._id.orderId);
    byOrder.set(orderId, (byOrder.get(orderId) || 0) + amount);
  });
  return { byKey, byOrder };
}

// Enrich exact order-debt links only. The reminder remains collectible; writing off is not payment.
async function annotateDebts(input) {
  const debts = (input || []).flat().filter(Boolean);
  const { byKey, byOrder } = await writeOffBalances(debts.map(d => d.order));
  for (const debt of debts) {
    const orderId = String(debt.order?._id || debt.order || '');
    if (!byOrder.has(orderId)) continue;
    const keys = debt.deliveryClaimKeys?.length ? debt.deliveryClaimKeys
      : debt.debtType === 'invoice' ? [`PUR:${orderId}`]
        : debt.deliveryPackageId ? [`SHP:${orderId}:${debt.deliveryPackageId}`] : [];
    const amountUsd = keys.reduce((sum, key) => sum + (byKey.get(key) || 0), 0);
    if (amountUsd > 0) debt.accountingWriteOff = { amountUsd, collectible: true };
    // Unlinked old shipping reminders cannot be attributed to a particular written-off parcel.
    else if (!keys.length) debt.orderHasWriteOff = true;
  }
  return input;
}
module.exports = { writeOffBalances, annotateDebts };
