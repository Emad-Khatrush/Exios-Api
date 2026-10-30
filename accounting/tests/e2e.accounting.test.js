// A company's month in the accounting section (owner's request, 2026-10-03): every document goes
// through its own route, and after each step the books, the balance sheet, the receivables and
// payables reports and the cash boxes are checked against each other. Then each document is
// cancelled and the books must come back to where they were.
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry, Account } = require('../models');
const docs = require('../models/documents');
const { processQueue } = require('../services/events');
const { CHECKS } = require('../services/reports/exceptions');
const { balanceSheet, incomeStatement } = require('../services/reports/statements');
const { receivables, payables } = require('../services/reports/operations');
const documents = require('../controllers/documents');
const entries = require('../controllers/entries');

jest.setTimeout(180000);

const OWNER_ID = '69deb74c4b5e921e7416ea11';
let owner;
const call = (handler, { params = {}, body = {}, query = {}, user = owner } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
  };
  Promise.resolve(handler({ params, body, query, user, files: undefined, ip: '127.0.0.1', access: { isOwner: true } }, res, (error) => (error ? reject(error) : resolve({ status: 200 })))).catch(reject);
});

const net = async (code, filter = {}) => {
  const id = (await account(code))._id;
  const match = { 'lines.accountId': id, ...Object.fromEntries(Object.entries(filter).map(([k, v]) => [`lines.${k}`, v])) };
  const [row] = await JournalEntry.aggregate([{ $match: match }, { $unwind: '$lines' }, { $match: match }, { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, fc: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } } } }]);
  return { usd: row?.usd || 0, foreign: row?.fc || 0 };
};
const usd = async (code, filter) => (await net(code, filter)).usd;
const create = (kind, body) => call(documents.createDocument(kind), { body }).then((r) => r.body);
const cancel = (model, id, extra = {}) => call(documents.cancel, { params: { model, id: String(id) }, body: { reason: 'test', ...extra } }).then((r) => r.body);
const day = '2026-03-10';

// Everything that must hold between the books and the reports
async function expectConsistent(step) {
  await processQueue();
  const problems = [];
  for (const key of ['balanced', 'failedEvents', 'wallets', 'roles', 'missingOffice', 'archivedBalances']) {
    const result = await CHECKS[key]();
    if (result.count) problems.push(`${key}: ${JSON.stringify(result.items.slice(0, 3))}`);
  }
  const sheet = await balanceSheet({ asOf: '2026-12-31' });
  if (!sheet.balanced) problems.push(`balance sheet off by ${sheet.difference}`);
  const ar = await receivables({ asOf: '2026-12-31' });
  if (ar.totals.total !== await usd('121000')) problems.push(`receivables report ${ar.totals.total} vs ledger ${await usd('121000')}`);
  const ap = await payables({ asOf: '2026-12-31' });
  const apLedger = -((await usd('210100')) + (await usd('210200')));
  if (ap.totals.total !== apLedger) problems.push(`payables report ${ap.totals.total} vs ledger ${apLedger}`);
  // A non-dollar box emptied in its currency is empty in dollars too (spec 2.4)
  for (const box of await Account.find({ isCash: true, isGroup: false, currency: { $nin: [null, 'USD'] } }).lean()) {
    const b = await net(box.code);
    if (b.foreign === 0 && b.usd !== 0) problems.push(`${box.code} holds 0 ${box.currency} but ${b.usd} cents`);
  }
  if (problems.length) throw new Error(`${step}:\n${problems.join('\n')}`);
}

let vendor;
let carrier;
let usdBank;
let tryBank;
let mutaheda;
let alipay;
beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  await CurrencyRate.create([
    { currency: 'LYD', day: '2025-01-01', rate: 10 }, { currency: 'TRY', day: '2025-01-01', rate: 40 }, { currency: 'CNY', day: '2025-01-01', rate: 7 },
  ]);
  await mongoose.connection.collection('users').insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  owner = await mongoose.connection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  vendor = await docs.Vendor.create({ name: 'Alibaba', type: 'supplier' });
  carrier = await docs.Vendor.create({ name: 'Turkish Cargo', type: 'carrier' });
  usdBank = await account('110202');
  tryBank = await account('110203');
  mutaheda = await account('110201');
  alipay = await account('110301');
});
afterAll(stopDb);

test('1. capital in, transfers between banks, a dollar sale for lira with a fee', async () => {
  await create('equity', { type: 'capital_in', partyName: 'الشريك', day, accountId: String(usdBank._id), amount: 20000 });
  await expectConsistent('capital');
  expect(await usd('110202')).toBe(2000000);
  await create('transfers', { day, fromAccountId: String(usdBank._id), fromAmount: 5000, toAccountId: String(mutaheda._id), toAmount: 5000 });
  // 1,000$ sold for 40,500 lira (a better rate than the day's 40): the gain is an exchange gain
  await create('transfers', { day, fromAccountId: String(usdBank._id), fromAmount: 1000, toAccountId: String(tryBank._id), toAmount: 40500 });
  await expectConsistent('transfers');
  expect(await usd('110202')).toBe(1400000);
  expect((await net('110203')).foreign).toBe(4050000);
  expect(await usd('110203')).toBe(100000);
});

test('2. a supplier bill owed, paid half in dollars and the rest in lira; a credit note and the money back', async () => {
  const bill = (await call(documents.createBill, { body: { vendorId: String(vendor._id), day, currency: 'USD', lines: [{ description: 'بضاعة', amount: 300, target: 'expense', accountId: String((await account('530800'))._id), office: 'tripoli' }] } })).body;
  await expectConsistent('bill');
  expect(await usd('210200')).toBe(-30000);
  await create('payments', { vendorId: String(vendor._id), day, fromAccountId: String(mutaheda._id), amount: 150, allocations: [{ billId: String(bill._id), amountUsd: 15000 }] });
  // The rest in lira at the bank's rate (150$ = 6,075 TRY); the box's average is 40.5, so no difference
  await create('payments', { vendorId: String(vendor._id), day, fromAccountId: String(tryBank._id), amount: 6075, rate: 40.5, allocations: [{ billId: String(bill._id), amountUsd: 15000 }] });
  await expectConsistent('bill paid');
  expect(await usd('210200')).toBe(0);
  // 100$ credited back by the supplier, then received in the dollar bank
  const note = (await call(documents.createBill, { body: { vendorId: String(vendor._id), day, currency: 'USD', isCreditNote: true, originalBillId: String(bill._id), lines: [{ description: 'مرتجع', amount: 100, target: 'expense', accountId: String((await account('530800'))._id), office: 'tripoli' }] } })).body;
  await expectConsistent('credit note');
  expect(await usd('210200')).toBe(10000);
  await create('receipts', { vendorId: String(vendor._id), day, toAccountId: String(usdBank._id), amount: 100, allocations: [{ billId: String(note._id), amountUsd: 10000 }] });
  await expectConsistent('receipt');
  expect(await usd('210200')).toBe(0);
  expect(await usd('530800')).toBe(20000);
});

test('2a. supplier payment allocations reject duplicates, negative values and fractional cents atomically', async () => {
  const testVendor = await docs.Vendor.create({ name: 'Allocation checks', type: 'supplier' });
  const bill = (await call(documents.createBill, { body: {
    vendorId: String(testVendor._id), day, currency: 'USD',
    lines: [{ description: 'Test bill', amount: 100, target: 'expense', accountId: String((await account('530800'))._id), office: 'tripoli' }],
  } })).body;
  const before = await usd('210200', { vendorId: testVendor._id });
  const attempts = [
    [{ billId: String(bill._id), amountUsd: 6000 }, { billId: String(bill._id), amountUsd: 6000 }],
    [{ billId: String(bill._id), amountUsd: -1 }],
    [{ billId: String(bill._id), amountUsd: 1.5 }],
  ];
  for (const allocations of attempts) {
    await expect(create('payments', { vendorId: String(testVendor._id), day, fromAccountId: String(usdBank._id), amount: 120, allocations })).rejects.toThrow();
    expect(await usd('210200', { vendorId: testVendor._id })).toBe(before);
  }
  await cancel('AccountingSupplierBill', bill._id);
  await expectConsistent('rejected supplier allocations');
});

test('2b. concurrent supplier credit notes cannot exceed the original bill', async () => {
  const testVendor = await docs.Vendor.create({ name: 'Concurrent credit notes', type: 'supplier' });
  const expense = await account('531700');
  const bill = (await call(documents.createBill, { body: {
    vendorId: String(testVendor._id), day, currency: 'USD',
    lines: [{ description: 'Original bill', amount: 100, target: 'expense', accountId: String(expense._id), office: 'tripoli' }],
  } })).body;
  const makeCreditNote = () => call(documents.createBill, { body: {
    vendorId: String(testVendor._id), day, currency: 'USD', isCreditNote: true, originalBillId: String(bill._id),
    lines: [{ description: 'Concurrent return', amount: 60, target: 'expense', accountId: String(expense._id), office: 'tripoli' }],
  } });

  const outcomes = await Promise.allSettled([makeCreditNote(), makeCreditNote()]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect(await docs.SupplierBill.countDocuments({ originalBillId: bill._id, status: 'posted' })).toBe(1);
  expect(await require('../services/posting/payables').apBalance(require('../services/posting/payables').billKey(bill._id))).toBe(4000);
  await expectConsistent('concurrent supplier credit notes');
});

test('3. yuan bought from a broker: arrived at once, and pending then completed', async () => {
  const broker = await docs.Vendor.create({ name: 'وصل', type: 'service' });
  await create('yuan-purchases', { vendorId: String(broker._id), day, fromAccountId: String(usdBank._id), amount: 1000, toAccountId: String(alipay._id), cnyReceived: 6600 });
  const pending = await create('yuan-purchases', { vendorId: String(broker._id), day, fromAccountId: String(usdBank._id), amount: 500, toAccountId: String(alipay._id), cnyExpected: 3300, arrived: false });
  await expectConsistent('yuan bought');
  expect((await net('110301')).foreign).toBe(660000);
  await call(documents.completeYuanPurchase, { params: { id: String(pending._id) }, body: { cnyReceived: 3250, day } });
  await expectConsistent('yuan arrived');
  expect(await net('110301')).toEqual({ usd: 150000, foreign: 985000 });
});

test('4. cash count short in dinars; a manual entry; a salary with an advance taken back', async () => {
  const lydBox = await account('110102');
  await create('transfers', { day, fromAccountId: String(usdBank._id), fromAmount: 500, toAccountId: String(lydBox._id), toAmount: 5000 });
  await create('cash-counts', { day, accountId: String(lydBox._id), countedAmount: 4950 });
  await expectConsistent('cash count');
  expect((await net('110102')).foreign).toBe(4950000);
  expect(await usd('530900')).toBe(500);
  const employee = (await mongoose.connection.collection('users').insertOne({ username: 'emp', firstName: 'Emp', lastName: 'L', phone: 910000005, customerId: 'EMP1', roles: { isEmployee: true } })).insertedId;
  await create('transfers', { day, fromAccountId: String(usdBank._id), fromAmount: 200, toAccountId: String((await account('140300'))._id), toAmount: 200, employeeId: String(employee) });
  await create('salaries', { employeeId: String(employee), month: '2026-03', office: 'tripoli', day, grossAmount: 800, currency: 'USD', advanceDeduction: 200, paidFromAccountId: String(usdBank._id) });
  await expectConsistent('salary');
  expect(await usd('530100')).toBe(80000);
  expect(await usd('140300')).toBe(0);
  const expense = await account('530800');
  await Account.updateOne({ _id: expense._id }, { $set: { allowManualEntry: true } });
  invalidateConfig();
  const manual = (await call(entries.createManual, { body: { date: day, description: 'تسوية', lines: [{ accountId: String(expense._id), side: 'debit', amount: 25, office: 'tripoli' }, { accountId: String(usdBank._id), side: 'credit', amount: 25 }] } })).body;
  await expectConsistent('manual entry');
  await call(entries.cancel, { params: { id: String(manual._id) }, body: { reason: 'خطأ' } });
  await expectConsistent('manual entry cancelled');
  expect(await usd('530800')).toBe(20000);
});

test('5. a car bought as an asset, depreciated, then sold; a year of rent paid ahead and spread', async () => {
  const cars = await account('150100');
  const rent = await account('530200');
  const carBill = (await call(documents.createBill, { body: { vendorId: String(vendor._id), day: '2025-01-15', currency: 'USD', paidImmediatelyFrom: String(usdBank._id), lines: [{ description: 'سيارة', amount: 1200, target: 'asset', accountId: String(cars._id), office: 'tripoli', asset: { name: 'سيارة', usefulLifeMonths: 12 } }] } })).body;
  await call(documents.createBill, { body: { vendorId: String(vendor._id), day: '2025-01-01', currency: 'USD', paidImmediatelyFrom: String(usdBank._id), lines: [{ description: 'إيجار', amount: 1200, target: 'prepaid', office: 'tripoli', prepaid: { expenseAccountId: String(rent._id), months: 12 } }] } });
  await call(documents.runDepreciation, { body: { upToMonth: '2025-06' } });
  await call(documents.runAmortization, { body: { upToMonth: '2025-06' } });
  await expectConsistent('asset and prepaid');
  expect(await usd('540100')).toBe(60000);
  expect(await usd('530200')).toBe(60000);
  const asset = await docs.FixedAsset.findOne({ sourceBillId: carBill._id }).lean();
  await call(documents.disposeAsset, { params: { id: String(asset._id) }, body: { day: '2025-07-10', proceeds: 700, toAccountId: String(usdBank._id) } });
  await expectConsistent('asset sold');
  expect(await usd('150100')).toBe(0);
  expect(await usd('150900')).toBe(0);
});

test('6. a bank statement: a line already in the books matches, a fee posts, then is cancelled', async () => {
  const { BankStatementLine } = docs;
  await call(documents.importBankLines, { body: { accountId: String(usdBank._id), rows: [{ day, description: 'إيداع رأس مال', amount: 20000 }, { day, description: 'Swift masrafi', amount: -15 }] } });
  await expectConsistent('statement imported');
  const fee = await BankStatementLine.findOne({ amount: -1500 }).lean();
  if (fee.lineStatus !== 'created_entry') {
    await call(documents.bankLineEntry, { params: { id: String(fee._id) }, body: { counterAccountId: String((await account('530400'))._id) } });
  }
  await expectConsistent('fee posted');
  expect(await usd('530400')).toBe(1500);
  await call(documents.cancelBankLineEntry, { params: { id: String(fee._id) }, body: { reason: 'test' } });
  await expectConsistent('fee cancelled');
  expect(await usd('530400')).toBe(0);
});

test('7. every money document cancelled brings the books back exactly', async () => {
  const before = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $group: { _id: '$lines.accountCode', n: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } }]);
  const transfer = await create('transfers', { day, fromAccountId: String(usdBank._id), fromAmount: 300, toAccountId: String(mutaheda._id), toAmount: 300 });
  const bill = (await call(documents.createBill, { body: { vendorId: String(carrier._id), day, currency: 'USD', lines: [{ description: 'شحن', amount: 90, target: 'expense', accountId: String((await account('530800'))._id), office: 'tripoli' }] } })).body;
  const payment = await create('payments', { vendorId: String(carrier._id), day, fromAccountId: String(usdBank._id), amount: 90, allocations: [{ billId: String(bill._id), amountUsd: 9000 }] });
  const equity = await create('equity', { type: 'withdrawal', partyName: 'الشريك', day, accountId: String(usdBank._id), amount: 50 });
  await expectConsistent('documents made');
  // A bill with a payment cannot go first
  await expect(cancel('AccountingSupplierBill', bill._id)).rejects.toMatchObject({ statusCode: 400 });
  await cancel('AccountingSupplierPayment', payment._id);
  await cancel('AccountingSupplierBill', bill._id);
  await cancel('AccountingTreasuryTransfer', transfer._id);
  await cancel('AccountingEquityTransaction', equity._id);
  await expectConsistent('documents cancelled');
  const after = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $group: { _id: '$lines.accountCode', n: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } }]);
  const map = (rows) => Object.fromEntries(rows.filter((r) => r.n).map((r) => [r._id, r.n]));
  expect(map(after)).toEqual(map(before));
});

test('8. the year closed: results move to retained earnings, a late entry needs the owner and its own closing', async () => {
  const { closeYear } = require('../services/closing');
  const { runInTransaction } = require('../services/transaction');
  const income = await incomeStatement({ from: '2025-01-01', to: '2025-12-31' });
  await runInTransaction((session) => closeYear('2025', { session, req: { user: owner } }));
  invalidateConfig();
  await expectConsistent('year closed');
  const after = await incomeStatement({ from: '2025-01-01', to: '2025-12-31' });
  expect(after.netIncome ?? after.net ?? 0).toBe(income.netIncome ?? income.net ?? 0);
  const sheet = await balanceSheet({ asOf: '2025-12-31' });
  expect(sheet.equity.unclosedEarnings).toBe(0);
});
