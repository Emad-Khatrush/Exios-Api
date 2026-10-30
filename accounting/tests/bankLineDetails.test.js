const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { CurrencyRate, JournalEntry } = require('../models');
const { BankStatementLine, SupplierBill, Vendor } = require('../models/documents');
const { runInTransaction: tx } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const bank = require('../services/posting/bank');
const { details } = require('../services/posting/bankLineDetails');
const payables = require('../services/posting/payables');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 40 }); });
async function imported(amount = 1000) {
  const source = await account('110204');
  await bank.importStatement(source._id, [{ day: '2026-03-02', description: 'Correction test', amount }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id }).lean();
  return { source, line };
}
test('unposted details show the actual bank and no fabricated accounting entries', async () => {
  const { line } = await imported();
  const result = await details(line._id);
  expect(result.line.accountId.code).toBe('110204');
  expect(result.entries).toEqual([]);
  expect(result.bills).toEqual([]);
  await expect(details('bad-id')).rejects.toThrow('غير صالح');
});
test('cancel and correct a journal twice: new posted entries, preserved history, correct native and USD balances', async () => {
  const { source, line } = await imported();
  const counter = await account('310000');
  const input = { counterAccountId: counter._id, confirmNotDuplicate: true };
  const first = await tx(session => bank.createEntryForLine(line._id, input, { session, req }));
  const firstId = String(first.entryId);
  for (let i = 1; i <= 2; i++) {
    await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: `Correction ${i}` }));
    expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
    const current = await tx(session => bank.createEntryForLine(line._id, input, { session, req }));
    expect(String(current.entryId)).not.toBe(firstId);
    expect((await JournalEntry.findById(current.entryId)).status).toBe('posted');
    expect(await getBalance(source._id)).toEqual({ usd: 2500, foreign: 100000 });
  }
  const result = await details(line._id);
  expect(result.entries).toHaveLength(5);
  expect(result.entries.filter(e => e.role === 'settlement')).toHaveLength(1);
  expect(result.entries.every(e => e.totalDebit === e.totalCredit)).toBe(true);
  expect(result.entries[0].lines.some(l => l.accountId.code === '110204')).toBe(true);
  expect(result.audit.filter(a => a.action === 'bank.cancelEntry')).toHaveLength(2);
});
test('supplier details include both cost accounts and payment accounts; cancellation preserves a pre-existing invoice', async () => {
  const source = await account('110204'); const expense = await account('530800');
  const vendor = await Vendor.create({ name: 'Details vendor', type: 'supplier' });
  const bill = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-03-02', currency: 'USD',
    lines: [{ description: 'existing cost', target: 'expense', accountId: expense._id, office: 'turkey', amount: 25 }] }, { session, req }));
  await bank.importStatement(source._id, [{ day: '2026-03-02', description: 'Details supplier', amount: -1000, originalAmount: 25, originalCurrency: 'USD' }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id }).lean();
  await tx(session => bank.createEntryForLine(line._id, { billId: bill._id, manualBillMatch: true, confirmNotDuplicate: true }, { session, req }));
  const result = await details(line._id);
  expect(result.bills[0].vendorId.name).toBe('Details vendor');
  expect(result.entries.some(e => e.role === 'cost' && e.lines.some(l => l.accountId.code === expense.code))).toBe(true);
  expect(result.entries.some(e => e.role === 'settlement' && e.lines.some(l => l.accountId.code === source.code))).toBe(true);
  await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'Wrong payment' }));
  expect((await SupplierBill.findById(bill._id)).status).toBe('posted');
  expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
});
test('a transfer matched on another statement cannot be reversed until that match is released', async () => {
  const { line } = await imported();
  const counter = await account('310000');
  const entry = await tx(session => bank.createEntryForLine(line._id, { counterAccountId: counter._id }, { session, req }));
  await BankStatementLine.create({ accountId: counter._id, day: line.day, amount: -1000, lineStatus: 'matched', matchedEntryIds: [entry.entryId] });
  await expect(tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'Correction' }))).rejects.toThrow('كشف آخر');
  expect((await JournalEntry.findById(entry.entryId)).status).toBe('posted');
  expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('created_entry');
});

test('editing source values preserves the original, recalculates proposals and deduplicates both file versions', async () => {
  const { source, line } = await imported();
  const input = { day: '2026-03-03', amount: 1200, description: 'Corrected description', reference: 'REF-EDIT', originalAmount: 55, originalCurrency: 'SAR', reason: 'Bank evidence corrected' };
  const count = await JournalEntry.countDocuments();
  const changed = await tx(session => bank.editLine(line._id, input, { session, req }));
  expect(changed.amount).toBe(120000);
  expect(changed.importedValues.amount).toBe(100000);
  expect(await JournalEntry.countDocuments()).toBe(count);
  const originalRow = { day: line.day, amount: 1000, description: line.description };
  expect((await bank.classifyRows(source._id, [originalRow]))[0].status).toBe('imported');
  expect((await bank.classifyRows(source._id, [input]))[0].status).toBe('imported');
  await bank.importStatement(source._id, [originalRow, input], { req });
  expect(await BankStatementLine.countDocuments({ accountId: source._id })).toBe(1);
  const result = await details(line._id);
  expect(result.audit.some(a => a.action === 'bank.lineEdit' && a.after.reason === input.reason)).toBe(true);
});
test('source edits reject posted lines, missing reasons, invalid currency pairs and collisions', async () => {
  const { source, line } = await imported();
  const input = { day: line.day, amount: 1000, description: line.description, reason: 'Correction' };
  await expect(tx(session => bank.editLine(line._id, { ...input, reason: '' }, { session, req }))).rejects.toThrow('سبب');
  await expect(tx(session => bank.editLine(line._id, { ...input, originalAmount: 10 }, { session, req }))).rejects.toThrow('معاً');
  await bank.importStatement(source._id, [{ day: line.day, amount: 999, description: 'Second line' }], { req });
  await expect(tx(session => bank.editLine(line._id, { ...input, amount: 999, description: 'Second line' }, { session, req }))).rejects.toThrow('موجود');
  const counter = await account('310000');
  await tx(session => bank.createEntryForLine(line._id, { counterAccountId: counter._id }, { session, req }));
  await expect(tx(session => bank.editLine(line._id, input, { session, req }))).rejects.toThrow('قبل تعديل');
});
test('a cancelled order purchase can be approved again with fresh invoice and payment keys', async () => {
  const Order = require('../../models/order');
  const itemId = oid(); const orderId = (await Order.collection.insertOne({ orderId: 'DETAILS-RETRY', user: oid(), placedAt: 'tripoli', totalInvoice: 100,
    isPayment: true, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-03-02'),
    purchaseItems: [{ _id: itemId, unitPrice: 25, currency: 'USD', date: new Date('2026-03-02'), description: 'Order retry' }] })).insertedId;
  const { line, source } = await imported(-1000);
  const choice = { kind: 'order_item', orderId, itemId };
  const review = require('../services/posting/bankPurchaseReview');
  await tx(session => review.matchPurchase(line._id, choice, { session, req }));
  const original = await BankStatementLine.findById(line._id).lean();
  await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'Retry order' }));
  await tx(session => review.matchPurchase(line._id, choice, { session, req }));
  const corrected = await BankStatementLine.findById(line._id).lean();
  expect(String(corrected.billId)).not.toBe(String(original.billId));
  expect(String(corrected.paymentId)).not.toBe(String(original.paymentId));
  expect((await JournalEntry.findById(corrected.entryId)).status).toBe('posted');
  expect(await getBalance(source._id)).toEqual({ usd: -2500, foreign: -100000 });
});
