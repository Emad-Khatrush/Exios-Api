const crypto = require('crypto');
const mongoose = require('mongoose');
const { SupplierBill, Vendor } = require('../models/documents');
const Order = require('../../models/order');
const { addDays, isDay, toDay } = require('./dates');
const { fail } = require('./posting/common');
const id = value => String(value?._id || value || '');
const amount = bill => Number(bill.total ?? (bill.lines || []).reduce((sum, l) => sum + Number(l.amount || 0), 0));
const ref = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();
const invoiceReference = bill => bill.vendorRefKind !== 'bank' && !/^BANK_(LINE|GROUP)_BILL:/.test(bill.idempotencyKey || '');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// References are stronger than amount/date similarities. Neither permits silently merging money.
async function candidates(input, { session, excludeId } = {}) {
  if (input.isCreditNote || input.isHistorical || input.migrationRunId || !isDay(input.day) || !mongoose.isValidObjectId(input.vendorId)) return [];
  const orders = [...new Set((input.lines || []).map(l => id(l.orderId)).filter(Boolean))];
  const total = amount(input), reference = ref(input.vendorRef);
  const vendor = await Vendor.findById(input.vendorId).select('_id seedKey').session(session || null).lean();
  if (!vendor || total <= 0) return [];
  const bills = await SupplierBill.find({ $or: [{ vendorId: vendor._id }, ...(orders.length ? [{ 'lines.orderId': { $in: orders } }] : [])], isCreditNote: { $ne: true }, status: { $in: ['draft', 'posted'] },
    ...(excludeId && { _id: { $ne: excludeId } }),
    ...(reference ? {} : { currency: input.currency, day: { $gte: addDays(input.day, -7), $lte: addDays(input.day, 7) } }),
  }).session(session || null).lean();
  const rows = [];
  // Quick expenses and costs paid on the spot share one generic vendor ("مصروفات نقدية"): the same
  // small amount twice in a week (fuel, hospitality, a purchase paid in cash) is normal, so for it
  // only an invoice number or the same order makes two bills alike
  const generic = vendor.seedKey === 'cash_expenses' || !!input.isQuickExpense;
  for (const bill of bills) {
    const sameVendor = id(bill.vendorId) === id(vendor);
    const alikeVendor = sameVendor && !generic && !bill.isQuickExpense;
    const sameRef = sameVendor && invoiceReference(input) && invoiceReference(bill) && !!reference && ref(bill.vendorRef) === reference;
    const sameAmount = bill.currency === input.currency && Math.abs(amount(bill) - total) < 0.0005;
    const sameOrder = bill.lines.some(l => orders.includes(id(l.orderId)));
    if (!sameRef && !(sameAmount && (alikeVendor || sameOrder) && Math.abs(new Date(bill.day) - new Date(input.day)) <= 7 * 86400000)) continue;
    rows.push({ key: `bill:${bill._id}`, billId: bill._id, status: bill.status, number: bill.number || 'مسودة', day: bill.day, amount: amount(bill), currency: bill.currency,
      strength: sameRef ? 'reference' : sameOrder ? 'order' : 'similar',
      reason: sameRef ? 'رقم فاتورة المورد نفسه' : sameOrder ? 'نفس الطلبية والمبلغ والعملة وتاريخ قريب' : 'نفس المورد والمبلغ والعملة وتاريخ قريب',
      fingerprint: hash([id(bill), bill.status, bill.updatedAt, bill.lines, bill.vendorRef]), url: `/accounting/bills/${bill._id}` });
  }
  if (orders.length) {
    const documents = await Order.find({ _id: { $in: orders } }).select('orderId purchaseItems').session(session || null).lean();
    for (const order of documents) for (const item of order.purchaseItems || []) {
      const day = item.date && toDay(item.date);
      if ((item.currency || 'USD') !== input.currency || !day || Math.abs(new Date(day) - new Date(input.day)) > 7 * 86400000) continue;
      if (!(input.lines || []).some(l => id(l.orderId) === id(order) && Math.abs(Number(l.amount) - Number(item.unitPrice)) < 0.0005)) continue;
      // An explicitly attached legacy item belongs to this invoice, rather than being another cost.
      if ((input.lines || []).some(l => id(l.purchaseItemId) === id(item))) continue;
      rows.push({ key: `item:${item._id}`, orderId: order._id, itemId: item._id, number: order.orderId, day, amount: item.unitPrice,
        currency: item.currency || 'USD', strength: 'order', reason: 'مشتريات مسجلة بالفعل داخل الطلبية',
        fingerprint: hash(item), url: `/invoice/${order._id}/edit` });
    }
  }
  return rows;
}

async function assertNoDuplicate(input, { session, excludeId } = {}) {
  // Serialize competing invoices for one vendor: retries see the invoice that committed first.
  if (!input.isHistorical && !input.migrationRunId && !input.isCreditNote && mongoose.isValidObjectId(input.vendorId)) {
    await Vendor.updateOne({ _id: input.vendorId }, { $inc: { costPostingVersion: 1 } }, { session });
  }
  const rows = await candidates(input, { session, excludeId });
  if (!rows.some(r => r.status === 'posted' || r.itemId || r.strength === 'reference')) return;
  const fingerprint = hash(rows.map(r => [r.key, r.fingerprint]).sort());
  if (input.duplicateDecision === 'independent' && String(input.duplicateReason || '').trim().length >= 10 && input.duplicateFingerprint === fingerprint
      && !rows.some(r => r.strength === 'reference')) return;
  const error = fail(`توجد تكلفة محتملة مسجلة سابقاً (${rows.map(r => r.number).join('، ')}). راجع الموجود واربطه بدلاً من تسجيل تكلفة ثانية؛ أو أكد أنها عملية مستقلة مع السبب. رقم فاتورة المورد المكرر لا يُسمح بتجاوزه.`);
  error.costDuplicatePreview = { results: rows, fingerprint, canConfirmIndependent: !rows.some(r => r.strength === 'reference') };
  throw error;
}
async function preview(input, options) {
  const results = await candidates(input, options);
  return { results, fingerprint: hash(results.map(r => [r.key, r.fingerprint]).sort()), canConfirmIndependent: !results.some(r => r.strength === 'reference') };
}
module.exports = { candidates, assertNoDuplicate, preview, hash, amount, invoiceReference };
