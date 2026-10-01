const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { JournalEntry, MigrationRun, AccountingSettings, Counter } = require('../models');
const { SupplierBill } = require('../models/documents');
const migration = require('../services/migration');
const { runInTransaction } = require('../services/transaction');
const { createManualEntry } = require('../services/manualEntry');
const suspense = require('../services/suspense');
const summaries = require('../services/reports/summaries');
const vouchers = require('../services/vouchers');

beforeAll(startDb);
afterAll(stopDb);

const col = (name) => mongoose.connection.collection(name);
const d = (value) => new Date(value);
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;

// Two years of history, written straight into the collections like the old screens did
async function seedHistory() {
  const customer = (await col('users').insertOne({ firstName: 'سالم', lastName: 'الورفلي', customerId: 'L1', phone: 918000001 })).insertedId;
  const pkg1 = oid();
  const pkg2 = oid();
  const shipping = (await col('orders').insertOne({
    orderId: 'SHIP-1', user: customer, placedAt: 'tripoli', isShipment: true, isPayment: false, unsureOrder: false, isCanceled: false,
    shipment: { method: 'air' }, totalInvoice: 0,
    paymentList: [
      { _id: pkg1, status: { arrived: true, received: true }, deliveredPackages: { trackingNumber: 'TRK1', weight: { total: 10 }, exiosPrice: 10, deliveredInfo: {} } },
      { _id: pkg2, status: { arrived: true, received: true }, deliveredPackages: { trackingNumber: 'TRK2', weight: { total: 20 }, exiosPrice: 10, deliveredInfo: { deliveredDate: d('2025-01-10T10:00:00Z') } } },
    ],
    activity: [{ description: 'تم استلام العميل الطرد TRK1 بنجاح', createdAt: d('2024-03-12T09:00:00Z') }],
    createdAt: d('2024-03-01T08:00:00Z'), updatedAt: d('2025-01-10T10:00:00Z'),
  })).insertedId;
  await col('inventories').insertOne({
    voyage: 'AIR-2024-03', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', status: 'finished',
    orders: [{ paymentList: { _id: pkg1 } }, { paymentList: { _id: pkg2 } }],
    expenses: [{ _id: oid(), description: 'شحن جوي', amount: 150, currency: 'USD', rate: 0, date: d('2024-03-05T08:00:00Z') }],
    createdAt: d('2024-03-02T08:00:00Z'),
  });

  // Deposit and the delivery payment of package 1 (the delivery screen's statement + payment record)
  await col('userstatements').insertMany([
    { user: customer, createdBy: oid(), description: 'إيداع', amount: 300, currency: 'USD', total: 300, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: d('2024-03-10T08:00:00Z') },
    { user: customer, createdBy: oid(), description: 'تم دفع قيمة الشحن TRK1', note: 'SHIP-1', amount: 100, currency: 'USD', total: 200, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: d('2024-03-12T08:59:00Z') },
  ]);

  // Purchase order paid from the wallet (old style: statement + payment record, not linked)
  const purchase = (await col('orders').insertOne({
    orderId: 'PUR-1', user: customer, placedAt: 'benghazi', isPayment: true, isShipment: false, unsureOrder: false, isCanceled: false,
    totalInvoice: 500, paymentList: [], shipment: { method: 'air' },
    purchaseItems: [{ _id: oid(), description: 'شراء من مواقع', unitPrice: 430, currency: 'USD', date: d('2024-06-02T08:00:00Z') }],
    createdAt: d('2024-06-01T08:00:00Z'), updatedAt: d('2024-06-05T08:00:00Z'),
  })).insertedId;
  await col('userstatements').insertMany([
    { user: customer, createdBy: oid(), description: 'إيداع', amount: 500, currency: 'USD', total: 700, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'benghazi', createdAt: d('2024-06-04T08:00:00Z') },
    { user: customer, createdBy: oid(), description: 'دفع قيمة الفاتورة', amount: 500, currency: 'USD', total: 200, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: d('2024-06-05T08:00:00Z') },
  ]);
  await col('orderpaymenthistories').insertOne({ customer, order: purchase, createdBy: oid(), receivedAmount: 500, currency: 'USD', category: 'invoice', paymentType: 'wallet', createdAt: d('2024-06-05T08:00:00Z') });

  // Package 2 paid in dinars a year later; only the payment carries a rate (9) - the deposit
  // day has none and must take a derived one
  await col('userstatements').insertMany([
    { user: customer, createdBy: oid(), description: 'إيداع دينار', amount: 1800, currency: 'LYD', total: 1800, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: d('2025-01-05T08:00:00Z') },
    { user: customer, createdBy: oid(), description: 'تم دفع قيمة الشحن TRK2', note: 'SHIP-1', amount: 1800, currency: 'LYD', rate: 9, total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: d('2025-01-10T09:59:00Z') },
  ]);

  // Cash paid on an order with no office, old expense and income screens
  const cashOrder = (await col('orders').insertOne({
    orderId: 'SHIP-2', user: customer, placedAt: 'tripoli', isShipment: true, isPayment: false, unsureOrder: false, isCanceled: false, shipment: { method: 'sea' },
    paymentList: [{ _id: oid(), status: { received: false }, deliveredPackages: { trackingNumber: 'TRK3', weight: { total: 1 }, exiosPrice: 50 } }],
    createdAt: d('2025-02-01T08:00:00Z'), updatedAt: d('2025-02-01T08:00:00Z'),
  })).insertedId;
  await col('orderpaymenthistories').insertOne({ customer, order: cashOrder, createdBy: oid(), receivedAmount: 50, currency: 'USD', category: 'receivedGoods', paymentType: 'cash', list: [], createdAt: d('2025-02-02T08:00:00Z') });
  await col('expenses').insertOne({ placedAt: 'tripoli', cost: { currency: 'USD', total: 50 }, description: 'قرطاسية', createdAt: d('2024-07-01T08:00:00Z') });
  await col('incomes').insertOne({ office: 'tripoli', cost: { currency: 'USD', total: 20 }, description: 'بيع كراتين', createdAt: d('2024-07-02T08:00:00Z') });

  // What the system says the wallets hold now: USD 200 in history, but 210 in the wallet (a
  // manual change made long ago); LYD 0
  await col('wallets').insertMany([
    { user: customer, currency: 'USD', balance: 210 },
    { user: customer, currency: 'LYD', balance: 0 },
  ]);
  return { customer, shipping, purchase, pkg1, pkg2 };
}

const recognition = (orderId, packageId) => JournalEntry.findOne({ eventType: 'RECOGNITION', 'lines.arKey': `SHP:${orderId}:${packageId}` }).sort({ createdAt: 1 }).lean();
const yearOf = (report, year) => report.years.find((y) => y.year === year);

test('a wallet payment the replay cannot link to an order or debt has no claims (goes to suspense)', async () => {
  const { resolveClaimKeys } = require('../services/posting/operations');
  expect(await resolveClaimKeys(null)).toEqual([]);
  expect(await resolveClaimKeys(undefined)).toEqual([]);
});

describe('historical migration (scenarios 11 and 12)', () => {
  let history;
  beforeAll(async () => {
    await resetDb();
    history = await seedHistory();
  });

  test('dry run replays two years, dates and rates come from the fallbacks, wallets reconcile', async () => {
    const tripoliUsd = await account('110101');
    const run = await migration.startRun({ wait: true, config: { openingCounts: [{ accountId: tripoliUsd._id, amount: 1000 }] } });
    const done = await MigrationRun.findById(run._id).lean();
    expect(done.problems).toEqual([]);
    expect(done.status).toBe('review');
    const { report } = done;
    expect(report.balanced).toBe(true);

    // package 1 recognised on the activity date, package 2 on the typed delivery date
    expect((await recognition(history.shipping, history.pkg1)).day).toBe('2024-03-12');
    expect((await recognition(history.shipping, history.pkg2)).day).toBe('2025-01-10');
    expect(report.fallbacks.map((f) => f.message).join()).toMatch('سجل نشاط');

    const y2024 = yearOf(report, '2024');
    const y2025 = yearOf(report, '2025');
    expect(y2024.revenue).toBe(10000 + 50000 + 2000); // package 1, purchase invoice, old income
    expect(y2024.costOfSales).toBe(5000 + 43000); // package 1's share of the trip, supplier cost
    expect(y2024.expenses).toBe(5000); // old expense screen
    expect(y2025.revenue).toBe(20000);
    expect(y2025.costOfSales).toBe(10000);

    // the dinar deposit day had no rate: derived, listed in the report
    expect(report.rates.derived).toBeGreaterThan(0);
    expect(await getBalance((await account('220200'))._id, { partnerId: history.customer })).toEqual({ usd: 0, foreign: 0 });

    // wallet: the 10$ history cannot explain is adjusted and listed
    expect(report.walletDifferencesCount).toBe(1);
    expect(await getBalance((await account('220100'))._id, { partnerId: history.customer })).toMatchObject({ foreign: -21000 });

    // cash paid on an order without an office waits in suspense; trip cost was paid from suspense too
    expect(await SupplierBill.countDocuments({ isHistorical: true })).toBe(3);
    expect(report.suspenseBalance).not.toBe(0);

    // opening cash: Tripoli USD ends at the counted 1,000
    expect((await getBalance(tripoliUsd._id)).foreign).toBe(100000);
    expect(report.openingCash[0].counted).toBe(100000);
  });

  test('phase 6: the accounting view of an order, a trip and a customer, and a printed voucher', async () => {
    const order = await summaries.orderSummary(history.shipping);
    const pkg1 = order.claims.find((c) => String(c.packageId) === String(history.pkg1));
    expect(pkg1).toMatchObject({ kind: 'SHP', tracking: 'TRK1', delivered: true, billed: 10000, paid: 10000, open: 0, recognized: 10000, cost: 5000, profit: 5000 });
    expect(order.totals).toMatchObject({ billed: 30000, open: 0, recognized: 30000, cost: 15000, profit: 15000 });
    expect(order.entries.length).toBeGreaterThan(0);

    const purchase = await summaries.orderSummary(history.purchase);
    expect(purchase.totals).toMatchObject({ billed: 50000, recognized: 50000, cost: 43000, profit: 7000, costInProgress: 0 });
    expect(purchase.bills).toHaveLength(1);

    const tripDoc = await col('inventories').findOne({ voyage: 'AIR-2024-03' });
    const trip = await summaries.tripSummary(tripDoc._id);
    expect(trip.totals).toMatchObject({ revenue: 30000, cost: 15000, profit: 15000, margin: 50, costInProgress: 0, packages: 2, recognizedPackages: 2 });
    expect(trip.packages.map((p) => p.cost).sort((a, b) => a - b)).toEqual([5000, 10000]);
    expect(trip.bills[0]).toMatchObject({ usd: 15000 });

    const customer = await summaries.customerSummary(history.customer);
    expect(customer).toMatchObject({ owed: 0, matches: true, walletUsd: { ledger: 21000, system: 21000 }, walletLyd: { ledger: 0, system: 0 } });

    // a deposit prints as a receipt, numbered once; a wallet payment moved no cash
    const deposit = await JournalEntry.findOne({ eventType: 'DEPOSIT' }).sort({ day: 1 }).lean();
    const voucher = await runInTransaction((session) => vouchers.getVoucher(deposit._id, { session }));
    expect(voucher).toMatchObject({ kind: 'receipt', number: 'RV/2024/0001', totalUsd: 30000, party: { type: 'customer', customerId: 'L1' } });
    expect((await runInTransaction((session) => vouchers.getVoucher(deposit._id, { session }))).number).toBe('RV/2024/0001');
    const payment = await JournalEntry.findOne({ eventType: 'WALLET_PAYMENT' }).lean();
    await expect(runInTransaction((session) => vouchers.getVoucher(payment._id, { session }))).rejects.toThrow('لم يحرّك');
  });

  test('while the run waits for review, nothing else can be posted in the historical period', async () => {
    const cash = await account('110101');
    const capital = await account('310000');
    await expect(runInTransaction((session) => createManualEntry({
      date: '2024-05-01', description: 'x',
      lines: [{ accountId: cash._id, side: 'debit', amount: 1, office: 'tripoli' }, { accountId: capital._id, side: 'credit', amount: 1 }],
    }, { session }))).rejects.toThrow('محجوزة');
  });

  test('discard removes everything, and a second run gives exactly the same books', async () => {
    const first = await MigrationRun.findOne({ status: 'review' });
    const firstYears = first.report.years;
    const firstEntries = first.report.entries;
    await migration.discardRun(first.runId);
    expect(await JournalEntry.countDocuments()).toBe(0);
    expect(await SupplierBill.countDocuments()).toBe(0);
    expect(await Counter.countDocuments({ _id: /^JE:/ })).toBe(0);
    const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
    expect(settings.migrationGuardDay).toBeNull();

    const second = await migration.startRun({ wait: true, config: { openingCounts: [{ accountId: (await account('110101'))._id, amount: 1000 }] } });
    const again = await MigrationRun.findById(second._id).lean();
    expect(again.report.years).toEqual(firstYears);
    expect(again.report.entries).toBe(firstEntries);
    // numbering restarted from 1 after the discard
    expect(await JournalEntry.exists({ number: /\/2024\/000001$/ })).toBeTruthy();
  });

  test('commit catches up what happened during the review and turns live posting on', async () => {
    const run = await MigrationRun.findOne({ status: 'review' });
    // a deposit made while the report was being reviewed
    await col('userstatements').insertOne({
      user: history.customer, createdBy: oid(), description: 'إيداع بعد التشغيل', amount: 40, currency: 'USD', total: 250,
      paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date(),
    });
    const committed = await migration.commitRun(run.runId);
    expect(committed.status).toBe('committed');
    expect(committed.report.catchUp.events).toBe(1);
    invalidateConfig();
    const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
    expect(settings.liveEnabled).toBe(true);
    expect(settings.migrationDate).toBeTruthy();
    expect(await balanceOf('110101')).toBe(100000 + 4000);
    await expect(migration.startRun({ wait: true })).rejects.toThrow('اعتُمد');
  });

  test('what history left in suspense is a work list the accountant settles item by item', async () => {
    const before = await suspense.listOpen();
    expect(before.count).toBeGreaterThan(0);
    expect(before.groups.reduce((sum, g) => sum + g.count, 0)).toBe(before.count);
    const item = before.results[0];
    const cash = await account('110101');
    const cashBefore = await balanceOf('110101');
    await runInTransaction((session) => suspense.settleItem(item.id, { accountId: cash._id, note: 'خزينة طرابلس' }, { session }));
    const after = await suspense.listOpen();
    expect(after.count).toBe(before.count - 1);
    expect(after.net).toBe(before.net - (item.debit - item.credit));
    expect(await balanceOf('110101')).toBe(cashBefore + item.debit - item.credit);
    // the same item cannot be settled twice
    await expect(runInTransaction((session) => suspense.settleItem(item.id, { accountId: cash._id }, { session }))).rejects.toThrow('مسبقاً');
  });
});

describe('starting from the counted balances', () => {
  test('closeSuspense folds the historical suspense into the opening balance', async () => {
    await resetDb();
    await seedHistory();
    const run = await migration.startRun({ wait: true, config: { closeSuspense: true, openingCounts: [{ accountId: (await account('110101'))._id, amount: 1000 }] } });
    const { report, problems } = await MigrationRun.findById(run._id).lean();
    expect(problems).toEqual([]);
    expect(report.suspenseClosed).not.toBe(0);
    expect(report.suspenseBalance).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.suspenseBreakdown.length).toBeGreaterThan(0);
    expect((await getBalance((await account('110101'))._id)).foreign).toBe(100000);
    expect((await suspense.listOpen()).count).toBe(0);
  });

  test('a count taken on a chosen day fixes the balance at the end of that day', async () => {
    await resetDb();
    await seedHistory();
    const cash = await account('110101');
    // 1,000 counted on 2024-03-31; the 20 income and the 50 expense of July come after it
    const run = await migration.startRun({ wait: true, config: { countDay: '2024-03-31', openingCounts: [{ accountId: cash._id, amount: 1000 }] } });
    const { report, problems } = await MigrationRun.findById(run._id).lean();
    expect(problems).toEqual([]);
    expect(report.openingCash[0]).toMatchObject({ countDay: '2024-03-31', counted: 100000, booked: 30000, opening: 70000 });
    expect((await getBalance(cash._id, { upToDay: '2024-03-31' })).foreign).toBe(100000);
    expect((await getBalance(cash._id)).foreign).toBe(100000 + 2000 - 5000);
  });
});
