const { SupplierBill, SupplierPayment, SupplierReceipt } = require('../models/documents');
const { getConfig } = require('./config');
const { roundHalfAway } = require('./money');

// Original document currencies, never today's conversion of the USD ledger.
// Open equivalents are explicitly at each bill's booked USD value, because
// allocations, credit notes and netting settle the existing USD payable key.
async function build(vendorId, openBills, { showCanceled = false } = {}) {
  const status = { $in: showCanceled ? ['posted', 'canceled'] : ['posted'] };
  const [bills, payments, receipts, config] = await Promise.all([
    SupplierBill.find({ vendorId, status }).select('number day currency total totalUsd status isCreditNote originalBillId paidBeforeCount note createdAt').sort({ day: -1, createdAt: -1, _id: -1 }).lean(),
    SupplierPayment.find({ vendorId, status }).select('number day currency amount status fromAdvance allocations advancePaymentId advanceAmount isHistorical autoFromBillId entryId note createdAt').sort({ day: -1, createdAt: -1, _id: -1 }).lean(),
    SupplierReceipt.find({ vendorId, status }).select('number day currency amount status entryId note createdAt').sort({ day: -1, createdAt: -1, _id: -1 }).lean(),
    getConfig(),
  ]);
  const openById = new Map(openBills.map(bill => [String(bill._id), bill.open]));
  const groups = new Map();
  const digits = currency => config.currencies.get(currency)?.decimals ?? 2;
  const group = currency => {
    if (!groups.has(currency)) groups.set(currency, { currency, billed: 0, creditNotes: 0, payments: 0, receipts: 0, openEquivalent: 0 });
    return groups.get(currency);
  };
  const rounded = (amount, currency) => roundHalfAway(amount * 10 ** digits(currency)) / 10 ** digits(currency);
  const invoiceRows = bills.map(bill => {
    const openUsd = bill.status === 'posted' && !bill.isCreditNote ? (openById.get(String(bill._id)) || 0) : null;
    const openEquivalent = openUsd === null ? null : !openUsd ? 0 : bill.totalUsd > 0 ? rounded(openUsd / bill.totalUsd * bill.total, bill.currency) : null;
    if (bill.status === 'posted') {
      group(bill.currency)[bill.isCreditNote ? 'creditNotes' : 'billed'] += Number(bill.total || 0);
      if (openEquivalent !== null) group(bill.currency).openEquivalent += openEquivalent;
    }
    return { ...bill, openUsd, openEquivalent, url: `/accounting/bills/${bill._id}` };
  });
  const paymentRows = payments.map(payment => {
    const currency = payment.currency || 'USD';
    const amount = payment.fromAdvance ? payment.advancePaymentId ? payment.advanceAmount : (payment.allocations || []).reduce((sum, line) => sum + line.amountUsd, 0) / 100 : payment.amount;
    // Using an already paid advance does not pay that money again.
    if (payment.status === 'posted' && !payment.fromAdvance && Number.isFinite(amount)) group(currency).payments += amount;
    return { ...payment, currency, amount, kind: payment.fromAdvance ? 'advance_allocation' : 'payment', url: payment.entryId ? `/accounting/entries/${payment.entryId}` : null };
  });
  const receiptRows = receipts.map(receipt => {
    const currency = receipt.currency || 'USD';
    if (receipt.status === 'posted' && Number.isFinite(receipt.amount)) group(currency).receipts += receipt.amount;
    return { ...receipt, currency, kind: 'receipt', url: receipt.entryId ? `/accounting/entries/${receipt.entryId}` : null };
  });
  const settlements = [...paymentRows, ...receiptRows].sort((a, b) => b.day.localeCompare(a.day) || new Date(b.createdAt) - new Date(a.createdAt) || String(b._id).localeCompare(String(a._id)));
  const totals = [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(row => ({ ...row,
    ...Object.fromEntries(['billed', 'creditNotes', 'payments', 'receipts', 'openEquivalent'].map(field => [field, rounded(row[field], row.currency)])) }));
  const currencies = [...new Set([...bills.map(row => row.currency), ...settlements.map(row => row.currency)])].filter(Boolean).sort();
  return { totals, invoices: invoiceRows, settlements, currencies, openEquivalentBasis: 'bill_book_value' };
}

module.exports = { build };
