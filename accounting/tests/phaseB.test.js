// Phase B of the V6 decisions: partner current accounts (Aswaq) classified to trips, orders and
// debts; receipts from suppliers; third-party funders; claim write-offs; year closing.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry, Account } = require('../models');
const { SupplierBill } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const bank = require('../services/posting/bank');
const { refreshTripPackages } = require('../services/tripLinks');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Balance = require('../../models/balance');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const admin = { _id: oid(), roles: { isAdmin: true } };
const req = { user: admin };
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;
const setSettings = async (values) => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: values });
  invalidateConfig();
};

beforeEach(async () => {
  await resetDb();
  await setSettings({ liveEnabled: true });
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 9 }]);
});

let customerSeq = 0;
const newCustomer = async () => {
  customerSeq++;
  return (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: String(customerSeq), customerId: `B${customerSeq}` })).insertedId;
};

async function newOrder({ user, isPayment = false, totalInvoice = 0, packages = [] }) {
  const paymentList = packages.map((p) => ({
    _id: oid(),
    status: { arrived: true, received: !!p.received },
    deliveredPackages: { trackingNumber: `TRK${Math.random().toString(36).slice(2, 7)}`, weight: { total: p.weight, measureUnit: 'KG' }, exiosPrice: p.price, shipmentMethod: 'air' },
  }));
  const { insertedId } = await Order.collection.insertOne({
    orderId: `B${Date.now()}${Math.random().toString(36).slice(2, 6)}`, user, placedAt: 'tripoli', isPayment, isShipment: !isPayment,
    totalInvoice, unsureOrder: false, isCanceled: false, shipment: { method: 'air' }, paymentList, createdAt: new Date('2026-01-02'),
  });
  return { _id: insertedId, packageIds: paymentList.map((p) => p._id) };
}

const newTrip = async (packageIds) => {
  const { insertedId } = await Inventory.collection.insertOne({
    voyage: 'AIR-B', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', status: 'processing',
    orders: packageIds.map((id) => ({ paymentList: { _id: id } })), createdAt: new Date(),
  });
  await refreshTripPackages(insertedId);
  return insertedId;
};

const importLine = async (accountCode, row) => {
  const acct = await account(accountCode);
  await tx((session) => bank.importLines(acct._id, [row], { session, req }));
  const { BankStatementLine } = require('../models/documents');
  return BankStatementLine.findOne({ accountId: acct._id, description: row.description }).lean();
};

test('B4: an Aswaq statement line goes to a trip, an order or a customer debt', async () => {
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, isPayment: true, totalInvoice: 300 });
  const shipment = await newOrder({ user: customer, packages: [{ weight: 10, price: 10 }] });
  const trip = await newTrip(shipment.packageIds);
  await tx((session) => syncOrder(order._id, { session }));

  // Aswaq paid 80$ of shipping on the trip, 250$ for the purchase, 40$ of customs for the customer
  const tripLine = await importLine('260100', { day: '2026-02-01', description: 'Aswaq shipping UAE', amount: -80 });
  await tx((session) => bank.createEntryForLine(tripLine._id, { target: 'trip', tripId: trip, confirmNotDuplicate: true }, { session, req }));
  const orderLine = await importLine('260100', { day: '2026-02-02', description: 'Aswaq purchase KSA', amount: -250 });
  await tx((session) => bank.createEntryForLine(orderLine._id, { target: 'order', orderId: order._id, confirmNotDuplicate: true }, { session, req }));
  const debtLine = await importLine('260100', { day: '2026-02-03', description: 'Customs paid for customer', amount: -40 });
  await tx((session) => bank.createEntryForLine(debtLine._id, { target: 'debt', partnerId: customer, confirmNotDuplicate: true }, { session, req }));

  // We owe Aswaq 370$; the trip, the order and the customer carry their share
  expect(await balanceOf('260100')).toBe(-37000);
  expect(await balanceOf('130100', { tripId: trip })).toBe(8000);
  expect(await balanceOf('130200', { orderId: order._id })).toBe(25000);
  const debt = await Balance.findOne({ owner: customer }).lean();
  expect(debt).toMatchObject({ amount: 40, currency: 'USD', debtType: 'general', source: { kind: 'partner' } });
  expect(await balanceOf('121000', { partnerId: customer })).toBe(44000); // 300 purchase + 100 shipping + 40 debt
  expect(await JournalEntry.exists({ eventKey: `GENERAL_DEBT:${debt._id}`, 'lines.arKey': `GEN:${debt._id}` })).toBeTruthy();
  expect(await SupplierBill.countDocuments({ status: 'posted' })).toBe(2);

  // Undoing the debt line takes the debt away again
  await tx((session) => bank.cancelLineEntry(debtLine._id, { session, req, reason: 'خطأ' }));
  expect(await Balance.countDocuments({ owner: customer })).toBe(0);
  expect(await balanceOf('260100')).toBe(-33000);
});

test('B5: money received from a supplier settles a credit note, then their advance, then is held for them', async () => {
  const payables = require('../services/posting/payables');
  const { Vendor } = require('../models/documents');
  const { cancelDocument } = require('../services/cancel');
  await CurrencyRate.create([{ currency: 'CNY', day: '2026-01-01', rate: 7 }]);
  const [vendor] = await Vendor.create([{ name: 'Alibaba shop', type: 'supplier' }]);
  const cash = await account('110101');
  const alipay = await account('110301');
  const expense = await Account.findOne({ type: 'expense', isGroup: false, isActive: true }).lean();
  // We paid 100$ in advance and paid a 50$ bill, then got a 30$ credit note on it: they owe us 30$
  await tx((session) => payables.createPayment({ vendorId: vendor._id, day: '2026-02-01', fromAccountId: cash._id, amount: 100 }, { session, req }));
  const bill = await tx((session) => payables.createBill({ vendorId: vendor._id, day: '2026-02-02', currency: 'USD', lines: [{ description: 'goods', amount: 50, target: 'expense', accountId: expense._id, office: 'tripoli' }] }, { session, req }));
  await tx((session) => payables.createPayment({ vendorId: vendor._id, day: '2026-02-02', fromAccountId: cash._id, amount: 50, allocations: [{ billId: bill._id, amountUsd: 5000 }] }, { session, req }));
  const note = await tx((session) => payables.createBill({ vendorId: vendor._id, day: '2026-02-03', currency: 'USD', isCreditNote: true, originalBillId: bill._id, lines: [{ description: 'returned', amount: 30, target: 'expense', accountId: expense._id, office: 'tripoli' }] }, { session, req }));
  expect(await payables.apBalance(payables.billKey(bill._id))).toBe(-3000);

  // The supplier sends 350 yuan (50$) to our Alipay: 30$ closes the credit note, 20$ comes off the advance
  const receipt = await tx((session) => payables.createReceipt({
    vendorId: vendor._id, day: '2026-02-05', toAccountId: alipay._id, amount: 350, allocations: [{ billId: note._id, amountUsd: 3000 }],
  }, { session, req }));
  expect(receipt).toMatchObject({ advanceUsd: 2000, currency: 'CNY' });
  expect(await payables.apBalance(payables.billKey(bill._id))).toBe(0);
  expect(await payables.apBalance(payables.advanceKey(vendor._id))).toBe(-8000);
  expect(await getBalance(alipay._id)).toEqual({ usd: 5000, foreign: 350 * 100 });

  await tx((session) => cancelDocument('AccountingSupplierReceipt', receipt._id, { session, req, reason: 'خطأ' }));
  expect(await payables.apBalance(payables.billKey(bill._id))).toBe(-3000);
  expect((await getBalance(alipay._id)).usd).toBe(0);
});

test('B7: the balance sheet shows this year apart from earlier years not closed yet', async () => {
  const { balanceSheet } = require('../services/reports/statements');
  const { post } = require('./helpers');
  const cash = await account('110101');
  const revenue = await account('410600');
  await post({ eventType: 'MANUAL', eventKey: 'B7:old', date: '2025-06-01', lines: [{ accountId: cash._id, debit: 10000 }, { accountId: revenue._id, credit: 10000, office: 'tripoli' }] });
  await post({ eventType: 'MANUAL', eventKey: 'B7:new', date: '2026-03-01', lines: [{ accountId: cash._id, debit: 2500 }, { accountId: revenue._id, credit: 2500, office: 'tripoli' }] });
  const sheet = await balanceSheet({ asOf: '2026-06-30' });
  expect(sheet.balanced).toBe(true);
  expect(sheet.equity).toMatchObject({ unclosedEarnings: 12500, currentYearEarnings: 2500, priorUnclosedEarnings: 10000, yearStart: '2026-01-01' });
});

test('B8: the owner posts into a closed year; a supplementary closing carries it into retained earnings', async () => {
  const { createManualEntry, cancelManualEntry } = require('../services/manualEntry');
  const { closeYear } = require('../services/closing');
  const { post } = require('./helpers');
  const cash = await account('110101');
  const expense = await account('530800');
  const revenue = await account('410600');
  await Account.updateMany({ _id: { $in: [cash._id, expense._id, revenue._id] } }, { $set: { allowManualEntry: true } });
  invalidateConfig();
  await post({ eventType: 'MANUAL', eventKey: 'B8:rev', date: '2025-05-01', lines: [{ accountId: cash._id, debit: 50000 }, { accountId: revenue._id, credit: 50000, office: 'tripoli' }] });
  await tx((session) => closeYear('2025', { session, req }));
  invalidateConfig();
  expect(await balanceOf('320000')).toBe(-50000);

  const late = { date: '2025-12-20', description: 'فاتورة كهرباء متأخرة', lines: [{ accountId: expense._id, side: 'debit', amount: 30, office: 'tripoli' }, { accountId: cash._id, side: 'credit', amount: 30 }] };
  // Refused without saying so, and refused for anyone but the owner
  await expect(tx((session) => createManualEntry(late, { session, req }))).rejects.toThrow('مقفلة');
  const clerk = { _id: oid(), roles: { isAccountant: true } };
  await expect(tx((session) => createManualEntry({ ...late, inLockedPeriod: true }, { session, req: { user: clerk } }))).rejects.toMatchObject({ statusCode: 403 });

  const entry = await tx((session) => createManualEntry({ ...late, inLockedPeriod: true }, { session, req }));
  expect(entry.day).toBe('2025-12-20');
  // 2025 stays closed: its expense is in retained earnings, nothing left on the result accounts
  expect(await balanceOf('530800')).toBe(0);
  expect(await balanceOf('320000')).toBe(-47000);
  const supplement = await JournalEntry.findOne({ eventKey: `YEAR_CLOSE_SUPP:2025:${entry._id}` }).lean();
  expect(supplement).toMatchObject({ day: '2025-12-31', eventType: 'YEAR_CLOSE' });

  // Undone by the owner: back on its own date, with its closing
  await tx((session) => cancelManualEntry(entry._id, { session, req, reason: 'مكرر' }));
  expect(await balanceOf('320000')).toBe(-50000);
  expect(await balanceOf('530800')).toBe(0);
  expect((await JournalEntry.findOne({ eventKey: `CANCEL:JournalEntry:${entry._id}` }).lean()).day).toBe('2025-12-20');
});

test('B9: writing off a delivered package: revenue = what was paid, full cost, a later payment raises revenue', async () => {
  const { createWriteOff } = require('../services/posting/writeOff');
  const { cancelDocument } = require('../services/cancel');
  const operations = require('../services/posting/operations');
  const payables = require('../services/posting/payables');
  const { Vendor } = require('../models/documents');
  const UserStatement = require('../../models/userStatement');
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 10, price: 10, received: true }] }); // 100$
  const [pkg] = order.packageIds;
  const trip = await newTrip([pkg]);
  const [carrier] = await Vendor.create([{ name: 'Carrier', type: 'carrier' }]);
  await tx((session) => payables.createBill({ vendorId: carrier._id, day: '2026-01-03', currency: 'USD', lines: [{ description: 'air', amount: 70, target: 'trip', tripId: trip }] }, { session, req }));
  await tx((session) => syncOrder(order._id, { session }));
  const key = `SHP:${order._id}:${pkg}`;
  const pay = async (amount, day) => {
    const dep = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date(day) });
    await tx((session) => operations.postStatement(dep._id, { session }));
    const spend = await UserStatement.create({ user: customer, createdBy: oid(), description: 'دفع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date(day) });
    await tx((session) => operations.postStatement(spend._id, { session, target: { orderId: order._id, packageIds: [pkg] } }));
  };
  await pay(40, '2026-02-01');
  expect(await balanceOf('410100')).toBe(0); // not fully paid: deferred

  // An undelivered package is refused
  const other = await newOrder({ user: customer, packages: [{ weight: 1, price: 10 }] });
  await tx((session) => syncOrder(other._id, { session }));
  await expect(tx((session) => createWriteOff({ day: '2026-03-01', arKey: `SHP:${other._id}:${other.packageIds[0]}`, reason: 'x' }, { session, req }))).rejects.toThrow('لم يُسلَّم');

  const writeOff = await tx((session) => createWriteOff({ day: '2026-03-01', arKey: key, reason: 'العميل لن يدفع' }, { session, req }));
  expect(writeOff.amountUsd).toBe(6000);
  expect(await balanceOf('121000', { partnerId: customer })).toBe(1000); // only the other order
  expect(await balanceOf('410100')).toBe(-4000); // revenue = paid
  expect(await balanceOf('510100')).toBe(7000); // full cost
  expect(await balanceOf('220400')).toBe(-1000); // only the other order's package is still deferred

  // Paid 20$ later: the write-off shrinks and revenue rises by it
  await pay(20, '2026-04-01');
  expect(await balanceOf('410100')).toBe(-6000);
  expect((await operations.openBalances([key])).get(key) || 0).toBe(0);
  await expect(tx((session) => cancelDocument('AccountingClaimWriteOff', writeOff._id, { session, req, reason: 'x' }))).rejects.toThrow('بعد شطبها');
});

test('B10: the weekly Odoo comparison saves our three figures beside the ones typed from Odoo', async () => {
  const odoo = require('../services/odoo');
  const { post } = require('./helpers');
  const customer = await newCustomer();
  const cash = await account('110101');
  const wallet = await account('220100');
  const receivable = await account('121000');
  await post({ eventType: 'MANUAL', eventKey: 'B10:dep', date: '2026-02-01', lines: [{ accountId: cash._id, debit: 30000 }, { accountId: wallet._id, credit: 30000, partnerId: customer }] });
  await post({ eventType: 'MANUAL', eventKey: 'B10:ar', date: '2026-02-02', lines: [{ accountId: receivable._id, debit: 5000, partnerId: customer }, { accountId: wallet._id, credit: 5000, partnerId: customer }] });
  expect(await odoo.ourFigures('2026-02-28')).toEqual({ cash: 30000, wallets: 35000, receivables: 5000 });
  const saved = await odoo.saveComparison({ day: '2026-02-28', odoo: { cash: 300, wallets: 340, receivables: 50 } }, admin);
  expect(saved.odoo).toMatchObject({ cash: 30000, wallets: 34000, receivables: 5000 });
  expect((await odoo.listComparisons())).toHaveLength(1);
});

test('concurrent write-offs cannot exceed one open customer claim', async () => {
  const { createWriteOff } = require('../services/posting/writeOff');
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, isPayment: true, totalInvoice: 100 });
  await tx((session) => syncOrder(order._id, { session }));
  const arKey = `PUR:${order._id}`;
  const results = await Promise.allSettled([1, 2].map((n) => tx((session) => createWriteOff({
    day: '2026-03-01', arKey, amountUsd: 7500, reason: 'Uncollectible', idempotencyKey: `WRITE-OFF-RACE-${n}`,
  }, { session, req }))));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await balanceOf('121000', { partnerId: customer })).toBe(2500);
  expect(await balanceOf('220300')).toBe(-2500);
});

test('B9: a cancelled write-off puts the claim and the deferred revenue back', async () => {
  const { createWriteOff } = require('../services/posting/writeOff');
  const { cancelDocument } = require('../services/cancel');
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, isPayment: true, totalInvoice: 100 });
  await tx((session) => syncOrder(order._id, { session }));
  const writeOff = await tx((session) => createWriteOff({ day: '2026-03-01', arKey: `PUR:${order._id}`, reason: 'لن يدفع' }, { session, req }));
  expect(await balanceOf('121000')).toBe(0);
  expect(await balanceOf('220300')).toBe(0);
  await tx((session) => cancelDocument('AccountingClaimWriteOff', writeOff._id, { session, req, reason: 'خطأ' }));
  expect(await balanceOf('121000')).toBe(10000);
  expect(await balanceOf('220300')).toBe(-10000);
  expect(await balanceOf('410300')).toBe(0);
});
