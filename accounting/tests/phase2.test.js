const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { JournalEntry, CurrencyRate } = require('../models');
const { Vendor, SupplierBill, SupplierPayment, FixedAsset } = require('../models/documents');
const payables = require('../services/posting/payables');
const treasury = require('../services/posting/treasury');
const schedules = require('../services/posting/schedules');
const people = require('../services/posting/people');
const bank = require('../services/posting/bank');
const { cancelDocument } = require('../services/cancel');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Wallet = require('../../models/wallet');
const UserStatement = require('../../models/userStatement');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const req = { user: { _id: oid() } };
const balanceOf = async (code, filter = {}) => getBalance((await account(code))._id, filter);
const newVendor = (type = 'supplier', name = 'مورد') => Vendor.create({ name, type });
const insertOrder = async () => (await Order.collection.insertOne({ orderId: `O${Date.now()}${Math.random()}`, placedAt: 'tripoli' })).insertedId;
const insertTrip = async (inventoryType = 'inventoryGoods') => (await Inventory.collection.insertOne({ voyage: 'V1', inventoryType, inventoryPlace: 'tripoli', shippingType: 'air' })).insertedId;
const rate = (currency, day, value) => CurrencyRate.create({ currency, day, rate: value });

// Opening money in a cash account through a capital deposit
const fund = (code, amount, rateValue) => tx(async (session) => people.createEquity({
  type: 'capital_in', partyName: 'الشريك', day: '2026-01-01', accountId: (await account(code))._id, amount, rate: rateValue,
}, { session, req }));

beforeEach(() => resetDb());

test('scenario 9: Alipay top-up keeps its cost rate and a vendor payment uses it', async () => {
  await fund('110201', 10000);
  const vendor = await newVendor();
  const bank110 = await account('110201');
  const alipay = await account('110301');
  await tx((session) => treasury.createTransfer({ day: '2026-02-01', fromAccountId: bank110._id, fromAmount: 10000, toAccountId: alipay._id, toAmount: 71000 }, { session, req }));
  expect(await balanceOf('110301')).toEqual({ usd: 1000000, foreign: 7100000 });

  const payment = await tx((session) => payables.createPayment({ vendorId: vendor._id, day: '2026-02-02', fromAccountId: alipay._id, amount: 7100, rate: 7.3 }, { session, req }));
  const entry = await JournalEntry.findById(payment.entryId);
  const alipayLine = entry.lines.find((l) => String(l.accountId) === String(alipay._id));
  expect(alipayLine.credit).toBe(100000); // 1,000$ at the carrying rate 7.1, not the day's 7.3
  expect(entry.lines.find((l) => l.apKey === `ADV:${vendor._id}`).debit).toBe(97260); // advance at the payment rate
  expect(entry.lines.find((l) => l.accountCode === '710100').debit).toBe(2740);
});

test('scenario 6: purchase costs from a CNY bill paid by Alipay plus a USD charge sit on the order', async () => {
  await fund('110201', 1000);
  const orderId = await insertOrder();
  const vendor = await newVendor();
  const alipay = await account('110301');
  await tx(async (session) => treasury.createTransfer({ day: '2026-02-01', fromAccountId: (await account('110201'))._id, fromAmount: 400, toAccountId: alipay._id, toAmount: 2800 }, { session, req }));

  await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-03', currency: 'CNY', rate: 7, paidImmediatelyFrom: alipay._id,
    lines: [{ description: 'بضاعة', amount: 2800, target: 'order', orderId }],
  }, { session, req }));
  await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-04', currency: 'USD',
    lines: [{ description: 'شحن داخلي في الصين', amount: 30, target: 'order', orderId }],
  }, { session, req }));

  const wip = await account('130200');
  const [row] = await JournalEntry.aggregate([
    { $unwind: '$lines' }, { $match: { 'lines.accountId': wip._id, 'lines.orderId': orderId } },
    { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  expect(row.usd).toBe(43000);
  expect((await balanceOf('110301')).foreign).toBe(0);
  expect((await balanceOf('110301')).usd).toBe(0);
  const bill = await SupplierBill.findOne({ currency: 'CNY' });
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(0);
});

test('trip costs: refused on a warehouse, posted on a trip', async () => {
  const vendor = await newVendor('carrier');
  const warehouse = await insertTrip('warehouseInventory');
  await expect(tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [{ description: 'x', amount: 10, target: 'trip', tripId: warehouse }],
  }, { session, req }))).rejects.toThrow('مخزن');

  const trip = await insertTrip();
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [{ description: 'شحن جوي', amount: 3000, target: 'trip', tripId: trip }],
  }, { session, req }));
  const entry = await JournalEntry.findById(bill.entryId);
  expect(entry.lines.find((l) => l.accountCode === '130100')).toMatchObject({ debit: 300000, office: 'tripoli' });
  expect(entry.lines.find((l) => l.accountCode === '210100').credit).toBe(300000);
});

test('quick expense in dinars is a bill to the cash-expenses vendor, paid on the spot', async () => {
  await rate('LYD', '2026-03-01', 9);
  await fund('110102', 9000, 9);
  const cashVendor = await Vendor.findOne({ seedKey: 'cash_expenses' });
  const rent = await account('530200');
  const bill = await tx(async (session) => payables.createBill({
    vendorId: cashVendor._id, day: '2026-03-05', currency: 'LYD', isQuickExpense: true, paidImmediatelyFrom: (await account('110102'))._id,
    lines: [{ description: 'إيجار مارس', amount: 4500, target: 'expense', accountId: rent._id, office: 'tripoli' }],
  }, { session, req }));
  expect(bill.number).toBe('BILL/2026/0001');
  expect((await balanceOf('530200')).usd).toBe(50000);
  expect(await balanceOf('110102')).toEqual({ usd: 50000, foreign: 4500000 });
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(0);
});

test('scenario 10: cash count shortage goes to cash over/short', async () => {
  await fund('110102', 5000, 10);
  const count = await tx(async (session) => treasury.createCashCount({ day: '2026-03-01', accountId: (await account('110102'))._id, countedAmount: 4950 }, { session, req }));
  expect(count.difference).toBe(-50000);
  expect((await balanceOf('530900')).usd).toBe(500);
  expect((await balanceOf('110102')).foreign).toBe(4950000);
});

test('scenario 13: depreciation catches up month by month, then a sale books the gain', async () => {
  await fund('110101', 20000);
  const vendor = await newVendor();
  const cars = await account('150100');
  const bill = await tx(async (session) => payables.createBill({
    vendorId: vendor._id, day: '2024-01-10', currency: 'USD', paidImmediatelyFrom: (await account('110101'))._id,
    lines: [{ description: 'سيارة', amount: 12000, target: 'asset', accountId: cars._id, office: 'tripoli', asset: { name: 'سيارة توصيل', usefulLifeMonths: 60 } }],
  }, { session, req }));
  const result = await tx((session) => schedules.runDepreciation({ upToMonth: '2025-01', session }));
  expect(result.posted).toBe(13);
  // running again posts nothing new
  expect((await tx((session) => schedules.runDepreciation({ upToMonth: '2025-01', session }))).posted).toBe(0);

  const asset = await FixedAsset.findOne({ sourceBillId: bill._id });
  await tx(async (session) => schedules.disposeAsset(asset._id, { day: '2025-02-20', proceeds: 9500, toAccountId: (await account('110101'))._id }, { session, req }));
  const after = await FixedAsset.findById(asset._id);
  expect(after.depreciationPosted).toHaveLength(14);
  expect(after.depreciationPosted.reduce((s, d) => s + d.amount, 0)).toBe(280000);
  expect((await balanceOf('540200')).usd).toBe(-30000); // 300$ gain (credit)
  expect((await balanceOf('150100')).usd).toBe(0);
  expect((await balanceOf('150900')).usd).toBe(0);

  // the bill cannot be cancelled while the asset has depreciation
  await expect(tx((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: 'x' }))).rejects.toThrow('الأصل');
});

test('scenario 14: prepaid rent spreads over 12 months and ends at zero', async () => {
  await fund('110101', 10000);
  const vendor = await newVendor();
  const rent = await account('530200');
  await tx(async (session) => payables.createBill({
    vendorId: vendor._id, day: '2025-01-05', currency: 'USD', paidImmediatelyFrom: (await account('110101'))._id,
    lines: [{ description: 'إيجار سنة', amount: 6000, target: 'prepaid', office: 'tripoli', prepaid: { expenseAccountId: rent._id, months: 12 } }],
  }, { session, req }));
  expect((await balanceOf('140200')).usd).toBe(600000);
  const run = await tx((session) => schedules.runPrepaidAmortization({ upToMonth: '2026-06', session }));
  expect(run.posted).toBe(12);
  expect((await balanceOf('140200')).usd).toBe(0);
  expect((await balanceOf('530200')).usd).toBe(600000);
});

test('scenario 15: salary with an advance deducted', async () => {
  await fund('110101', 5000);
  const employeeId = (await mongoose.connection.collection('users').insertOne({ firstName: 'موظف', lastName: 'أ', roles: { isEmployee: true } })).insertedId;
  const cash = await account('110101');
  const advances = await account('140300');
  await tx((session) => treasury.createTransfer({ day: '2026-03-01', fromAccountId: cash._id, fromAmount: 200, toAccountId: advances._id, toAmount: 200, employeeId }, { session, req }));
  expect((await balanceOf('140300', { })).usd).toBe(20000);

  await tx((session) => people.createSalary({
    employeeId, month: '2026-03', day: '2026-03-31', office: 'tripoli', paidFromAccountId: cash._id, grossAmount: 800, advanceDeduction: 200,
  }, { session, req }));
  expect((await balanceOf('530100')).usd).toBe(80000);
  expect((await balanceOf('140300')).usd).toBe(0);
  expect((await balanceOf('110101')).usd).toBe(500000 - 20000 - 60000);
});

test('netting to the wallet adds a statement line and wallet money, and its cancel takes it back', async () => {
  await rate('LYD', '2026-03-01', 9);
  const customerId = (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: 'ب' })).insertedId;
  const vendor = await newVendor('service', 'شريك');
  const expense = await account('530800');
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-03-01', currency: 'USD', lines: [{ description: 'خدمة', amount: 1000, target: 'expense', accountId: expense._id, office: 'tripoli' }],
  }, { session, req }));
  const netting = await tx((session) => people.createNetting({
    vendorId: vendor._id, customerId, day: '2026-03-02', mode: 'payable_to_wallet', billId: bill._id, walletCurrency: 'LYD', amountUsd: 10000,
  }, { session, req }));
  expect((await Wallet.findOne({ user: customerId, currency: 'LYD' })).balance).toBe(900);
  const statement = await UserStatement.findById(netting.userStatementId);
  expect(statement.accountingSource.model).toBe('AccountingNetting');
  expect(await getBalance((await account('220200'))._id, { partnerId: customerId })).toEqual({ usd: -10000, foreign: -900000 });
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(90000);

  await tx((session) => cancelDocument('AccountingNetting', netting._id, { session, req, reason: 'خطأ' }));
  expect((await Wallet.findOne({ user: customerId, currency: 'LYD' })).balance).toBe(0);
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(100000);
});

test('scenario 16 (claim): netting pays the partner\'s shipping claim', async () => {
  const customerId = (await mongoose.connection.collection('users').insertOne({ firstName: 'شريك', lastName: 'ج' })).insertedId;
  const vendor = await newVendor('service', 'شريك');
  const expense = await account('530800');
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-03-01', currency: 'USD', lines: [{ description: 'خدمة', amount: 1000, target: 'expense', accountId: expense._id, office: 'tripoli' }],
  }, { session, req }));
  const arKey = `SHP:${oid()}:${oid()}`;
  await post({
    eventType: 'SHIPMENT_BILLED', eventKey: `TEST:${arKey}`, date: '2026-03-01',
    lines: [{ role: 'customer_receivable', debit: 40000, partnerId: customerId, arKey }, { role: 'deferred_shipping_revenue', credit: 40000, packageId: oid() }],
  });
  await tx((session) => people.createNetting({ vendorId: vendor._id, customerId, day: '2026-03-02', mode: 'payable_to_ar', billId: bill._id, arKey, amountUsd: 40000 }, { session, req }));
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(60000);
  expect((await balanceOf('121000', { partnerId: customerId })).usd).toBe(0);
});

test('concurrent nettings cannot exceed the open supplier bill', async () => {
  const customerId = (await mongoose.connection.collection('users').insertOne({ firstName: 'Client', lastName: 'Test' })).insertedId;
  const vendor = await newVendor('service', 'Partner');
  const expense = await account('530800');
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-03-01', currency: 'USD', lines: [{ description: 'Service', amount: 1000, target: 'expense', accountId: expense._id, office: 'tripoli' }],
  }, { session, req }));
  const outcomes = await Promise.allSettled([1, 2].map((n) => tx((session) => people.createNetting({
    vendorId: vendor._id, customerId, day: '2026-03-02', mode: 'payable_to_wallet', billId: bill._id,
    walletCurrency: 'USD', amountUsd: 75000, idempotencyKey: `NETTING-RACE-${n}`,
  }, { session, req }))));
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(25000);
  expect((await Wallet.findOne({ user: customerId, currency: 'USD' })).balance).toBe(750);
});

test('concurrent nettings cannot exceed the open customer claim across separate supplier bills', async () => {
  const customerId = (await mongoose.connection.collection('users').insertOne({ firstName: 'Client', lastName: 'Claim' })).insertedId;
  const vendor = await newVendor('service', 'Partner');
  const expense = await account('530800');
  // Two separate bills, more than a week apart (the same vendor, amount and week would be one cost twice)
  const createBill = (day) => tx((session) => payables.createBill({
    vendorId: vendor._id, day, currency: 'USD', lines: [{ description: 'Service', amount: 1000, target: 'expense', accountId: expense._id, office: 'tripoli' }],
  }, { session, req }));
  const bills = await Promise.all([createBill('2026-03-01'), createBill('2026-03-12')]);
  const arKey = `NETTING-CLAIM-${oid()}`;
  await post({
    eventType: 'TEST_NETTING_CLAIM', eventKey: `TEST:${arKey}`, date: '2026-03-01',
    lines: [{ role: 'customer_receivable', debit: 10000, partnerId: customerId, arKey }, { role: 'deferred_shipping_revenue', credit: 10000, packageId: oid() }],
  });
  const outcomes = await Promise.allSettled(bills.map((bill, index) => tx((session) => people.createNetting({
    vendorId: vendor._id, customerId, day: '2026-03-02', mode: 'payable_to_ar', billId: bill._id,
    arKey, amountUsd: 7500, idempotencyKey: `NETTING-CLAIM-RACE-${index}`,
  }, { session, req }))));
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await balanceOf('121000', { partnerId: customerId })).usd).toBe(2500);
});

test('salary requires an employee user, and company loan repayments cannot exceed the liability', async () => {
  const customerId = (await mongoose.connection.collection('users').insertOne({ firstName: 'Customer', lastName: 'Only' })).insertedId;
  const cash = await account('110101');
  await expect(tx((session) => people.createSalary({
    employeeId: customerId, month: '2026-03', day: '2026-03-31', office: 'tripoli', paidFromAccountId: cash._id, grossAmount: 500,
  }, { session, req }))).rejects.toThrow('employee');

  await fund('110101', 5000);
  await tx((session) => people.createEquity({ type: 'loan_in', partyName: 'Lender A', day: '2026-03-01', accountId: cash._id, amount: 1000 }, { session, req }));
  await expect(tx((session) => people.createEquity({ type: 'loan_repayment', partyName: 'Lender A', day: '2026-03-02', accountId: cash._id, amount: 1001 }, { session, req }))).rejects.toThrow('exceeds the outstanding loan balance');
  expect((await balanceOf('230100')).usd).toBe(-100000);
  await tx((session) => people.createEquity({ type: 'loan_repayment', partyName: 'Lender A', day: '2026-03-03', accountId: cash._id, amount: 1000 }, { session, req }));
  expect((await balanceOf('230100')).usd).toBe(0);

  await tx((session) => people.createEquity({ type: 'loan_in', partyName: 'Lender A', day: '2026-03-04', accountId: cash._id, amount: 1000 }, { session, req }));
  const repayments = await Promise.allSettled([1, 2].map((n) => tx((session) => people.createEquity({
    type: 'loan_repayment', partyName: 'Lender A', day: '2026-03-05', accountId: cash._id, amount: 750, idempotencyKey: `LOAN-REPAY-RACE-${n}`,
  }, { session, req }))));
  expect(repayments.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(repayments.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await balanceOf('230100')).usd).toBe(-25000);

  const loan = await tx((session) => people.createEquity({ type: 'loan_in', partyName: 'Lender B', day: '2026-03-06', accountId: cash._id, amount: 1000 }, { session, req }));
  const repayment = await tx((session) => people.createEquity({ type: 'loan_repayment', partyName: 'Lender B', day: '2026-03-07', accountId: cash._id, amount: 500 }, { session, req }));
  await expect(tx((session) => cancelDocument('AccountingEquityTransaction', loan._id, { session, req, reason: 'incorrect loan' }))).rejects.toThrow('Cancel repayments');
  await tx((session) => cancelDocument('AccountingEquityTransaction', repayment._id, { session, req, reason: 'incorrect repayment' }));
  await tx((session) => cancelDocument('AccountingEquityTransaction', loan._id, { session, req, reason: 'incorrect loan' }));
  expect((await balanceOf('230100')).usd).toBe(-25000);
});

test('scenario 17: bank statement import, auto-match and a fee entry', async () => {
  await fund('110201', 5000);
  const bank110 = await account('110201');
  const cash = await account('110101');
  await tx((session) => treasury.createTransfer({ day: '2026-04-02', fromAccountId: bank110._id, fromAmount: 1000, toAccountId: cash._id, toAmount: 1000 }, { session, req }));

  // Import matches on its own what the books already hold
  const { matched, count } = await tx((session) => bank.importLines(bank110._id, [
    { day: '2026-01-01', description: 'إيداع رأس مال', amount: 5000 },
    { day: '2026-04-03', description: 'تحويل', amount: -1000 },
    { day: '2026-04-05', description: 'رسوم تحويل', amount: -15 },
  ], { session, req }));
  expect(count).toBe(3);
  expect(matched).toBe(2);

  const { BankStatementLine } = require('../models/documents');
  const fee = await BankStatementLine.findOne({ lineStatus: 'unmatched' });
  const fees = await account('530400');
  await tx((session) => bank.createEntryForLine(fee._id, { counterAccountId: fees._id, office: 'turkey' }, { session, req }));
  expect((await balanceOf('110201')).usd).toBe(400000 - 1500);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(0);
});

test('concurrent bank matches cannot claim one journal movement twice for the same account', async () => {
  await fund('110201', 1000);
  const bank110 = await account('110201');
  const expense = await account('530400');
  const entry = await post({
    eventType: 'TEST_BANK_MATCH', eventKey: 'TEST_BANK_MATCH_RACE', date: '2026-04-02', description: 'Bank fee',
    lines: [
      { accountId: expense._id, debit: 5000, office: 'tripoli' },
      { accountId: bank110._id, credit: 5000, currency: 'USD', amountCurrency: -5000 },
    ],
  });
  const { BankStatementLine } = require('../models/documents');
  const lines = await BankStatementLine.create([
    { accountId: bank110._id, day: '2026-04-02', description: 'Fee line A', amount: -5000 },
    { accountId: bank110._id, day: '2026-04-02', description: 'Fee line B', amount: -5000 },
  ]);
  const outcomes = await Promise.allSettled(lines.map((line) => tx((session) => bank.manualMatch(line._id, [entry._id], { session, req }))));
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await BankStatementLine.countDocuments({ accountId: bank110._id, lineStatus: 'matched' })).toBe(1);
  expect((await JournalEntry.findById(entry._id).lean()).bankMatchedAccounts.map(String)).toEqual([String(bank110._id)]);
  const matched = lines.find((_, index) => outcomes[index].status === 'fulfilled');
  await tx((session) => bank.setIgnored(matched._id, false, { session, req }));
  expect((await JournalEntry.findById(entry._id).lean()).bankMatchedAccounts).toHaveLength(0);
});

test('scenario 26: a bill with a payment cannot be cancelled until the payment is', async () => {
  await fund('110101', 5000);
  const vendor = await newVendor('carrier');
  const trip = await insertTrip();
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [{ description: 'شحن', amount: 3000, target: 'trip', tripId: trip }],
  }, { session, req }));
  const payment = await tx(async (session) => payables.createPayment({
    vendorId: vendor._id, day: '2026-02-05', fromAccountId: (await account('110101'))._id, amount: 3000, allocations: [{ billId: bill._id, amountUsd: 300000 }],
  }, { session, req }));

  await expect(tx((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: 'خطأ' }))).rejects.toThrow('الدفعات');
  await tx((session) => cancelDocument('AccountingSupplierPayment', payment._id, { session, req, reason: 'خطأ' }));
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(300000);
  await tx((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: 'خطأ' }));
  expect((await balanceOf('130100')).usd).toBe(0);
  expect((await SupplierBill.findById(bill._id)).status).toBe('canceled');
  expect((await balanceOf('110101')).usd).toBe(500000);
});

test('scenario 28: two cancels of the same document at once give one reversal', async () => {
  await fund('110101', 5000);
  const payment = await SupplierPayment.findOne();
  expect(payment).toBeNull();
  const transfer = await tx(async (session) => treasury.createTransfer({
    day: '2026-02-01', fromAccountId: (await account('110101'))._id, fromAmount: 100, toAccountId: (await account('110103'))._id, toAmount: 100,
  }, { session, req }));
  const results = await Promise.allSettled([1, 2].map(() => tx((session) => cancelDocument('AccountingTreasuryTransfer', transfer._id, { session, req, reason: 'x' }))));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await JournalEntry.countDocuments({ eventKey: new RegExp(`^CANCEL:AccountingTreasuryTransfer:${transfer._id}`) })).toBe(1);
  expect((await balanceOf('110103')).usd).toBe(0);
});

test('scenario 29: a draft bill has no entry, can be edited and deleted; once posted it cannot', async () => {
  const vendor = await newVendor();
  const expense = await account('530800');
  const line = { description: 'قرطاسية', amount: 50, target: 'expense', accountId: expense._id, office: 'tripoli' };
  const draft = await tx((session) => payables.createBill({ vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [line] }, { session, req, asDraft: true }));
  expect(draft.status).toBe('draft');
  expect(await JournalEntry.countDocuments()).toBe(0);
  await tx((session) => payables.updateDraftBill(draft._id, { lines: [{ ...line, amount: 60 }] }, { session, req }));
  const posted = await tx((session) => payables.postDraftBill(draft._id, { session, req }));
  expect(posted.totalUsd).toBe(6000);
  await expect(tx((session) => payables.deleteDraftBill(draft._id, { session, req }))).rejects.toThrow('المسودات');

  const other = await tx((session) => payables.createBill({ vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [line] }, { session, req, asDraft: true }));
  await tx((session) => payables.deleteDraftBill(other._id, { session, req }));
  expect(await SupplierBill.exists({ _id: other._id })).toBeNull();
});

test('a credit note reduces what is owed and the cost of the same target', async () => {
  const vendor = await newVendor('carrier');
  const trip = await insertTrip();
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-01', currency: 'USD', lines: [{ description: 'شحن', amount: 3000, target: 'trip', tripId: trip }],
  }, { session, req }));
  await tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-10', currency: 'USD', isCreditNote: true, originalBillId: bill._id,
    lines: [{ description: 'خصم', amount: 500, target: 'trip', tripId: trip }],
  }, { session, req }));
  expect(await payables.apBalance(`BILL:${bill._id}`)).toBe(250000);
  expect((await balanceOf('130100')).usd).toBe(250000);
  await expect(tx((session) => payables.createBill({
    vendorId: vendor._id, day: '2026-02-11', currency: 'USD', isCreditNote: true, originalBillId: bill._id,
    lines: [{ description: 'خصم', amount: 2600, target: 'trip', tripId: trip }],
  }, { session, req }))).rejects.toThrow('أكبر');
});

test('bank statements are never counted twice: a re-imported file, an entry typed by hand, and rules', async () => {
  await fund('110201', 5000);
  const bank110 = await account('110201');
  const fees = await account('530400');
  const { BankStatementLine } = require('../models/documents');
  const file = [
    { day: '2026-05-01', description: 'COMMISSION TRF 001', reference: 'R1', amount: -10 },
    { day: '2026-05-01', description: 'COMMISSION TRF 001', reference: 'R1', amount: -10 },
    { day: '2026-05-02', description: 'Rent May', amount: -300 },
  ];
  expect((await tx((session) => bank.importLines(bank110._id, file, { session, req }))).count).toBe(3);

  // The next statement overlaps the first one: only the new line is added
  const again = await tx((session) => bank.importLines(bank110._id, [...file, { day: '2026-05-03', description: 'COMMISSION TRF 002', amount: -10 }], { session, req }));
  expect(again).toMatchObject({ count: 1, skipped: 3 });

  // The rent was already typed by hand two days later: posting the line again is refused
  const rent = await account('530200');
  await post({ eventType: 'MANUAL', eventKey: 'RENT', date: '2026-05-04', description: 'إيجار', lines: [
    { accountId: rent._id, debit: 30000, office: 'turkey' },
    { accountId: bank110._id, credit: 30000, currency: 'USD', amountCurrency: -30000 },
  ] });
  const rentLine = await BankStatementLine.findOne({ description: 'Rent May' });
  await expect(tx((session) => bank.createEntryForLine(rentLine._id, { counterAccountId: rent._id, office: 'turkey' }, { session, req }))).rejects.toThrow('مسجلاً في الدفاتر');
  const suggestions = await bank.suggestions(bank110._id);
  expect(suggestions[rentLine._id].duplicates).toHaveLength(1);
  await tx((session) => bank.manualMatch(rentLine._id, [suggestions[rentLine._id].duplicates[0]._id], { session, req }));

  // One commission posted with remember: the others are suggested to the same account
  const [first] = await BankStatementLine.find({ description: /COMMISSION/, lineStatus: 'unmatched' }).sort({ day: 1 });
  await tx((session) => bank.createEntryForLine(first._id, { counterAccountId: fees._id, office: 'turkey', remember: true, keyword: 'commission' }, { session, req }));
  const next = await bank.suggestions(bank110._id);
  const left = await BankStatementLine.find({ description: /COMMISSION/, lineStatus: 'unmatched' });
  expect(left).toHaveLength(2);
  left.forEach((line) => expect(next[line._id]).toMatchObject({ source: 'rule', account: { code: '530400' } }));
});

test('concurrent imports of the same bank line create only one statement row and one journal entry', async () => {
  await fund('110201', 5000);
  const bank110 = await account('110201');
  const fees = await account('530400');
  const { BankStatementLine } = require('../models/documents');
  const row = { day: '2026-06-10', description: 'SWIFT FEE REPLAY', reference: 'RACE-1', amount: -10, counterAccountId: fees._id, office: 'turkey' };

  const outcomes = await Promise.all([
    tx((session) => bank.importLines(bank110._id, [row], { session, req })),
    tx((session) => bank.importLines(bank110._id, [row], { session, req })),
  ]);
  expect(outcomes.reduce((sum, result) => sum + result.count, 0)).toBe(1);
  expect(await BankStatementLine.countDocuments({ accountId: bank110._id, reference: 'RACE-1' })).toBe(1);
  expect(await SupplierBill.countDocuments({ status: 'posted' })).toBe(1);
  expect(await SupplierPayment.countDocuments({ status: 'posted' })).toBe(1);
  expect((await getBalance(fees._id)).usd).toBe(1000);
});

test('the table before importing: new, already imported, already in the books, and the account each goes to; then import posts it', async () => {
  await fund('110201', 5000);
  const bank110 = await account('110201');
  const fees = await account('530400');
  const rent = await account('530200');
  const { BankStatementLine } = require('../models/documents');
  await tx((session) => bank.saveRule({ keyword: 'commission', direction: 'out', counterAccountId: fees._id, office: 'turkey' }, { session, req }));
  await tx((session) => bank.importLines(bank110._id, [{ day: '2026-06-01', description: 'old line', amount: -1 }], { session, req }));
  await post({ eventType: 'MANUAL', eventKey: 'RENT-6', date: '2026-06-03', description: 'إيجار', lines: [
    { accountId: rent._id, debit: 30000, office: 'turkey' },
    { accountId: bank110._id, credit: 30000, currency: 'USD', amountCurrency: -30000 },
  ] });

  const rows = [
    { day: '2026-06-01', description: 'old line', amount: -1 },
    { day: '2026-06-02', description: 'Rent June', amount: -300 },
    { day: '2026-06-04', description: 'COMMISSION 22', amount: -7 },
    { day: '2026-06-05', description: 'Something new', amount: -12 },
  ];
  const table = await bank.classifyRows(bank110._id, rows);
  expect(table.map((r) => r.status)).toEqual(['imported', 'match', 'new', 'new']);
  expect(table[1].entry.number).toBeTruthy();
  // Al Mutaheda's own "Com" rule (seeded for 110201) wins over the one for all banks
  expect(table[2]).toMatchObject({ source: 'rule', account: { code: '530400' }, vendorName: bank110.name });
  expect(table[3].account).toBeNull();

  // Confirmed: the commission goes to its account, the new line gets the one chosen in the table
  const result = await tx((session) => bank.importLines(bank110._id, [
    rows[0], rows[1],
    { ...rows[2], counterAccountId: fees._id, office: 'turkey' },
    { ...rows[3], counterAccountId: fees._id, office: 'turkey' },
  ], { session, req }));
  expect(result).toMatchObject({ count: 3, skipped: 1, matched: 1, posted: 2, notPosted: [] });
  expect(await BankStatementLine.countDocuments({ accountId: bank110._id, lineStatus: 'created_entry' })).toBe(2);
});

test('a card line is linked to the purchase cost typed on its order; the bank paying the card is a transfer', async () => {
  const { Account } = require('../models');
  const { BankStatementLine } = require('../models/documents');
  await rate('TRY', '2026-01-01', 40);
  const card = await account('250100');
  const cost = await account('510400');
  // The Kuveyt Türk current account in lira (the owner's 110204, seeded with its rules)
  const current = await Account.findOne({ code: '110204' });
  await tx((session) => people.createEquity({ type: 'capital_in', partyName: 'الشريك', day: '2026-07-01', accountId: current._id, amount: 100000, rate: 40 }, { session, req }));
  const orderId = await insertOrder();
  const itemId = new mongoose.Types.ObjectId();
  await Order.updateOne({ _id: orderId }, { $set: { purchaseItems: [{ _id: itemId, date: new Date('2026-08-01'), description: 'Alibaba order', unitPrice: 107.73, currency: 'USD' }] } });

  const rows = [
    { day: '2026-08-01', description: 'Alibaba.com Luxembourg LUX (107.73 US Dollar)', amount: -5130.72 },
    { day: '2026-08-02', description: 'Alibaba.com Luxembourg LUX (30.90 US Dollar)', amount: -1471.63 },
    { day: '2026-08-03', description: 'Kredi Kartı Borç Ödeme', amount: 25000 },
  ];
  const table = await bank.classifyRows(card._id, rows);
  expect(table[0]).toMatchObject({ source: 'order', account: { code: '130200' }, link: { orderId, itemId, amount: 107.73, currency: 'USD' } });
  expect(table[1]).toMatchObject({ source: 'rule', account: { code: '510400' }, vendorName: 'Alibaba' });
  expect(table[2]).toMatchObject({ source: 'rule', account: { code: '110204' }, vendorName: null });

  // The order suggestion is not posted on import: it is reviewed and approved as a purchase match
  const result = await tx((session) => bank.importLines(card._id, rows.map((row, index) => (index === 0 ? row : {
    ...row, counterAccountId: table[index].account._id, vendorName: table[index].vendorName || undefined,
  })), { session, req }));
  expect(result).toMatchObject({ count: 3, posted: 2, notPosted: [] });
  const suggested = await BankStatementLine.findOne({ description: /107.73/ });
  await tx((session) => require('../services/posting/bankPurchaseReview').matchPurchase(suggested._id, { kind: 'order_item', orderId, itemId }, { session, req }));

  // Purchases are a bill in dollars (the dollars the line says were paid) and its payment in lira
  // at the rate of that payment; the transfer moved lira
  const { SupplierBill, SupplierPayment, Vendor } = require('../models/documents');
  const linked = await BankStatementLine.findOne({ purchaseItemId: itemId });
  expect(String(linked.orderId)).toBe(String(orderId));
  const linkedBill = await SupplierBill.findById(linked.billId);
  expect(linkedBill).toMatchObject({ currency: 'USD', totalUsd: 10773, status: 'posted' });
  expect(linkedBill.lines[0]).toMatchObject({ target: 'order' });
  const onOrder = await JournalEntry.findOne({ 'lines.orderId': orderId, eventType: 'BILL' });
  expect(onOrder.lines.find((l) => l.orderId).accountCode).toBe('130200');
  const other = await BankStatementLine.findOne({ description: /30\.90/ });
  const payment = await SupplierPayment.findById(other.paymentId);
  expect(payment).toMatchObject({ currency: 'TRY', amount: 1471.63, advanceUsd: 0 });
  expect(payment.rate).toBeCloseTo(1471.63 / 30.9, 6);
  expect(String(other.entryId)).toBe(String(payment.entryId));
  expect((await Vendor.findById(payment.vendorId)).name).toBe('Alibaba');
  expect((await balanceOf('510400')).usd).toBe(3090);

  // Cancelling the line cancels its payment and bill; it can be posted again
  await tx((session) => bank.cancelLineEntry(other._id, { session, req, reason: 'خطأ' }));
  expect((await SupplierBill.findById(other.billId)).status).toBe('canceled');
  expect((await SupplierPayment.findById(other.paymentId)).status).toBe('canceled');
  expect((await balanceOf('510400')).usd).toBe(0);
  await tx((session) => bank.createEntryForLine(other._id, { counterAccountId: cost._id, vendorName: 'Alibaba', confirmNotDuplicate: true }, { session, req }));
  expect((await balanceOf('510400')).usd).toBe(3090);
  expect((await getBalance(current._id)).foreign).toBe(10000000 - 2500000);
  expect((await getBalance(card._id)).foreign).toBe(2500000 - 513072 - 147163);

  // The same purchase cost is not offered to a second line
  const again = await bank.classifyRows(card._id, [{ day: '2026-08-05', description: 'Alibaba.com Luxembourg LUX (107.73 US Dollar)', amount: -5130.72 }]);
  expect(again[0].source).toBe('rule');
});

test("Al Mutaheda: money sent is a supplier's service bill; money received matches the customer's wallet deposit", async () => {
  const { BankStatementLine } = require('../models/documents');
  const operations = require('../services/posting/operations');
  await fund('110201', 5000);
  const mutaheda = await account('110201');
  const rows = [
    { day: '2026-09-28', description: '1414 // -1207', amount: -2000 },
    { day: '2026-09-29', description: '-1178  // -1414', amount: 557 },
  ];
  // Before the deposit is entered: the money received has no account and waits
  const table = await bank.classifyRows(mutaheda._id, rows);
  expect(table[0]).toMatchObject({ account: { code: '531700' }, vendorName: 'مورد خدمات - المتحدة 1207' });
  expect(table[1]).toMatchObject({ status: 'new', account: null });
  const result = await tx((session) => bank.importLines(mutaheda._id, rows.map((row, i) => ({
    ...row, ...(table[i].account ? { counterAccountId: table[i].account._id, vendorName: table[i].vendorName, office: 'turkey' } : {}),
  })), { session, req }));
  expect(result).toMatchObject({ posted: 1, notPosted: [] });
  const sent = await BankStatementLine.findOne({ description: /1207/ });
  expect((await SupplierBill.findById(sent.billId)).totalUsd).toBe(200000);
  expect((await balanceOf('531700')).usd).toBe(200000);

  // The employee enters the customer's deposit on Al Mutaheda: the line is matched to it
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', customerId: 'T1178' })).insertedId;
  const [statement] = await UserStatement.create([{
    user: customer, createdBy: oid(), description: 'إيداع عبر المتحدة', total: 0, paymentType: 'wallet', createdAt: new Date('2026-09-29T10:00:00Z'),
    amount: 557, currency: 'USD', calculationType: '+', actionType: 'cash', office: 'almutahidaTrBank',
  }]);
  await tx((session) => operations.postStatement(statement._id, { session }));
  expect((await bank.autoMatch(mutaheda._id, { req })).matched).toBe(1);
  const received = await BankStatementLine.findOne({ description: /1178/ });
  expect(received.lineStatus).toBe('matched');
  expect((await getBalance((await account('220100'))._id, { partnerId: customer })).usd).toBe(-55700);
});

test('a row ignored in the table is kept without posting; a line without an entry can be deleted', async () => {
  const { BankStatementLine } = require('../models/documents');
  await fund('110201', 5000);
  const mutaheda = await account('110201');
  const fees = await account('530400');
  const rows = [
    { day: '2026-09-10', description: 'Com 1414 // -1207', amount: -2, counterAccountId: fees._id, office: 'turkey', ignore: true },
    { day: '2026-09-11', description: 'wrong line', amount: -5 },
  ];
  const result = await tx((session) => bank.importLines(mutaheda._id, rows, { session, req }));
  expect(result).toMatchObject({ count: 2, posted: 0 });
  const ignored = await BankStatementLine.findOne({ description: /Com/ });
  expect(ignored.lineStatus).toBe('ignored');
  // Importing the same file again does not bring the ignored row back
  expect((await bank.classifyRows(mutaheda._id, [rows[0]]))[0].status).toBe('imported');

  const wrong = await BankStatementLine.findOne({ description: 'wrong line' });
  await tx((session) => bank.deleteLine(wrong._id, { session, req }));
  expect(await BankStatementLine.exists({ _id: wrong._id })).toBeNull();
});

test('paying the card from the lira account is one entry, found in both statements', async () => {
  const { BankStatementLine } = require('../models/documents');
  await rate('TRY', '2026-01-01', 40);
  const card = await account('250100');
  const current = await account('110204');
  await tx((session) => people.createEquity({ type: 'capital_in', partyName: 'الشريك', day: '2026-07-01', accountId: current._id, amount: 100000, rate: 40 }, { session, req }));

  // The lira account's statement first: the payment goes to the card (seeded rule)
  const out = [{ day: '2026-09-01', description: 'Kredi Kartı Borç Ödemesi (kart 5271)', amount: -25000 }];
  const [fromBank] = await bank.classifyRows(current._id, out);
  expect(fromBank).toMatchObject({ status: 'new', account: { code: '250100' } });
  await tx((session) => bank.importLines(current._id, [{ ...out[0], counterAccountId: fromBank.account._id }], { session, req }));

  // Then the card's statement: the same money arriving is matched to that entry, not posted again
  const inCard = [{ day: '2026-09-01', description: 'Kredi Kartı Borç Ödeme', amount: 25000 }];
  const [onCard] = await bank.classifyRows(card._id, inCard);
  expect(onCard.status).toBe('match');
  const result = await tx((session) => bank.importLines(card._id, inCard, { session, req }));
  expect(result).toMatchObject({ matched: 1, posted: 0 });
  const [a, b] = await BankStatementLine.find({ description: /Borç Ödeme/ }).sort({ accountId: 1 });
  expect(String(a.entryId || a.matchedEntryIds[0])).toBe(String(b.entryId || b.matchedEntryIds[0]));
  expect((await getBalance(current._id)).foreign).toBe(10000000 - 2500000);
  expect((await getBalance(card._id)).foreign).toBe(2500000);
});
