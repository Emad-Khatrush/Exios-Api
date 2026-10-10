const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { CurrencyRate, JournalEntry } = require('../models');
const { Vendor, SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const { runInTransaction } = require('../services/transaction');
const bank = require('../services/posting/bank');
const exact = require('../services/posting/bankExactMatch');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'TRY', day: '2026-09-20', rate: 50 }); });
async function fixture(day = '2026-09-20', amount = 30) {
  const source = await account('110204'), expense = await account('530400');
  const vendor = await Vendor.create({ name: `Exact merchant ${oid()}`, type: 'supplier' });
  const bill = await runInTransaction(session => require('../services/posting/payables').createBill({ vendorId: vendor._id, day, currency: 'USD',
    lines: [{ description: 'Exact cost', amount, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req, asDraft: true }));
  const line = await BankStatementLine.create({ accountId: source._id, day: '2026-09-20', amount: -150000, originalAmount: 30, originalCurrency: 'USD', description: 'Exact purchase' });
  return { source, expense, vendor, bill, line };
}
test('one exact invoice can be posted from the bulk action once without creating a second cost', async () => {
  const { source, bill, line } = await fixture();
  const expected = (await bank.suggestions(source._id))[line._id].exactMatch;
  expect(expected).toMatchObject({ kind: 'bill', billId: bill._id });
  await runInTransaction(session => exact.match(line._id, { expected }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('created_entry');
  await expect(runInTransaction(session => exact.match(line._id, { expected }, { session, req }))).rejects.toThrow('لم يعد متاحًا');
});
test('different dates and amounts are unavailable to exact bulk posting', async () => {
  const { source, bill, line } = await fixture('2026-09-21');
  expect((await bank.suggestions(source._id))[line._id].exactMatch).toBeUndefined();
  await SupplierBill.updateOne({ _id: bill._id }, { $set: { day: '2026-09-20', 'lines.0.amount': 31, total: 31 } });
  expect((await bank.suggestions(source._id))[line._id].exactMatch).toBeUndefined();
  expect(await SupplierPayment.countDocuments()).toBe(0);
});
test('multiple matching invoices or competing statement lines require individual review', async () => {
  const { source, expense, vendor, line } = await fixture();
  await runInTransaction(session => require('../services/posting/payables').createBill({ vendorId: vendor._id, day: line.day, currency: 'USD',
    lines: [{ description: 'Second cost', amount: 30, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req, asDraft: true }));
  expect((await bank.suggestions(source._id))[line._id].exactMatch).toBeUndefined();
  await SupplierBill.deleteOne({ 'lines.description': 'Second cost' });
  const expected = (await bank.suggestions(source._id))[line._id].exactMatch;
  await BankStatementLine.create({ accountId: source._id, day: line.day, amount: line.amount, originalAmount: 30, originalCurrency: 'USD', description: 'Competing purchase' });
  expect((await bank.suggestions(source._id))[line._id].exactMatch).toBeUndefined();
  await expect(runInTransaction(session => exact.match(line._id, { expected }, { session, req }))).rejects.toThrow('أكثر من سطر');
});
test('a changed proposal is rejected at execution rather than silently matching a new invoice', async () => {
  const { source, bill, line } = await fixture();
  const expected = (await bank.suggestions(source._id))[line._id].exactMatch;
  await SupplierBill.updateOne({ _id: bill._id }, { $set: { day: '2026-09-22' } });
  await expect(runInTransaction(session => exact.match(line._id, { expected }, { session, req }))).rejects.toThrow('تغيّر المقترح');
  expect(await SupplierPayment.countDocuments()).toBe(0);
});
test('a single exact ledger movement is linked without creating a new entry', async () => {
  const source = await account('110202'), capital = await account('310000');
  const entry = await post({ eventType: 'MANUAL', eventKey: 'exact:ledger', date: '2026-09-20', lines: [
    { accountId: source._id, debit: 3000 }, { accountId: capital._id, credit: 3000 },
  ] });
  const line = await BankStatementLine.create({ accountId: source._id, day: '2026-09-20', amount: 3000, description: 'Exact deposit' });
  const expected = (await bank.suggestions(source._id))[line._id].exactMatch;
  expect(expected).toMatchObject({ kind: 'ledger', entryId: entry._id });
  await runInTransaction(session => exact.match(line._id, { expected }, { session, req }));
  expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('matched');
  expect(await JournalEntry.countDocuments()).toBe(1);
});
test('an exact unrecorded order purchase is created and linked once through the bulk path', async () => {
  const mongoose = require('mongoose');
  const Order = require('../../models/order');
  const customer = (await mongoose.connection.collection('users').insertOne({ customerId: 'exact-order', firstName: 'Exact', phone: 'exact-order' })).insertedId;
  const itemId = oid(), date = new Date('2026-09-20T10:00:00Z');
  const orderId = (await Order.collection.insertOne({ orderId: '1111-2222', user: customer, placedAt: 'tripoli', totalInvoice: 100, isPayment: true,
    unsureOrder: false, isCanceled: false, paymentList: [], createdAt: date,
    purchaseItems: [{ _id: itemId, unitPrice: 30, currency: 'USD', date, description: 'Exact order cost' }] })).insertedId;
  const source = await account('110204');
  const line = await BankStatementLine.create({ accountId: source._id, day: '2026-09-20', amount: -150000,
    originalAmount: 30, originalCurrency: 'USD', description: 'Order purchase' });
  const expected = (await bank.suggestions(source._id))[line._id].exactMatch;
  expect(expected).toMatchObject({ kind: 'order_item', orderId, itemId });
  await runInTransaction(session => exact.match(line._id, { expected }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  expect((await BankStatementLine.findById(line._id)).purchaseItemId).toEqual(itemId);
});
