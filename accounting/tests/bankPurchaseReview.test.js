const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { CurrencyRate, JournalEntry } = require('../models');
const { Vendor, SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const Order = require('../../models/order');
const { runInTransaction } = require('../services/transaction');
const bank = require('../services/posting/bank');
const review = require('../services/posting/bankPurchaseReview');
const payables = require('../services/posting/payables');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 50 }); });
async function order(number, amount, date = '2026-09-20T10:00:00Z') {
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: number, customerId: number })).insertedId;
  const itemId = oid();
  const id = (await Order.collection.insertOne({ orderId: number, user: customer, placedAt: 'tripoli', totalInvoice: 100,
    isPayment: true, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date(date),
    purchaseItems: [{ _id: itemId, unitPrice: amount, currency: 'USD', date: new Date(date), description: `purchase ${number}` }] })).insertedId;
  return { id, itemId };
}
async function bill(amount, currency = 'USD', day = '2026-09-20', options = {}) {
  const vendor = await Vendor.create({ name: `Vendor-${oid()}`, type: 'supplier' });
  const expense = await account('530800');
  return tx(session => payables.createBill({ vendorId: vendor._id, day, currency, ...(currency !== 'USD' && { rate: currency === 'KWD' ? 3.1 : 0.9 }),
    lines: [{ description: 'review purchase', amount, ...(options.orderId ? { target: 'order', orderId: options.orderId } : { target: 'expense', accountId: expense._id, office: 'turkey' }) }] },
  { session, req, asDraft: options.asDraft !== false }));
}
async function imported(extra = {}) {
  const source = await account('110204');
  const row = { day: '2026-09-20', description: 'Bank purchase', amount: -2750, originalAmount: 55, originalCurrency: 'USD', ...extra };
  await bank.importStatement(source._id, [row], { req });
  return { source, row, line: await BankStatementLine.findOne({ accountId: source._id }).lean() };
}
test('known merchant mismatch is blocked in the list, purchase matching and direct posting endpoints', async () => {
  const original = await bill(55);
  await Vendor.create({ name: 'Alibaba review merchant', type: 'supplier', bankAliases: ['Alibaba.com Luxembourg'] });
  const { line, source } = await imported({ description: 'Alibaba.com Luxembourg (55.00 USD)' });
  const result = await review.listPurchases({ accountId: String(source._id), lineId: String(line._id), status: 'all' });
  expect(result.results.find(r => String(r.billId) === String(original._id))).toMatchObject({ merchantMismatch: true, canMatch: false });
  const entries = await JournalEntry.countDocuments();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }))).rejects.toThrow('المورد المختار مختلف');
  await expect(tx(session => bank.createEntryForLine(line._id, { billId: original._id, manualBillMatch: true, confirmDifference: true }, { session, req }))).rejects.toThrow('المورد المختار مختلف');
  expect(await JournalEntry.countDocuments()).toBe(entries);
});
test('date and source filters separate direct bills, recorded orders and unrecorded order purchases without duplication', async () => {
  const recorded = await order('ORD-REC', 20);
  await order('ORD-RAW', 30);
  await order('ORD-OLD', 40, '2026-08-01T10:00:00Z');
  await bill(10); await bill(20, 'USD', '2026-09-20', { orderId: recorded.id }); await bill(40, 'USD', '2026-08-01');
  const source = await account('110204');
  const filters = { accountId: source._id, from: '2026-09-20', to: '2026-09-20' };
  const all = await review.listPurchases(filters);
  expect(all.total).toBe(3);
  expect(all.results.filter(r => r.kind === 'order_item')).toHaveLength(1);
  expect((await review.listPurchases({ ...filters, source: 'direct' })).results.map(r => r.amount)).toEqual([10]);
  const orderRows = (await review.listPurchases({ ...filters, source: 'order' })).results;
  expect(orderRows).toHaveLength(2);
  expect(orderRows.every(r => r.source === 'order')).toBe(true);
  expect((await review.listPurchases({ ...filters, q: 'ORD-RAW' })).total).toBe(1);
  expect((await review.listPurchases({ ...filters, q: '[invalid.*' })).total).toBe(0);
  await expect(review.listPurchases({ ...filters, from: '2026-10-01' })).rejects.toThrow('فترة البحث');
});
test('order date filters use the Libya accounting day for late-night purchases', async () => {
  await order('LATE-ORDER', 30, '2026-09-19T23:15:00Z');
  const source = await account('110204');
  expect((await review.listPurchases({ accountId: source._id, from: '2026-09-20', to: '2026-09-20', source: 'order' })).results[0].day).toBe('2026-09-20');
});
test('manual selection outside the automatic date window needs confirmation and settles the original invoice', async () => {
  const original = await bill(55, 'USD', '2026-09-01');
  const { line } = await imported();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id }, { session, req }))).rejects.toThrow('أكد الاختلاف');
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await payables.apBalance(payables.billKey(original._id))).toBe(0);
  expect((await BankStatementLine.findById(line._id)).matchedOriginalAmount).toBe(55);
});
test('confirmed KWD discrepancy retains the bank evidence and values a 173 KWD draft from the actual 564.38 USD settlement', async () => {
  const original = await bill(173, 'KWD');
  const { line } = await imported({ originalAmount: 17.3, originalCurrency: 'KWD', settlementUsd: 564.38, amount: -27924.44 });
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id }, { session, req }))).rejects.toThrow('أكد الاختلاف');
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  expect(await SupplierBill.findById(original._id).lean()).toMatchObject({ total: 173, totalUsd: 56438 });
  expect(await BankStatementLine.findById(line._id).lean()).toMatchObject({ originalAmount: 17.3, matchedOriginalAmount: 173, matchDifferenceConfirmed: true });
  expect(await SupplierBill.countDocuments()).toBe(1);
});
test('a different original currency is refused even when a difference was confirmed', async () => {
  const original = await bill(55, 'EUR'); const { line } = await imported();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }))).rejects.toThrow('عملة المشتريات');
  expect(await SupplierPayment.countDocuments()).toBe(0);
});
test('an unrecorded order item becomes one linked invoice and payment and cannot be matched again', async () => {
  const purchase = await order('RAW-MATCH', 30);
  const { line } = await imported({ originalAmount: 30, amount: -1500 });
  await tx(session => review.matchPurchase(line._id, { kind: 'order_item', orderId: purchase.id, itemId: purchase.itemId }, { session, req }));
  expect(await BankStatementLine.findById(line._id).lean()).toMatchObject({ orderId: purchase.id, purchaseItemId: purchase.itemId, matchedOriginalAmount: 30 });
  expect(await SupplierBill.countDocuments()).toBe(1); expect(await SupplierPayment.countDocuments()).toBe(1);
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'order_item', orderId: purchase.id, itemId: purchase.itemId }, { session, req }))).rejects.toThrow('غير مطابق');
});
test('a paid invoice is reconciled to its existing bank payment without creating another payment', async () => {
  const original = await bill(55, 'USD', '2026-09-20', { asDraft: false });
  const source = await account('110204');
  const payment = await tx(session => payables.createPayment({ vendorId: original.vendorId, day: '2026-09-20', fromAccountId: source._id, amount: 2750, rate: 50,
    allocations: [{ billId: original._id, amountUsd: 5500 }] }, { session, req }));
  const { line } = await imported({ purchaseMatch: { kind: 'bill', billId: original._id } });
  expect(line.lineStatus).toBe('matched');
  expect(String(line.matchedEntryIds[0])).toBe(String(payment.entryId));
  expect(String(line.billId)).toBe(String(original._id));
  expect(line.purchaseReviewPending).toBe(false);
  expect(await SupplierPayment.countDocuments()).toBe(1);
});
test('manual selections during import use the selected original invoice and retain failed reviews for retry', async () => {
  const original = await bill(55);
  const { source, row, line } = await imported({ purchaseMatch: { kind: 'bill', billId: original._id } });
  expect(line.lineStatus).toBe('created_entry');
  expect(line.purchaseReviewPending).toBe(false);
  expect((await bank.importStatement(source._id, [row], { req })).posted).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(1);
  const sums = await JournalEntry.find().lean();
  expect(sums.every(e => e.lines.reduce((s, l) => s + l.debit - l.credit, 0) === 0)).toBe(true);
});
