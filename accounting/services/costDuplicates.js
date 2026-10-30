const crypto = require('crypto');
const mongoose = require('mongoose');
const { SupplierBill, SupplierPayment, Vendor } = require('../models/documents');
const Order = require('../../models/order');
const { addDays, isDay, toDay } = require('./dates');
const { fail } = require('./posting/common');
const id = value => String(value?._id || value || '');
const amount = bill => Number(bill.total ?? (bill.lines || []).reduce((sum, l) => sum + Number(l.amount || 0), 0));
const ref = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();
const invoiceReference = bill => bill.vendorRefKind !== 'bank' && !/^BANK_(LINE|GROUP)_BILL:/.test(bill.idempotencyKey || '');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SIMILAR_DAYS = 3;
// Amounts recur across unrelated orders/trips. A linked document is a soft
// duplicate candidate only within the same target; invoice references stay global.
const linkedTargets = lines => new Set((lines || []).flatMap(line => {
  if (line.target === 'trip' && line.tripId) return [`trip:${id(line.tripId)}`];
  if (line.target === 'order' && line.orderId) return [`order:${id(line.orderId)}`];
  if (line.target === 'customs' && line.orderId) return [`customs:${id(line.orderId)}:${id(line.packageId)}`];
  return [];
}));

// References are stronger than amount/date similarities. Neither permits silently merging money.
async function candidates(input, { session, excludeId } = {}) {
  if (input.isCreditNote || input.isHistorical || input.migrationRunId || !isDay(input.day) || !mongoose.isValidObjectId(input.vendorId)) return [];
  const orders = [...new Set((input.lines || []).map(l => id(l.orderId)).filter(Boolean))];
  const trips = [...new Set((input.lines || []).map(l => id(l.tripId)).filter(Boolean))];
  const inputTargets = linkedTargets(input.lines);
  const total = amount(input), reference = ref(input.vendorRef);
  const vendor = await Vendor.findById(input.vendorId).select('_id seedKey').session(session || null).lean();
  if (!vendor || total <= 0) return [];
  const expenseOnly = input.lines?.length > 0 && input.lines.every(l => l.target === 'expense' && l.accountId);
  // A statement creates a bill under the real merchant; Quick Expenses uses a generic
  // vendor. Compare the actual outgoing payment as well, independently of vendor names.
  // Only whole single-bill payments qualify; a batch total is not one expense.
  const payments = expenseOnly && !input.officeExpense && mongoose.isValidObjectId(input.paidImmediatelyFrom)
    ? await SupplierPayment.find({ status: 'posted', fromAccountId: input.paidImmediatelyFrom,
      currency: input.currency, amount: total, employeeId: input.employeeId || null,
      day: { $gte: addDays(input.day, -SIMILAR_DAYS), $lte: addDays(input.day, SIMILAR_DAYS) },
      'allocations.0': { $exists: true }, 'allocations.1': { $exists: false },
    }).select('allocations day updatedAt').session(session || null).lean() : [];
  const paidBills = new Map(payments.map(p => [id(p.allocations[0].billId), p]));
  const vendorScope = { $or: [{ vendorId: vendor._id }, ...(orders.length ? [{ 'lines.orderId': { $in: orders } }] : []), ...(trips.length ? [{ 'lines.tripId': { $in: trips } }] : [])],
    ...(reference && invoiceReference(input) ? {} : { currency: input.currency, day: { $gte: addDays(input.day, -SIMILAR_DAYS), $lte: addDays(input.day, SIMILAR_DAYS) } }) };
  const bills = await SupplierBill.find({ $or: [vendorScope, ...(paidBills.size ? [{ _id: { $in: [...paidBills.keys()] } }] : [])],
    isCreditNote: { $ne: true }, status: { $in: ['draft', 'posted'] },
    ...(excludeId && { _id: { $ne: excludeId } }),
  }).session(session || null).lean();
  const rows = [];
  // Quick expenses and costs paid on the spot share one generic vendor ("مصروفات نقدية"): the same
  // small amount twice in a week (fuel, hospitality, a purchase paid in cash) is normal, so for it
  // vendor/amount alone is not enough. A reviewed same-account payment below is
  // stronger evidence; staff office-expense entry retains its existing workflow.
  const generic = vendor.seedKey === 'cash_expenses' || !!input.isQuickExpense;
  const expenseAccounts = new Set((input.lines || []).map(l => id(l.accountId)).filter(Boolean));
  const expenseTargets = lines => [...new Set(lines.map(l => `${id(l.accountId)}:${l.office || ''}`))].sort().join('|');
  for (const bill of bills) {
    const sameVendor = id(bill.vendorId) === id(vendor);
    const alikeVendor = sameVendor && !generic && !bill.isQuickExpense;
    const sameRef = sameVendor && invoiceReference(input) && invoiceReference(bill) && !!reference && ref(bill.vendorRef) === reference;
    const sameAmount = bill.currency === input.currency && Math.abs(amount(bill) - total) < 0.0005;
    const sameOrder = bill.lines.some(l => orders.includes(id(l.orderId)));
    const billTargets = linkedTargets(bill.lines);
    const sameTarget = [...billTargets].some(target => inputTargets.has(target));
    if (!sameRef && billTargets.size && !sameTarget) continue;
    const payment = paidBills.get(id(bill));
    const samePaidExpense = !!payment && payment.allocations[0].amountUsd === bill.totalUsd && bill.status === 'posted'
      && bill.lines.every(l => l.target === 'expense') && expenseTargets(input.lines) === expenseTargets(bill.lines);
    if (!sameRef && expenseOnly && !bill.lines.every(l => l.target === 'expense' && expenseAccounts.has(id(l.accountId)))) continue;
    if (!sameRef && !samePaidExpense && !(sameAmount && (alikeVendor || sameOrder || sameTarget) && Math.abs(new Date(bill.day) - new Date(input.day)) <= SIMILAR_DAYS * 86400000)) continue;
    rows.push({ key: `bill:${bill._id}`, billId: bill._id, status: bill.status, number: bill.number || 'مسودة', day: bill.day, amount: amount(bill), currency: bill.currency,
      strength: sameRef ? 'reference' : sameOrder ? 'order' : 'similar',
      reason: sameRef ? 'رقم فاتورة المورد نفسه' : sameOrder ? 'نفس الطلبية والمبلغ والعملة وتاريخ قريب' : samePaidExpense
        ? 'مصروف مسدد من نفس الحساب، بنفس مبلغ الدفع وعملته وحساب المصروف والمكتب وتاريخ قريب؛ قد يكون مسجلاً من الكشف'
        : sameTarget ? 'نفس الرحلة أو بند التخليص والمبلغ والعملة وتاريخ قريب' : 'نفس المورد والمبلغ والعملة وتاريخ قريب',
      fingerprint: hash([id(bill), bill.status, bill.updatedAt, bill.lines, bill.vendorRef, samePaidExpense ? payment : null]), url: `/accounting/bills/${bill._id}` });
  }
  if (orders.length) {
    const documents = await Order.find({ _id: { $in: orders } }).select('orderId purchaseItems').session(session || null).lean();
    for (const order of documents) for (const item of order.purchaseItems || []) {
      const day = item.date && toDay(item.date);
      if ((item.currency || 'USD') !== input.currency || !day || Math.abs(new Date(day) - new Date(input.day)) > SIMILAR_DAYS * 86400000) continue;
      if (!(input.lines || []).some(l => id(l.orderId) === id(order) && Math.abs(Number(l.amount) - Number(item.unitPrice)) < 0.0005)) continue;
      // An explicitly attached legacy item belongs to this invoice, rather than being another cost.
      if ((input.lines || []).some(l => id(l.purchaseItemId) === id(item))) continue;
      rows.push({ key: `item:${item._id}`, orderId: order._id, itemId: item._id, number: order.orderId, day, amount: item.unitPrice,
        description: item.description || '',
        currency: item.currency || 'USD', strength: 'order', reason: 'مشتريات مسجلة بالفعل داخل الطلبية',
        fingerprint: hash(item), url: `/invoice/${order._id}/edit` });
    }
  }
  if (expenseOnly && !input.officeExpense && mongoose.isValidObjectId(input.paidImmediatelyFrom)) {
    const config = await require('./config').getConfig();
    const paying = config.accountsById.get(id(input.paidImmediatelyFrom));
    if (paying && (paying.currency || 'USD') === input.currency) {
      const nativeTotal = await require('./posting/common').toCurrencyMinor(total, input.currency);
      const entries = await require('../models').JournalEntry.find({ status: 'posted', reversalOf: { $exists: false },
        day: { $gte: addDays(input.day, -SIMILAR_DAYS), $lte: addDays(input.day, SIMILAR_DAYS) }, 'lines.accountId': input.paidImmediatelyFrom,
        $or: [{ eventType: 'MANUAL' }, { 'source.model': 'Expense' }],
      }).session(session || null).lean();
      for (const entry of entries) {
        const bankAmount = entry.lines.filter(l => id(l.accountId) === id(paying)).reduce((s, l) => s + Number(l.amountCurrency ?? (l.debit - l.credit)), 0);
        const costs = entry.lines.filter(l => expenseAccounts.has(id(l.accountId)) && Number(l.debit) > 0);
        if (bankAmount !== -nativeTotal || !costs.length || expenseTargets(costs) !== expenseTargets(input.lines)) continue;
        rows.push({ key: `entry:${entry._id}`, entryId: entry._id, status: 'posted', number: entry.number, day: entry.day,
          amount: total, currency: input.currency, strength: 'similar', reason: 'مصروف مدفوع محتمل في قيد يدوي أو شاشة المصروفات السابقة',
          fingerprint: hash([entry._id, entry.status, entry.lines, entry.updatedAt]), url: `/accounting/entries/${entry._id}` });
      }
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
