// What each suggested entry was in its own currency, for the review of a statement line against
// operations in the books: a yuan salary paid in dollars shows its 6,000 CNY, a dollar payment of
// yuan bills shows the bills' yuan, a yuan purchase shows the yuan received.
const { JournalEntry } = require('../../models');
const { SupplierPayment, SupplierBill, SalaryPayment, YuanPurchase } = require('../../models/documents');

const round = (n) => Math.round(n * 100) / 100;

async function originals(entryIds) {
  const result = new Map();
  if (!entryIds.length) return result;
  const entries = await JournalEntry.find({ _id: { $in: entryIds } }).select('source').lean();
  const ids = (model) => entries.filter((e) => e.source?.model === model).map((e) => e.source.id);
  const [payments, salaries, purchases] = await Promise.all([
    SupplierPayment.find({ _id: { $in: ids('AccountingSupplierPayment') } }).populate('vendorId', 'name').lean(),
    SalaryPayment.find({ _id: { $in: ids('AccountingSalaryPayment') } }).lean(),
    YuanPurchase.find({ _id: { $in: ids('AccountingYuanPurchase') } }).populate('vendorId', 'name').lean(),
  ]);
  const bills = new Map((await SupplierBill.find({ _id: { $in: payments.flatMap((p) => (p.allocations || []).map((a) => a.billId)) } })
    .select('number currency total totalUsd').lean()).map((b) => [String(b._id), b]));
  const bySource = new Map();
  for (const p of payments) {
    // The bills' own currency: the part of each bill this payment settled
    const parts = (p.allocations || []).map((a) => {
      const bill = bills.get(String(a.billId));
      if (!bill) return null;
      const amount = a.amount ?? (bill.totalUsd ? (a.amountUsd / bill.totalUsd) * bill.total : null);
      return amount == null ? null : { currency: bill.currency, amount, number: bill.number };
    }).filter(Boolean);
    const currencies = [...new Set(parts.map((x) => x.currency))];
    bySource.set(String(p._id), {
      kind: 'payment', party: p.vendorId?.name,
      ...(currencies.length === 1 && { currency: currencies[0], amount: round(parts.reduce((s, x) => s + x.amount, 0)) }),
      detail: parts.length ? `${parts.length === 1 ? 'فاتورة' : `${parts.length} فواتير`}: ${parts.slice(0, 4).map((x) => x.number).join('، ')}${parts.length > 4 ? '…' : ''}` : null,
    });
  }
  for (const s of salaries) {
    const net = (s.grossAmount || 0) - (s.advanceDeduction || 0);
    bySource.set(String(s._id), { kind: 'salary', party: s.employeeName, currency: s.currency, amount: round(net), detail: s.month ? `راتب شهر ${s.month}` : 'راتب' });
  }
  for (const y of purchases) {
    bySource.set(String(y._id), { kind: 'yuan', party: y.vendorId?.name, currency: 'CNY', amount: y.cnyReceived ?? y.cnyExpected, detail: 'شراء يوان' });
  }
  for (const e of entries) {
    const found = e.source?.id && bySource.get(String(e.source.id));
    if (found) result.set(String(e._id), found);
  }
  return result;
}

module.exports = { originals };
