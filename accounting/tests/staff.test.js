// The system's own screens (spec 19.1): office expenses, trip costs and order purchases entered
// by staff without the accounting section, and what each person may see and change.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const User = require('../../models/user');
const Inventory = require('../../models/inventory');
const errorHandler = require('../../middleware/error');
const { routes, systemRoutes } = require('..');
const { getBalance } = require('../services/carrying');
const { SupplierBill, SupplierPayment, Vendor, ExpenseType } = require('../models/documents');
const { AccountingSettings, CurrencyRate } = require('../models');
const { invalidateConfig } = require('../services/config');

const app = express();
app.use(express.json());
app.use('/api/accounting', routes);
app.use('/api', systemRoutes);
app.use(errorHandler);

let n = 0;
const makeUser = (roles, extra = {}) => {
  n++;
  return User.create({ username: `s${n}`, firstName: `S${n}`, lastName: 'L', phone: 930000 + n, password: 'x', customerId: `S${n}`, roles, ...extra });
};
const tokenFor = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET);
const call = (method, url, user) => request(app)[method](url).set('Authorization', `Bearer ${tokenFor(user)}`);
const balanceOf = async (code) => (await getBalance((await account(code))._id)).usd;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await CurrencyRate.create({ currency: 'LYD', day: '2026-01-01', rate: 9 });
});

test('an employee records an expense for their own office, sees only their own, and edits it the same day', async () => {
  const clerk = await makeUser({ isEmployee: true }, { office: 'tripoli' });
  const other = await makeUser({ isEmployee: true }, { office: 'benghazi' });
  const options = await call('get', '/api/office-expenses/options', clerk);
  expect(options.status).toBe(200);
  expect(options.body.office).toBe('tripoli');
  expect(options.body.anyOffice).toBe(false);
  expect(options.body.currencies).toEqual(expect.arrayContaining(['USD', 'LYD']));
  const hospitality = await ExpenseType.findOne({ seedKey: 'hospitality' });

  // The office cannot be chosen by an employee: it is always theirs
  const created = await call('post', '/api/office-expenses', clerk).send({ expenseTypeId: hospitality._id, amount: 20, currency: 'USD', office: 'benghazi', note: 'قهوة' });
  expect(created.status).toBe(200);
  expect(created.body.office).toBe('tripoli');
  expect(await balanceOf('531300')).toBe(2000);
  expect(await balanceOf('110121')).toBe(-2000);

  await call('post', '/api/office-expenses', other).send({ expenseTypeId: hospitality._id, amount: 5, currency: 'USD' });
  const mine = await call('get', '/api/office-expenses', clerk);
  expect(mine.body.results).toHaveLength(1);
  expect(mine.body.results[0]).toMatchObject({ type: 'ضيافة', amount: 20, currency: 'USD', note: 'قهوة', editable: true });
  expect(mine.body.total).toBeUndefined();

  // Someone else's expense cannot be touched; one's own is edited (reversed and posted again)
  expect((await call('delete', `/api/office-expenses/${created.body._id}`, other)).status).toBe(403);
  const edited = await call('put', `/api/office-expenses/${created.body._id}`, clerk).send({ amount: 25 });
  expect(edited.status).toBe(200);
  expect(await balanceOf('531300')).toBe(2500 + 500);
  expect((await SupplierBill.findById(created.body._id)).status).toBe('canceled');
  expect(String((await SupplierBill.findById(edited.body._id)).replaces)).toBe(created.body._id);

  expect((await call('delete', `/api/office-expenses/${edited.body._id}`, clerk)).status).toBe(200);
  expect(await balanceOf('531300')).toBe(500);
  expect((await call('get', '/api/office-expenses', clerk)).body.results).toHaveLength(0);
});

test('without an office set, an employee is told to ask the owner; the owner sets it in Access', async () => {
  const clerk = await makeUser({ isEmployee: true });
  const owner = await makeUser({ isAdmin: true });
  const type = await ExpenseType.findOne({ seedKey: 'other' });
  const refused = await call('post', '/api/office-expenses', clerk).send({ expenseTypeId: type._id, amount: 1, currency: 'USD' });
  expect(refused.status).toBe(400);
  expect((await call('put', `/api/accounting/access/staff/${clerk._id}`, owner).send({ office: 'china' })).status).toBe(200);
  expect((await call('get', '/api/office-expenses/options', clerk)).body.office).toBe('china');
});

test('a closed period refuses a staff expense; the accountant reviews every office', async () => {
  const clerk = await makeUser({ isEmployee: true }, { office: 'tripoli' });
  const owner = await makeUser({ isAdmin: true });
  const type = await ExpenseType.findOne({ seedKey: 'transport' });
  await call('post', '/api/office-expenses', clerk).send({ expenseTypeId: type._id, amount: 3, currency: 'USD' });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-01-31' } });
  invalidateConfig();
  expect((await call('post', '/api/office-expenses', clerk).send({ expenseTypeId: type._id, amount: 3, currency: 'USD', day: '2026-01-10' })).status).toBe(403);
  const review = await call('get', '/api/accounting/office-expenses?office=tripoli', owner);
  expect(review.status).toBe(200);
  expect(review.body.results).toHaveLength(1);
  expect(review.body.results[0].createdBy.name).toBe(`${clerk.firstName} ${clerk.lastName}`);
  expect((await call('get', '/api/accounting/office-expenses', clerk)).status).toBe(403);
});

test('a trip cost entered on the trip page is a supplier bill, paid from a box or owed to the supplier', async () => {
  const clerk = await makeUser({ isEmployee: true }, { office: 'tripoli' });
  const trip = await Inventory.create({ voyage: 'AIR-1', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN', status: 'processing' });
  const box = await account('110101');
  const paid = await call('post', `/api/acc/trips/${trip._id}/costs`, clerk).send({ vendorName: 'شركة شحن', amount: 300, payFromAccountId: box._id, description: 'شحن جوي' });
  expect(paid.status).toBe(200);
  const owed = await call('post', `/api/acc/trips/${trip._id}/costs`, clerk).send({ vendorName: 'شركة شحن', amount: 100, currency: 'USD' });
  expect(owed.status).toBe(200);
  expect(await balanceOf('130100')).toBe(40000);
  expect(await balanceOf('110121')).toBe(-30000);
  expect(await balanceOf('210100')).toBe(-10000);
  const list = await call('get', `/api/acc/trips/${trip._id}/costs`, clerk);
  expect(list.body.bills).toHaveLength(2);
  expect(list.body.bills.find((b) => b.paid).paidFrom).toBe('خزينة فرعية طرابلس - دولار'); // staff cash comes out of their office's sub box (spec v8)
});

test('a direct expense uses the cash supplier, posts its full cost and payment once, and previews duplicates', async () => {
  const owner = await makeUser({ isAdmin: true });
  const cash = await account('110101');
  const expense = await account('531300');
  const generic = await Vendor.findOne({ seedKey: 'cash_expenses' });
  const input = { withoutVendor: true, day: '2026-10-31', currency: 'USD', paidImmediatelyFrom: cash._id,
    idempotencyKey: 'direct-expense-once', vendorRef: 'DIRECT-1',
    lines: [{ target: 'expense', description: 'Hospitality paid without named supplier', office: 'tripoli', accountId: expense._id, amount: 17 }] };
  const saved = await call('post', '/api/accounting/bills', owner).send(input);
  expect(saved.status).toBe(201);
  expect(saved.body.vendorId).toBe(String(generic._id));
  expect(saved.body.paymentId).toBeTruthy();
  expect(await balanceOf('531300')).toBe(1700);
  expect(await balanceOf('110101')).toBe(-1700);
  expect(await balanceOf('210200')).toBe(0);
  const retried = await call('post', '/api/accounting/bills', owner).send(input);
  expect(retried.status).toBe(201);
  expect(retried.body._id).toBe(saved.body._id);
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  expect(await balanceOf('110101')).toBe(-1700);
  const preview = await call('post', '/api/accounting/bills/duplicate-preview', owner).send(input);
  expect(preview.status).toBe(200);
  expect(preview.body.results.map(row => row.billId)).toContain(saved.body._id);
});

test('trip expenses without a named supplier keep the trip cost and employee cash routing', async () => {
  const clerk = await makeUser({ isEmployee: true }, { office: 'tripoli' });
  const trip = await Inventory.create({ voyage: 'DIRECT-AIR', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN', status: 'processing' });
  const generic = await Vendor.findOne({ seedKey: 'cash_expenses' });
  const count = await Vendor.countDocuments();
  const saved = await call('post', `/api/acc/trips/${trip._id}/costs`, clerk).send({ withoutVendor: true,
    amount: 45, payFromAccountId: (await account('110101'))._id, description: 'Direct trip transport', costCategory: 'transport' });
  expect(saved.status).toBe(200);
  const bill = await SupplierBill.findById(saved.body._id);
  expect(String(bill.vendorId)).toBe(String(generic._id));
  expect(String(bill.lines[0].tripId)).toBe(String(trip._id));
  expect(bill.lines[0].costCategory).toBe('transport');
  expect(await Vendor.countDocuments()).toBe(count);
  expect(await balanceOf('130100')).toBe(4500);
  expect(await balanceOf('110121')).toBe(-4500);
  expect(await balanceOf('210200')).toBe(0);
  const rejected = await call('post', `/api/acc/trips/${trip._id}/costs`, clerk).send({ withoutVendor: true, amount: 99 });
  expect(rejected.status).toBe(400);
  expect(await SupplierBill.countDocuments()).toBe(1);
});

test('direct expenses reject unpaid, invalid payment and historical shortcuts without changing the books', async () => {
  const owner = await makeUser({ isAdmin: true });
  const expense = await account('531300');
  const input = { withoutVendor: true, day: '2026-10-31', currency: 'USD',
    lines: [{ target: 'expense', description: 'Direct expense guard', office: 'tripoli', accountId: expense._id, amount: 10 }] };
  for (const extra of [{}, { paidImmediatelyFrom: expense._id },
    { paidImmediatelyFrom: (await account('110101'))._id, paidBeforeCount: true },
    { paidImmediatelyFrom: (await account('110101'))._id, isHistorical: true },
    { paidImmediatelyFrom: (await account('110101'))._id, isCreditNote: true },
    { withoutVendor: 'true' }]) {
    const rejected = await call('post', '/api/accounting/bills', owner).send({ ...input, ...extra });
    expect(rejected.status).toBe(400);
  }
  expect(await SupplierBill.countDocuments()).toBe(0);
  expect(await SupplierPayment.countDocuments()).toBe(0);
  expect(await balanceOf('531300')).toBe(0);
  expect(await balanceOf('110101')).toBe(0);
  await Vendor.updateOne({ seedKey: 'cash_expenses' }, { $set: { isActive: false } });
  expect((await call('post', '/api/accounting/bills', owner).send({ ...input, paidImmediatelyFrom: (await account('110101'))._id })).status).toBe(400);
  expect(await SupplierBill.countDocuments()).toBe(0);
});
