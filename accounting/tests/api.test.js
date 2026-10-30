process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const User = require('../../models/user');
const errorHandler = require('../../middleware/error');
const { routes } = require('..');
const { JournalEntry, Account } = require('../models');

const app = express();
app.use(express.json());
app.use('/api/accounting', routes);
app.use(errorHandler);

let server;
let adminToken;
let employeeToken;
let customer;

const makeUser = (n, roles) => User.create({
  username: `u${n}`, firstName: `F${n}`, lastName: 'L', phone: 900000 + n, password: 'x', customerId: `C${n}`, roles,
});
const tokenFor = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET);
// Test requests must not reuse an idle socket across database resets on Windows/Node 22.
const api = (method, url, token = adminToken) => request(server)[method](`/api/accounting${url}`).set('Connection', 'close').set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await startDb();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await stopDb();
});
beforeEach(async () => {
  await resetDb();
  adminToken = tokenFor(await makeUser(1, { isAdmin: true }));
  employeeToken = tokenFor(await makeUser(2, { isEmployee: true, isAccountant: true }));
  customer = await makeUser(3, { isClient: true });
});

test('review routes protect access and a locked month remains provisional until approval', async () => {
  expect((await api('get', '/review', employeeToken)).status).toBe(403);
  expect((await api('post', '/review/month/approve', employeeToken).send({ month: '2026-01' })).status).toBe(403);
  expect((await api('get', '/review?from=2026-01-01&to=2026-01-31')).status).toBe(200);
  await api('post', '/close/month').send({ month: '2026-01' });
  let report = await api('get', '/reports/income-statement?from=2026-01-01&to=2026-01-31');
  expect(report.body.reviewStatus.status).toBe('provisional');
  expect((await api('post', '/review/month/approve').send({ month: '2026-01' })).status).toBe(200);
  report = await api('get', '/reports/income-statement?from=2026-01-01&to=2026-01-31');
  expect(report.body.reviewStatus.status).toBe('approved');
});

test('HTTP duplicate preview identifies an existing cost and posting cannot bypass it', async () => {
  const vendor = await api('post', '/vendors').send({ name: 'HTTP duplicate supplier', type: 'supplier' });
  const data = { vendorId: vendor.body._id, currency: 'USD', day: '2026-09-10', vendorRef: 'HTTP-INV-1',
    lines: [{ target: 'expense', accountId: (await account('510400'))._id, description: 'Actual purchase', amount: 800, office: 'tripoli' }] };
  expect((await api('post', '/bills').send(data)).status).toBe(201);
  const preview = await api('post', '/bills/duplicate-preview').send(data);
  expect(preview.status).toBe(200);
  expect(preview.body.results).toHaveLength(1);
  expect(preview.body.canConfirmIndependent).toBe(false);
  expect((await api('post', '/bills').send(data)).status).toBe(400);
});

test('only admins can open the accounting section', async () => {
  expect((await api('get', '/dashboard', employeeToken)).status).toBe(403);
  const res = await api('get', '/dashboard');
  expect(res.status).toBe(200);
  expect(res.body.setupDone).toBe(true);
  expect(res.body.missingRates).toEqual(expect.arrayContaining(['LYD', 'CNY']));
});

test('phase 5 endpoints: reports, reconciliation and closing answer for an admin only', async () => {
  const paths = [
    '/reports/income-statement?columns=month', '/reports/balance-sheet', '/reports/cash-flow', '/reports/cash-movements', '/reports/fx', '/reports/trips',
    '/reports/purchases', '/reports/receivables', `/reports/customer-statement/${customer._id}`, '/reports/payables', '/exceptions', '/close/month?month=2026-01', '/close/year?year=2025',
  ];
  for (const path of paths) expect([path, (await api('get', path)).status]).toEqual([path, 200]);
  expect((await api('get', '/reports/income-statement', employeeToken)).status).toBe(403);
  expect((await api('get', '/reports/income-statement?from=nope')).status).toBe(400);
  // phase 6: the accounting view of a customer, and what does not exist answers 404
  const summary = await api('get', `/summary/customer/${customer._id}`);
  expect(summary.body).toMatchObject({ owed: 0, matches: true });
  expect((await api('get', `/summary/order/${customer._id}`)).status).toBe(404);
  expect((await api('get', `/summary/trip/${customer._id}`)).status).toBe(404);
  expect((await api('get', `/vouchers/${customer._id}`)).status).toBe(404);
  expect((await api('get', '/summary/order/nope')).status).toBe(400);
  // an empty year has nothing to close
  expect((await api('post', '/close/year').send({ year: '2025' })).status).toBe(400);
  const closed = await api('post', '/close/month').send({ month: '2026-01' });
  expect(closed.body.lockDate).toBe('2026-01-31');
  expect((await api('get', '/settings')).body.settings.lockDate).toBe('2026-01-31');
});

test('a manual entry can settle one customer claim (clearing the suspense account)', async () => {
  const suspense = await account('399000');
  const receivable = await account('121000');
  const orderId = String(customer._id).replace(/^./, 'a');
  const lines = (arKey) => [
    { accountId: suspense._id, side: 'debit', amount: 30 },
    { accountId: receivable._id, side: 'credit', amount: 30, partnerId: customer._id, arKey },
  ];
  expect((await api('post', '/entries').send({ date: '2026-03-02', description: 'توجيه دفعة', lines: lines('XXX:1') })).status).toBe(400);
  const ok = await api('post', '/entries').send({ date: '2026-03-02', description: 'توجيه دفعة', lines: lines(`PUR:${orderId}`) });
  expect(ok.status).toBe(201);
  const line = (await JournalEntry.findById(ok.body._id).lean()).lines.find((l) => l.arKey);
  expect(line.arKey).toBe(`PUR:${orderId}`);
  expect(String(line.orderId)).toBe(orderId);
});

test('manual entry in dinars uses the daily rate, locks the rate, and cancels with a reversal', async () => {
  expect((await api('post', '/rates').send({ currency: 'LYD', day: '2026-03-01', rate: 9 })).status).toBe(200);
  const cash = await account('110102');
  const capital = await account('310000');

  const body = {
    date: '2026-03-01', description: 'رأس مال', idempotencyKey: 'k1',
    lines: [
      { accountId: cash._id, side: 'debit', amount: 4500, office: 'tripoli' },
      { accountId: capital._id, side: 'credit', amount: 500 },
    ],
  };
  const created = await api('post', '/entries').send(body);
  expect(created.status).toBe(201);
  expect(created.body.lines[0]).toMatchObject({ debit: 50000, amountCurrency: 4500000, rate: 9 });

  // double submit with the same key
  const again = await api('post', '/entries').send(body);
  expect(again.body._id).toBe(created.body._id);
  expect(await JournalEntry.countDocuments()).toBe(1);

  // the rate is now used and cannot change
  expect((await api('post', '/rates').send({ currency: 'LYD', day: '2026-03-01', rate: 10 })).status).toBe(400);

  expect((await api('post', `/entries/${created.body._id}/cancel`).send({})).status).toBe(400);
  const cancelled = await api('post', `/entries/${created.body._id}/cancel`).send({ reason: 'خطأ' });
  expect(cancelled.status).toBe(200);
  expect((await api('post', `/entries/${cancelled.body._id}/cancel`).send({ reason: 'x' })).status).toBe(400);

  const tb = await api('get', '/reports/trial-balance');
  expect(tb.body.totals.debit).toBe(tb.body.totals.credit);
  expect(tb.body.totals.closing).toBe(0);
});

test('manual entry on a locked day is refused', async () => {
  await api('patch', '/settings').send({ lockDate: '2026-03-31' });
  const cash = await account('110101');
  const capital = await account('310000');
  const res = await api('post', '/entries').send({
    date: '2026-03-10', description: 'x',
    lines: [{ accountId: cash._id, side: 'debit', amount: 10, office: 'tripoli' }, { accountId: capital._id, side: 'credit', amount: 10 }],
  });
  expect(res.status).toBe(400);
});

test('scenario 22/25: delete, archive and rename rules for accounts', async () => {
  const parent = await account('53');
  const fresh = await api('post', '/accounts').send({ code: '539900', name: 'تجربة', type: 'expense', parentId: parent._id, requires: ['office'] });
  expect(fresh.status).toBe(201);
  expect((await api('delete', `/accounts/${fresh.body._id}`)).status).toBe(200);

  const used = await api('post', '/accounts').send({ code: '539901', name: 'مستخدم', type: 'expense', parentId: parent._id, requires: ['office'] });
  const cash = await account('110101');
  await api('post', '/entries').send({
    date: '2026-03-01', description: 'مصروف',
    lines: [{ accountId: used.body._id, side: 'debit', amount: 500, office: 'tripoli' }, { accountId: cash._id, side: 'credit', amount: 500, office: 'tripoli' }],
  });

  const del = await api('delete', `/accounts/${used.body._id}`);
  expect(del.status).toBe(400);
  expect(del.body.reasons.join()).toMatch('قيد');
  const archiveWithBalance = await api('post', `/accounts/${used.body._id}/archive`);
  expect(archiveWithBalance.status).toBe(400);
  expect(archiveWithBalance.body.reasons.join()).toMatch('رصيد');

  // a role-linked account cannot be archived
  const receivable = await account('121000');
  const roleArchive = await api('post', `/accounts/${receivable._id}/archive`);
  expect(roleArchive.body.reasons.join()).toMatch('دور');

  // type/currency locked once used, code free to change
  expect((await api('patch', `/accounts/${used.body._id}`).send({ type: 'income' })).status).toBe(400);
  const renamed = await api('patch', `/accounts/${used.body._id}`).send({ code: '531699' });
  expect(renamed.status).toBe(200);
  const ledger = await api('get', `/reports/account-ledger/${used.body._id}`);
  expect(ledger.body.account.code).toBe('531699');
  expect(ledger.body.closing.usd).toBe(50000);
  // a group's ledger holds the movements of the accounts under it
  const groupLedger = await api('get', `/reports/account-ledger/${parent._id}`);
  expect(groupLedger.status).toBe(200);
  expect(groupLedger.body.movements.map((m) => m.account.code)).toContain('531699');

  // a group with active children cannot be deleted or archived
  expect((await api('delete', `/accounts/${parent._id}`)).status).toBe(400);
  expect((await api('post', `/accounts/${parent._id}/archive`)).status).toBe(400);
});

test('scenario 19: new office and currency from the UI, then a deposit posts on them', async () => {
  expect((await api('post', '/currencies').send({ code: 'JOD', name: 'دينار أردني', decimals: 2 })).status).toBe(201);
  const office = await api('post', '/offices').send({ code: 'misurata2', name: 'مصراتة 2', currencies: ['USD', 'JOD'] });
  expect(office.status).toBe(201);

  const offices = await api('get', '/offices');
  const created = offices.body.results.find((o) => o.code === 'misurata2');
  expect(created.cashAccounts).toHaveLength(2);
  const aedCash = created.cashAccounts.find((a) => a.currency === 'JOD');

  await api('post', '/rates').send({ currency: 'JOD', day: '2026-04-01', rate: 3.67 });
  const revenue = await account('410600');
  const res = await api('post', '/entries').send({
    date: '2026-04-01', description: 'إيداع',
    lines: [{ accountId: aedCash._id, side: 'debit', amount: 1000, office: 'misurata2' }, { accountId: revenue._id, side: 'credit', amount: 272.48, office: 'misurata2' }],
  });
  expect(res.status).toBe(201);
  expect(res.body.lines[0].debit).toBe(27248);
  // manual entries go to the general journal; the new cash box has its own journal for its operations
  expect(res.body.number).toBe('JV/2026/000001');
  const journals = await api('get', '/journals');
  expect(journals.body.results.map((j) => j.code)).toEqual(expect.arrayContaining(['CASH-MISURA-USD', 'CASH-MISURA-JOD']));
});

test('roles cannot point to an unsuitable account', async () => {
  const cash = await account('110101');
  const res = await api('put', '/settings/roles').send({ roles: { revenue_shipping_air: String(cash._id) } });
  expect(res.status).toBe(400);
  const settings = await api('get', '/settings');
  expect(settings.body.roles.every((r) => !r.problem)).toBe(true);
});

test('phase 2 over HTTP: vendor, trip bill, payment, statement, cancel', async () => {
  const Inventory = require('../../models/inventory');
  const trip = (await Inventory.collection.insertOne({ voyage: 'AIR-1', inventoryType: 'inventoryGoods', inventoryPlace: 'benghazi', shippingType: 'air', status: 'processing' })).insertedId;
  const cash = await account('110103');
  await api('post', '/equity').send({ type: 'capital_in', partyName: 'الشريك', day: '2026-01-01', accountId: cash._id, amount: 5000 });

  const vendor = await api('post', '/vendors').send({ name: 'شركة الطيران', type: 'carrier' });
  expect(vendor.status).toBe(201);
  const bill = await api('post', '/bills').send({
    vendorId: vendor.body._id, day: '2026-02-01', currency: 'USD', idempotencyKey: 'bill-1',
    lines: [{ description: 'شحن جوي', amount: 3000, target: 'trip', tripId: trip }],
  });
  expect(bill.status).toBe(201);
  expect((await api('post', '/bills').send({ vendorId: vendor.body._id, day: '2026-02-01', currency: 'USD', idempotencyKey: 'bill-1', lines: [] })).body._id).toBe(bill.body._id);

  const trips = await api('get', '/trips');
  expect(trips.body.results[0]).toMatchObject({ voyage: 'AIR-1', costInProgress: 300000 });

  const open = await api('get', `/vendors/${vendor.body._id}/open-bills`);
  expect(open.body.results[0].open).toBe(300000);
  const payment = await api('post', '/payments').send({
    vendorId: vendor.body._id, day: '2026-02-05', fromAccountId: cash._id, amount: 1000, allocations: [{ billId: bill.body._id, amountUsd: 100000 }],
  });
  expect(payment.status).toBe(201);
  const statement = await api('get', `/vendors/${vendor.body._id}/statement`);
  expect(statement.body.owed).toBe(200000);

  const refused = await api('post', `/documents/AccountingSupplierBill/${bill.body._id}/cancel`).send({ reason: 'خطأ' });
  expect(refused.status).toBe(400);
  expect((await api('post', `/documents/AccountingSupplierPayment/${payment.body._id}/cancel`).send({})).status).toBe(400);
  expect((await api('post', `/documents/AccountingSupplierPayment/${payment.body._id}/cancel`).send({ reason: 'خطأ' })).status).toBe(200);
  expect((await api('post', `/documents/AccountingSupplierBill/${bill.body._id}/cancel`).send({ reason: 'خطأ' })).status).toBe(200);
  expect((await api('get', '/trips')).body.results[0].costInProgress).toBe(0);

  const tb = await api('get', '/reports/trial-balance');
  expect(tb.body.totals.debit).toBe(tb.body.totals.credit);
  expect((await api('get', '/expense-types?active=true')).body.results.length).toBeGreaterThan(10);
});

test('user lookup for entry lines', async () => {
  const res = await api('get', '/lookup/users?search=C3');
  expect(res.body.results[0].customerId).toBe(customer.customerId);
  expect(await Account.countDocuments()).toBeGreaterThan(70);
});

test('odoo export screen: overview, mapping, export and undo through the API', async () => {
  const cash = await account('110101');
  const capital = await account('310000');
  const { runInTransaction } = require('../services/transaction');
  const { postEntry } = require('../services/ledger');
  await runInTransaction((session) => postEntry({
    eventType: 'MANUAL', eventKey: 'ODOO:1', date: '2026-02-01', description: 'رأس مال',
    lines: [{ accountId: cash._id, debit: 5000 }, { accountId: capital._id, credit: 5000 }],
  }, { session }));

  const overview = await api('get', '/odoo?upTo=2026-12-31');
  expect(overview.status).toBe(200);
  expect(overview.body.pending.count).toBe(1);
  expect(overview.body.pending.unmapped.map((a) => a.code).sort()).toEqual(['110101', '310000']);
  expect((await api('post', '/odoo/exports').send({ upTo: '2026-12-31' })).status).toBe(400);

  expect((await api('put', '/odoo/mapping').send({ accounts: [{ _id: cash._id, odooCode: '101001' }, { _id: capital._id, odooCode: '301000' }] })).status).toBe(200);
  const created = await api('post', '/odoo/exports').send({ upTo: '2026-12-31' });
  expect(created.status).toBe(201);
  expect(created.body.rows.map((r) => r['line_ids/account_id'])).toEqual(['101001', '301000']);
  expect((await api('get', `/odoo/exports/${created.body.export._id}/rows`)).body.rows).toHaveLength(2);
  expect((await api('post', `/odoo/exports/${created.body.export._id}/undo`)).status).toBe(200);
  expect((await api('get', '/odoo?upTo=2026-12-31')).body.pending.count).toBe(1);
  expect((await api('get', '/odoo', employeeToken)).status).toBe(403);
});

describe('accounting access', () => {
  const OWNERS = process.env.ACCOUNTING_OWNER_IDS;
  afterEach(() => {
    if (OWNERS === undefined) delete process.env.ACCOUNTING_OWNER_IDS; else process.env.ACCOUNTING_OWNER_IDS = OWNERS;
    process.env.ACCOUNTING_DEV_ALL_ADMINS = 'true';
  });

  test('the auditor preset can read entries but cannot post entries, write off claims or add attachments', async () => {
    const owner = await makeUser(20, { isAdmin: true });
    const auditor = await makeUser(21, { isAccountant: true });
    process.env.ACCOUNTING_OWNER_IDS = String(owner._id);
    const ownerToken = tokenFor(owner);
    const auditorToken = tokenFor(auditor);
    const preset = require('../services/access').PRESETS.find((p) => p.key === 'auditor');
    expect((await api('put', `/access/members/${auditor._id}`, ownerToken).send({ permissions: preset.permissions })).status).toBe(200);
    expect((await api('get', '/entries', auditorToken)).status).toBe(200);
    expect((await api('get', '/reports/trial-balance', auditorToken)).status).toBe(200);
    expect((await api('post', '/entries', auditorToken).send({})).status).toBe(403);
    expect((await api('post', '/write-offs', auditorToken).send({})).status).toBe(403);
    expect((await api('post', `/entries/${customer._id}/attachments`, auditorToken)).status).toBe(403);
    expect((await api('post', `/entries/${customer._id}/cancel`, auditorToken).send({ reason: 'test' })).status).toBe(403);
    for (const route of ['bills', 'payments', 'receipts', 'yuan-purchases', 'customer-refunds', 'transfers', 'cash-counts', 'salaries', 'equity', 'nettings', 'close/month', 'close/year', 'live/process', 'live/events/' + customer._id + '/retry', 'suspense/settle', 'assets/depreciate', 'prepaid/amortize', 'bank/import']) {
      expect((await api('post', '/' + route, auditorToken).send({})).status).toBe(403);
    }
    for (const model of ['AccountingSupplierBill', 'AccountingSupplierPayment', 'AccountingSupplierReceipt', 'AccountingYuanPurchase', 'AccountingCustomerRefund', 'AccountingTreasuryTransfer', 'AccountingCashCount', 'AccountingSalaryPayment', 'AccountingFixedAsset', 'AccountingPrepaidExpense', 'AccountingEquityTransaction', 'AccountingNetting']) {
      expect((await api('post', `/documents/${model}/${customer._id}/cancel`, auditorToken).send({ reason: 'test' })).status).toBe(403);
      expect((await api('post', `/documents/${model}/${customer._id}/attachments`, auditorToken)).status).toBe(403);
    }
  });

  test('a database without any owner account is closed to every admin unless ACCOUNTING_DEV_ALL_ADMINS is set', async () => {
    delete process.env.ACCOUNTING_DEV_ALL_ADMINS;
    expect((await api('get', '/access/me')).status).toBe(403);
    expect((await api('get', '/dashboard')).status).toBe(403);
    process.env.ACCOUNTING_DEV_ALL_ADMINS = 'true';
    expect((await api('get', '/access/me')).body.isOwner).toBe(true);
  });

  test('only the owner accounts manage access; another admin sees only what they were given', async () => {
    const owner = await makeUser(10, { isAdmin: true });
    const otherAdmin = await makeUser(11, { isAdmin: true });
    const accountant = await makeUser(12, { isAccountant: true });
    process.env.ACCOUNTING_OWNER_IDS = String(owner._id);
    const ownerToken = tokenFor(owner);
    const adminToken2 = tokenFor(otherAdmin);
    const accountantToken = tokenFor(accountant);

    // Wait for the owner cache to see the new owner id
    const accessService = require('../services/access');
    expect(await accessService.isOwner(owner)).toBe(true);

    expect((await api('get', '/access/me', adminToken2)).status).toBe(403);
    expect((await api('get', '/access/members', adminToken2)).status).toBe(403);

    const members = await api('get', '/access/members', ownerToken);
    expect(members.status).toBe(200);
    expect(members.body.results.map((m) => String(m._id))).toEqual(expect.arrayContaining([String(owner._id), String(otherAdmin._id), String(accountant._id)]));
    expect(members.body.results.find((m) => m.isOwner)._id).toBe(String(owner._id));

    // Suppliers and trips only: no reports, no dashboard
    expect((await api('put', `/access/members/${accountant._id}`, ownerToken).send({ permissions: ['purchases', 'unknown'] })).status).toBe(200);
    const me = await api('get', '/access/me', accountantToken);
    expect(me.body).toEqual({ isOwner: false, permissions: ['purchases'] });
    expect((await api('get', '/accounts', accountantToken)).status).toBe(200);
    expect((await api('get', '/bills', accountantToken)).status).toBe(200);
    expect((await api('get', '/dashboard', accountantToken)).status).toBe(403);
    expect((await api('get', '/reports/income-statement', accountantToken)).status).toBe(403);
    expect((await api('post', '/entries', accountantToken).send({})).status).toBe(403);
    expect((await api('put', `/access/members/${otherAdmin._id}`, accountantToken).send({ permissions: ['reports'] })).status).toBe(403);

    // The owner cannot be limited, and an empty list takes access away
    expect((await api('put', `/access/members/${owner._id}`, ownerToken).send({ permissions: [] })).status).toBe(400);
    await api('put', `/access/members/${accountant._id}`, ownerToken).send({ permissions: [] });
    expect((await api('get', '/access/me', accountantToken)).status).toBe(403);
  });
});
