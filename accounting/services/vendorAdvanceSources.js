const { SupplierPayment } = require('../models/documents');
const { JournalEntry } = require('../models');

// Only explicitly traceable, unallocated cash payments can be selected by currency.
// Legacy pooled uses/refunds cannot safely be attributed to a particular payment.
async function available(vendorId, session) {
  const payments = await SupplierPayment.find({ vendorId, status: 'posted' }).session(session || null).lean();
  const sources = payments.filter(p => !p.fromAdvance && p.advanceUsd > 0 && !p.allocations?.length && p.amount > 0 && p.currency);
  const uses = payments.filter(p => p.fromAdvance && p.advancePaymentId);
  const expected = payments.filter(p => !p.fromAdvance).reduce((s, p) => s + (p.advanceUsd || 0), 0)
    - uses.reduce((s, p) => s + (p.advanceConsumedUsd || 0), 0);
  const [balance] = await JournalEntry.aggregate([
    { $match: { 'lines.apKey': `ADV:${vendorId}` } },
    { $unwind: '$lines' }, { $match: { 'lines.apKey': `ADV:${vendorId}` } },
    { $group: { _id: null, value: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]).session(session || null);
  if (expected !== (balance?.value || 0)) return [];
  return sources.map(p => {
    const consumed = uses.filter(u => String(u.advancePaymentId) === String(p._id)).reduce((s, u) => s + u.advanceConsumedUsd, 0);
    const remainingUsd = p.advanceUsd - consumed;
    return { _id: p._id, number: p.number, day: p.day, currency: p.currency, amount: p.amount,
      advanceUsd: p.advanceUsd, remainingUsd, remainingAmount: p.amount * remainingUsd / p.advanceUsd };
  }).filter(p => p.remainingUsd > 0);
}
module.exports = { available };
