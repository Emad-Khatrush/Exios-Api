const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { CurrencyRate, JournalEntry } = require('../models');
const { BankStatementLine, SupplierBill, SupplierPayment, Vendor } = require('../models/documents');
const { getBalance } = require('../services/carrying');
const bank = require('../services/posting/bank');
const payables = require('../services/posting/payables');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 40 });
});

async function purchase({ originalCurrency = 'SAR', originalAmount = 55, settlementUsd, amount = -2000, ...extra } = {}) {
  const source = await account('110204');
  const expense = await account('530800');
  const row = { day: '2026-03-02', description: 'Native Merchant', originalCurrency, originalAmount, amount,
    ...(settlementUsd && { settlementUsd }), counterAccountId: expense._id, office: 'turkey', ...extra };
  const result = await bank.importStatement(source._id, [row], { req });
  return { result, row, source, line: await BankStatementLine.findOne({ accountId: source._id }).lean() };
}

test('SAR 55 paid as TRY 2000 preserves the direct pair without inventing a USD quote', async () => {
  const { result, line, source } = await purchase();
  expect(result.posted).toBe(1);
  expect(result.notPosted).toHaveLength(0);
  expect(line).toMatchObject({ originalCurrency: 'SAR', originalAmount: 55, valuationSource: 'direct_cross', rateBaseCurrency: 'SAR', rateQuoteCurrency: 'TRY' });
  expect(line.crossRate).toBeCloseTo(2000 / 55, 8);
  expect(line.settlementUsd).toBeUndefined();
  const bill = await SupplierBill.findById(line.billId).lean();
  expect(bill).toMatchObject({ currency: 'SAR', total: 55, totalUsd: 5000 });
  expect(bill.note).toContain('TRY/SAR');
  expect(await getBalance(source._id)).toEqual({ usd: -5000, foreign: -200000 });
  expect(await payables.apBalance(payables.billKey(bill._id))).toBe(0);
  const entry = await JournalEntry.findById(line.entryId).lean();
  expect(entry.lines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0)).toBe(0);
});

test.each([['EUR', 99], ['KWD', 12.345], ['GBP', 55]])('direct %s/TRY keeps native precision', async (originalCurrency, originalAmount) => {
  const { result, line } = await purchase({ originalCurrency, originalAmount });
  expect(result.posted).toBe(1);
  expect(line.settlementUsd).toBeUndefined();
  expect(line.crossRate).toBeCloseTo(2000 / originalAmount, 8);
  expect(await SupplierBill.findById(line.billId).lean()).toMatchObject({ currency: originalCurrency, total: originalAmount });
});

test('a printed USD intermediary is preserved separately from EUR/TRY', async () => {
  const { result, line } = await purchase({ originalCurrency: 'EUR', originalAmount: 99, settlementUsd: 115.33, amount: -5685.42 });
  expect(result.posted).toBe(1);
  expect(line).toMatchObject({ settlementUsd: 115.33, valuationSource: 'statement', rateBaseCurrency: 'EUR', rateQuoteCurrency: 'TRY' });
  expect(line.exchangeRate).toBeCloseTo(5685.42 / 115.33, 8);
  expect(line.crossRate).toBeCloseTo(5685.42 / 99, 8);
  expect(await SupplierBill.findById(line.billId).lean()).toMatchObject({ currency: 'EUR', total: 99, totalUsd: 11533 });
});

test('an original USD purchase uses the actual TRY/USD pair', async () => {
  const { result, line } = await purchase({ originalCurrency: 'USD' });
  expect(result.posted).toBe(1);
  expect(line.settlementUsd).toBe(55);
  expect(line.crossRate).toBeCloseTo(2000 / 55, 8);
  expect(await SupplierBill.findById(line.billId).lean()).toMatchObject({ currency: 'USD', total: 55 });
});

test('direct conversion remains SAR/TRY when the paying bank has a different carrying value', async () => {
  const source = await account('110204');
  const capital = await account('310000');
  await post({ eventType: 'MANUAL', eventKey: 'NATIVE_FUND', date: '2026-03-01', description: 'test bank funding', lines: [
    { accountId: source._id, debit: 100000, currency: 'TRY', amountCurrency: 5000000 },
    { accountId: capital._id, credit: 100000 },
  ] });
  const { result, line } = await purchase();
  expect(result.posted).toBe(1);
  expect(line.crossRate).toBeCloseTo(2000 / 55, 8);
  expect(line.settlementUsd).toBeUndefined();
  expect(line.valuationUsd).toBe(40);
  expect(await SupplierBill.findById(line.billId).lean()).toMatchObject({ currency: 'SAR', total: 55, totalUsd: 4000 });
  expect(await getBalance(source._id)).toEqual({ usd: 96000, foreign: 4800000 });
});

test('a TRY purchase stays TRY and repeat imports create one native invoice and one payment', async () => {
  const { result, source, row, line } = await purchase({ originalCurrency: 'TRY', originalAmount: 2000 });
  expect(result.posted).toBe(1);
  expect(line.crossRate).toBe(1);
  expect(line.settlementUsd).toBeUndefined();
  expect(await SupplierBill.findById(line.billId).lean()).toMatchObject({ currency: 'TRY', total: 2000 });
  expect((await bank.importStatement(source._id, [row], { req })).posted).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await SupplierPayment.countDocuments()).toBe(1);
});

test('an existing native draft is settled once and canceling its bank payment retains the invoice', async () => {
  const vendor = await Vendor.create({ name: 'Native Merchant', type: 'supplier' });
  const expense = await account('530800');
  const draft = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-03-02', currency: 'SAR', rate: 1.1,
    lines: [{ description: 'Native goods', amount: 55, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req, asDraft: true }));
  const { result, line, source, row } = await purchase({ billId: draft._id });
  expect(result.posted).toBe(1);
  expect(String(line.billId)).toBe(String(draft._id));
  expect(line.billCreatedFromStatement).toBe(false);
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await payables.apBalance(payables.billKey(draft._id))).toBe(0);
  const repeated = await bank.importStatement(source._id, [row], { req });
  expect(repeated.posted).toBe(0);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'test cancellation' }));
  expect((await SupplierBill.findById(draft._id)).status).toBe('posted');
  expect(await payables.apBalance(payables.billKey(draft._id))).toBe(5000);
});

test('payment failure rolls back its new vendor and invoice while retaining the statement for review', async () => {
  const spy = jest.spyOn(payables, 'createPayment').mockRejectedValueOnce(new Error('simulated payment failure'));
  try {
    const { result, line } = await purchase();
    expect(result.posted).toBe(0);
    expect(result.notPosted[0].reason).toContain('simulated payment failure');
    expect(line.lineStatus).toBe('unmatched');
    expect(await SupplierBill.countDocuments()).toBe(0);
    expect(await JournalEntry.countDocuments()).toBe(0);
    expect(await Vendor.countDocuments({ name: 'Native Merchant' })).toBe(0);
  } finally { spy.mockRestore(); }
});

test('import suggests the original order invoice with reasons and waits for explicit approval', async () => {
  const mongoose = require('mongoose');
  const Order = require('../../models/order');
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: 'Native customer', customerId: 'MATCH1' })).insertedId;
  const { insertedId: orderId } = await Order.collection.insertOne({ orderId: 'MATCH-ORDER-1', user: customer, placedAt: 'tripoli',
    isPayment: true, totalInvoice: 100, unsureOrder: false, isCanceled: false, paymentList: [], purchaseItems: [], createdAt: new Date('2026-03-02') });
  const vendor = await Vendor.create({ name: 'Historical Vendor', type: 'supplier' });
  const original = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-03-02', currency: 'SAR', rate: 1.1,
    lines: [{ description: 'Original order purchase', amount: 55, target: 'order', orderId }] }, { session, req, asDraft: true }));
  const source = await account('110204');
  const row = { day: '2026-03-02', description: 'Bank merchant description', originalCurrency: 'SAR', originalAmount: 55, amount: -2000 };
  const [hint] = await bank.classifyRows(source._id, [row]);
  expect(hint).toMatchObject({ source: 'bill', requiresConfirmation: true, billId: null, account: null });
  expect(String(hint.suggestedBillId)).toBe(String(original._id));
  expect(hint.billCandidates[0]).toMatchObject({ currency: 'SAR', amount: 55, dayDifference: 0,
    orders: [{ number: 'MATCH-ORDER-1', description: 'Original order purchase' }] });
  expect(hint.billCandidates[0].matchReasons).toContain('المبلغ الأصلي مطابق');
  expect((await bank.importStatement(source._id, [row], { req })).posted).toBe(0);
  const line = await BankStatementLine.findOne({ accountId: source._id });
  expect(line.lineStatus).toBe('unmatched');
  expect(await JournalEntry.countDocuments()).toBe(0);
  const suggested = await bank.suggestions(source._id);
  expect(suggested[line._id].billCandidates[0].orders[0].number).toBe('MATCH-ORDER-1');
  const expense = await account('530800');
  await expect(tx(session => bank.createEntryForLine(line._id, { counterAccountId: expense._id }, { session, req }))).rejects.toThrow('اختر الفاتورة الأصلية');
  await tx(session => bank.createEntryForLine(line._id, { billId: original._id }, { session, req }));
  const posted = await BankStatementLine.findById(line._id).lean();
  expect(String(posted.orderId)).toBe(String(orderId));
  expect(String(posted.billId)).toBe(String(original._id));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await payables.apBalance(payables.billKey(original._id))).toBe(0);
});

test('multiple same-value invoices require a choice and the user can choose the second one', async () => {
  const vendor = await Vendor.create({ name: 'Historical Vendor', type: 'supplier' });
  const expense = await account('530800');
  const create = day => tx(session => payables.createBill({ vendorId: vendor._id, day, currency: 'SAR', rate: 1.1,
    lines: [{ description: 'Native purchase', amount: 55, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req, asDraft: true }));
  const first = await create('2026-03-01');
  const second = await create('2026-03-02');
  const { result, line, source, row } = await purchase();
  expect(result.posted).toBe(0);
  expect(result.notPosted[0].reason).toContain('اختر الفاتورة الأصلية');
  const [hint] = await bank.classifyRows(source._id, [{ ...row, description: 'Other unseen statement row', reference: 'NEW' }]);
  expect(hint.billCandidates).toHaveLength(2);
  expect(hint.suggestedBillId).toBeNull();
  await tx(session => bank.createEntryForLine(line._id, { billId: second._id }, { session, req }));
  expect((await SupplierBill.findById(first._id)).status).toBe('draft');
  expect((await SupplierBill.findById(second._id)).status).toBe('posted');
  expect(await SupplierBill.countDocuments()).toBe(2);
});

test('a repeated merchant suggests its original expense account, not the payment payable account', async () => {
  const { source } = await purchase();
  const expense = await account('530800');
  const next = await BankStatementLine.create({ accountId: source._id, day: '2026-03-03', description: 'Native Merchant',
    amount: -202000, originalAmount: 56, originalCurrency: 'SAR' });
  const before = await JournalEntry.countDocuments();
  const hint = (await bank.suggestions(source._id))[String(next._id)];
  expect(hint.source).toBe('history');
  expect(String(hint.account._id)).toBe(String(expense._id));
  expect(hint.office).toBe('turkey');
  expect(await JournalEntry.countDocuments()).toBe(before);
  expect((await BankStatementLine.findById(next._id)).lineStatus).toBe('unmatched');
  await tx(session => bank.createEntryForLine(next._id, { counterAccountId: hint.account._id, office: hint.office }, { session, req }));
  const saved = await BankStatementLine.findById(next._id).lean();
  expect(saved.lineStatus).toBe('created_entry');
  const bill = await SupplierBill.findById(saved.billId).lean();
  expect(bill.lines[0].target).toBe('expense');
  expect(String(bill.lines[0].accountId)).toBe(String(expense._id));
});

test('rejecting a candidate requires an explicit new-operation decision', async () => {
  const vendor = await Vendor.create({ name: 'Native Merchant', type: 'supplier' });
  const expense = await account('530800');
  const draft = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-03-02', currency: 'SAR', rate: 1.1,
    lines: [{ description: 'Different purchase', amount: 55, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req, asDraft: true }));
  const { result } = await purchase({ confirmNewBill: true });
  expect(result.posted).toBe(1);
  expect((await SupplierBill.findById(draft._id)).status).toBe('draft');
  expect(await SupplierBill.countDocuments()).toBe(2);
});

const pdfTest = process.env.STAGE_BANK_PDF_DIR ? test : test.skip;
pdfTest.each([
  ['حساب الدولار البركه .pdf', 35, 57700, -61881.75],
  ['حساب ليره بنك الكويت التركي.pdf', 42, 893552.3, -809145.25],
  ['شركة المتحده كشف حساب.pdf', 7, 557, -14754.69],
  ['عماد  شركة وصل الختروش-43.pdf', 84, 88945.11, -98249.5],
  ['كرت البركه.pdf', 10, 69758.32, -199465.4],
  ['كشف_حساب_العميل_2026_aswaq_اسواق (T336) (3).pdf', 251, 16014, -15951.47],
  ['كويت ترك الكرت.pdf', 100, 1529965.84, -1529983.84],
])('actual PDF %s preserves its movement count and totals', async (name, count, incoming, outgoing) => {
  const fs = require('fs');
  const path = require('path');
  const parsed = await bank.parsePdf(fs.readFileSync(path.join(process.env.STAGE_BANK_PDF_DIR, name)));
  expect(parsed.rows).toHaveLength(count);
  const sum = keep => Math.round(parsed.rows.filter(keep).reduce((s, r) => s + r.amount, 0) * 100) / 100;
  expect(sum(r => r.amount > 0)).toBe(incoming);
  expect(sum(r => r.amount < 0)).toBe(outgoing);
});
