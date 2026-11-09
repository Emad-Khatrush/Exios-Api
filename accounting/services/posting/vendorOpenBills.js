// A statement line of a known vendor who has unpaid bills (owner's request 2026-11-10). A bill is
// proposed for a line only when it has the line's amount within a week, so one transfer paying
// five monthly bills was proposed as a new expense: the cost in the books twice. Whenever the
// line's vendor is known and has open bills, the line says so and is not posted as a new cost
// without a person looking: the bills are paid from the line («سداد فواتير موردين»).
const { JournalEntry } = require('../../models');
const { Vendor, SupplierBill } = require('../../models/documents');
const { nativeOpenMap } = require('../billNativeOpen');

const GENERIC = ['historical_supplier', 'historical_carrier', 'cash_expenses'];
const clean = text => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Returns hint => { vendorId, vendorName, count, currency, total, totalUsd } or null. One lookup per vendor.
async function finder() {
  const vendors = (await Vendor.find({ isActive: true }).select('name bankAliases seedKey').lean()).filter(v => !GENERIC.includes(v.seedKey));
  const byId = new Map(vendors.map(v => [String(v._id), v]));
  const cache = new Map();
  const resolve = hint => {
    if (hint.vendorId) return byId.get(String(hint.vendorId)) || null;
    const name = clean(hint.vendorName);
    if (name.length < 3) return null;
    // The statement's name of the party inside the vendor's name or one of its bank names; one vendor only
    const found = vendors.filter(v => [v.name, ...(v.bankAliases || [])].some(alias => { const text = clean(alias); return text === name || (` ${text} `).includes(` ${name} `); }));
    return found.length === 1 ? found[0] : null;
  };
  const summary = async vendor => {
    const bills = await SupplierBill.find({ vendorId: vendor._id, status: 'posted', isCreditNote: { $ne: true } }).select('currency total totalUsd').lean();
    if (!bills.length) return null;
    const keys = bills.map(bill => `BILL:${bill._id}`);
    const rows = await JournalEntry.aggregate([
      { $match: { 'lines.apKey': { $in: keys } } }, { $unwind: '$lines' }, { $match: { 'lines.apKey': { $in: keys } } },
      { $group: { _id: '$lines.apKey', open: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
    ]);
    const open = new Map(rows.map(row => [row._id.slice(5), row.open]));
    const unpaid = bills.filter(bill => (open.get(String(bill._id)) || 0) > 2);
    if (!unpaid.length) return null;
    const native = await nativeOpenMap(unpaid, open);
    const currencies = [...new Set(unpaid.map(bill => bill.currency))];
    const total = currencies.length === 1 ? unpaid.reduce((sum, bill) => sum + (native.get(String(bill._id)) ?? 0), 0) : null;
    return { vendorId: vendor._id, vendorName: vendor.name, count: unpaid.length, currency: currencies.length === 1 ? currencies[0] : null,
      total: total === null ? null : Math.round(total * 1000) / 1000, totalUsd: unpaid.reduce((sum, bill) => sum + open.get(String(bill._id)), 0) };
  };
  return async hint => {
    const vendor = hint && resolve(hint);
    if (!vendor) return null;
    const key = String(vendor._id);
    if (!cache.has(key)) cache.set(key, await summary(vendor));
    return cache.get(key);
  };
}

module.exports = { finder };
