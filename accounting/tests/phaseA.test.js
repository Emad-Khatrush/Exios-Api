// Phase A of the V6 decisions: trip cost by weight, domestic trips, Alipay transfers, debt
// sources, supplier refunds, cancelling in a closed period, the settings rate, trip deletion,
// and the new daily checks.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid, post: postRaw } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { Vendor, SupplierBill } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const operations = require('../services/posting/operations');
const payables = require('../services/posting/payables');
const { cancelDocument } = require('../services/cancel');
const { refreshTripPackages } = require('../services/tripLinks');
const { tripDeletionBlockers } = require('../services/tripGuards');
const { recordSettingsRate } = require('../services/settingsRate');
const { CHECKS } = require('../services/reports/exceptions');
const { today } = require('../services/dates');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const UserStatement = require('../../models/userStatement');
const Balance = require('../../models/balance');
const ExchangeRate = require('../../models/exchangeRate');

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
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 9 }, { currency: 'CNY', day: '2026-01-01', rate: 7.2 }]);
});

let seq = 0;
const newCustomer = async () => {
  seq++;
  return (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: String(seq), customerId: `A${seq}`, phone: 920000000 + seq })).insertedId;
};

async function newOrder({ user, isPayment = false, isRemittance = false, totalInvoice = 0, packages = [] }) {
  const paymentList = packages.map((p) => ({
    _id: oid(),
    status: { arrived: true, arrivedLibya: true, paid: false, received: !!p.received },
    deliveredPackages: { trackingNumber: `T${Math.random().toString(36).slice(2, 7)}`, weight: { total: p.weight, measureUnit: 'KG' }, exiosPrice: p.price, shipmentMethod: 'air' },
  }));
  const { insertedId } = await Order.collection.insertOne({
    orderId: `O${Date.now()}${Math.random().toString(36).slice(2, 6)}`, user, placedAt: 'tripoli', isPayment, isShipment: !isPayment, isRemittance,
    totalInvoice, unsureOrder: false, isCanceled: false, shipment: { method: 'air' }, paymentList, createdAt: new Date('2026-01-02'),
  });
  return { _id: insertedId, packageIds: paymentList.map((p) => p._id) };
}

const newTrip = async (packageIds, shippingType = 'air') => {
  const { insertedId } = await Inventory.collection.insertOne({
    voyage: `${shippingType}-${Math.random().toString(36).slice(2, 6)}`, inventoryType: 'inventoryGoods', shippingType, inventoryPlace: 'tripoli', status: 'processing',
    orders: packageIds.map((id) => ({ paymentList: { _id: id } })), createdAt: new Date(),
  });
  await refreshTripPackages(insertedId);
  return insertedId;
};

const statement = (user, fields) => UserStatement.create({
  user, createdBy: oid(), description: 'حركة', total: 0, paymentType: 'wallet', createdAt: new Date('2026-01-05'), ...fields,
});
const deposit = (user, amount, currency = 'USD', extra = {}) => statement(user, { amount, currency, calculationType: '+', actionType: 'cash', office: 'tripoli', ...extra });
const spend = (user, amount, currency = 'USD', extra = {}) => statement(user, { amount, currency, calculationType: '-', actionType: 'wallet', ...extra });
const post = (doc, options = {}) => tx((session) => operations.postStatement(doc._id, { session, ...options }));
const sync = (orderId) => tx((session) => syncOrder(orderId, { session }));
const deliver = async (orderId, packageId) => {
  await Order.updateOne({ _id: orderId, 'paymentList._id': packageId }, { $set: { 'paymentList.$.status.received': true } });
  return sync(orderId);
};
const bill = (input) => tx((session) => payables.createBill({ day: '2026-01-03', currency: 'USD', ...input }, { session, req }));

test('s40: a trip cost is shared by weight, so the profit shows the price difference', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 100, price: 5 }, { weight: 100, price: 8 }] });
  const [cheap, dear] = order.packageIds;
  const trip = await newTrip([cheap, dear]);
  const carrier = await Vendor.create({ name: 'ناقل', type: 'carrier' });
  await bill({ vendorId: carrier._id, lines: [{ description: 'شحن', amount: 1000, target: 'trip', tripId: trip }] });
  await sync(order._id);
  await post(await deposit(user, 1300));
  await post(await spend(user, 1300), { target: { orderId: order._id, packageIds: [cheap, dear] } });
  await deliver(order._id, cheap);
  expect(await balanceOf('410100')).toBe(-50000);
  expect(await balanceOf('510100')).toBe(50000); // profit 0
  await deliver(order._id, dear);
  expect(await balanceOf('410100')).toBe(-130000);
  expect(await balanceOf('510100')).toBe(100000); // 500 + 500: profit 300 on the second
  expect(await balanceOf('130100')).toBe(0);
});

// v8 replaced decision 62: a domestic trip's cost waits in progress and is shared over the packages
// it took on, recognised on 510300 with them
test('a domestic trip cost is shared over its own packages and recognised with them', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 100, price: 10 }] });
  const [pkg] = order.packageIds;
  const flight = await newTrip([pkg], 'air');
  const truck = await newTrip([pkg], 'domestic');
  const saved = await Order.findById(order._id).lean();
  expect(String(saved.paymentList[0].tripId)).toBe(String(flight));
  expect(String(saved.paymentList[0].domesticTripId)).toBe(String(truck));

  const carrier = await Vendor.create({ name: 'ناقل', type: 'carrier' });
  await bill({ vendorId: carrier._id, lines: [{ description: 'شحن جوي', amount: 500, target: 'trip', tripId: flight }] });
  await bill({ vendorId: carrier._id, lines: [{ description: 'نقل داخلي', amount: 80, target: 'trip', tripId: truck }] });
  expect(await balanceOf('510300')).toBe(0);
  expect(await balanceOf('130100')).toBe(58000);

  await post(await deposit(user, 1000));
  await post(await spend(user, 1000), { target: { orderId: order._id, packageIds: [pkg] } });
  await deliver(order._id, pkg);
  expect(await balanceOf('410100')).toBe(-100000);
  expect(await balanceOf('510100')).toBe(50000);
  expect(await balanceOf('510300')).toBe(8000);
  expect(await balanceOf('130100')).toBe(0);
});

test('s45: an Alipay transfer order, paid in yuan from Alipay at its average rate, is remittance revenue and cost', async () => {
  const alipay = await account('110301');
  const box = await account('110101');
  // Alipay holds 6600 yuan that cost 1000$ (rate 6.6)
  await postRaw({
    eventType: 'MANUAL', eventKey: 'TEST:ALIPAY', date: '2026-01-02', description: 'شراء يوان',
    lines: [
      { accountId: alipay._id, debit: 100000, currency: 'CNY', amountCurrency: 660000 },
      { accountId: box._id, credit: 100000, office: 'tripoli' },
    ],
  });
  const user = await newCustomer();
  const order = await newOrder({ user, isPayment: true, isRemittance: true, totalInvoice: 1000 });
  const supplier = await Vendor.create({ name: 'مورد العميل', type: 'supplier' });
  const sent = await bill({ vendorId: supplier._id, currency: 'CNY', paidImmediatelyFrom: alipay._id, lines: [{ description: 'حوالة 6500 يوان', amount: 6500, target: 'order', orderId: order._id }] });
  expect(sent.totalUsd).toBe(98485);
  expect(sent.rate).toBeCloseTo(6.6, 4);
  await sync(order._id);
  await post(await deposit(user, 1000));
  await post(await spend(user, 1000), { target: { orderId: order._id, category: 'invoice' } });
  expect(await balanceOf('410700')).toBe(-100000);
  expect(await balanceOf('510700')).toBe(98485);
  expect(await balanceOf('410300')).toBe(0);
  expect(await balanceOf('710100')).toBe(0); // no exchange difference
  expect(await getBalance(alipay._id)).toEqual({ usd: 100000 - 98485, foreign: 10000 });
});

test('a debt says where its money came from; one without a source goes to suspense, never to revenue', async () => {
  const user = await newCustomer();
  const box = await account('110101');
  const make = (extra) => Balance.create({
    owner: user, createdBy: oid(), createdOffice: 'tripoli', balanceType: 'debt', amount: 50, initialAmount: 50, currency: 'USD', notes: 'ضريبة', ...extra,
  });
  const fromBox = await make({ source: { kind: 'cash', accountId: box._id } });
  await tx((session) => operations.postGeneralDebt(fromBox._id, { session }));
  expect(await balanceOf('110101')).toBe(-5000);
  expect(await balanceOf('121000')).toBe(5000);

  const wasl = await account('110401');
  const fromPartner = await make({ source: { kind: 'partner', accountId: wasl._id } });
  await tx((session) => operations.postGeneralDebt(fromPartner._id, { session }));
  expect(await balanceOf('110401')).toBe(-5000);

  const old = await make({});
  await tx((session) => operations.postGeneralDebt(old._id, { session }));
  expect(await balanceOf('399000')).toBe(-5000);
  expect(await balanceOf('410600')).toBe(0);
});

test('s46 (wallet side): a supplier refund tied to an order lowers its sale, not a general expense', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, isPayment: true, totalInvoice: 200 });
  const supplier = await Vendor.create({ name: 'Alibaba', type: 'supplier' });
  await bill({ vendorId: supplier._id, lines: [{ description: 'شراء', amount: 180, target: 'order', orderId: order._id }] });
  await sync(order._id);
  await post(await deposit(user, 200));
  await post(await spend(user, 200), { target: { orderId: order._id, category: 'invoice' } });
  expect(await balanceOf('410300')).toBe(-20000);

  const refund = await deposit(user, 29, 'USD', { actionType: 'refund', office: undefined });
  await post(refund, { target: { orderId: order._id } });
  expect(await balanceOf('410300')).toBe(-17100);
  expect(await balanceOf('520200')).toBe(0);
  expect(await balanceOf('220100', { partnerId: user })).toBe(-2900);
  expect(await balanceOf('121000')).toBe(0);
  expect(await balanceOf('220300')).toBe(0);

  // Not tied to an order: still a refund expense
  await post(await deposit(user, 5, 'USD', { actionType: 'refund' }));
  expect(await balanceOf('520200')).toBe(500);
});

test('a document of a closed period is cancelled by the owner only', async () => {
  const vendor = await Vendor.create({ name: 'مكتب', type: 'service' });
  const expense = await account('530800');
  const posted = await bill({ vendorId: vendor._id, lines: [{ description: 'قرطاسية', amount: 10, target: 'expense', accountId: expense._id, office: 'tripoli' }] });
  await setSettings({ lockDate: '2026-01-31' });
  const clerk = { _id: oid(), roles: { isAccountant: true } };
  await expect(tx((session) => cancelDocument('AccountingSupplierBill', posted._id, { session, req: { user: clerk }, reason: 'خطأ' })))
    .rejects.toMatchObject({ statusCode: 403 });
  await tx((session) => cancelDocument('AccountingSupplierBill', posted._id, { session, req, reason: 'خطأ' }));
  expect((await SupplierBill.findById(posted._id)).status).toBe('canceled');
});

test('the settings rate is the only dinar rate: saving it writes today\'s accounting rate, even one already used', async () => {
  await recordSettingsRate(9.5);
  const day = today();
  expect((await CurrencyRate.findOne({ currency: 'LYD', day })).rate).toBe(9.5);
  expect((await ExchangeRate.findOne({ fromCurrency: 'usd' })).rate).toBe(9.5);
  await CurrencyRate.updateOne({ currency: 'LYD', day }, { $set: { isUsed: true } });
  await recordSettingsRate(9.6);
  expect((await CurrencyRate.findOne({ currency: 'LYD', day })).rate).toBe(9.6);
});

test('a trip with packages or costs cannot be deleted; an empty one can', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 1, price: 1 }] });
  const full = await Inventory.findById(await newTrip(order.packageIds)).lean();
  expect((await tripDeletionBlockers(full)).length).toBeGreaterThan(0);
  const empty = await Inventory.findById(await newTrip([])).lean();
  expect(await tripDeletionBlockers(empty)).toEqual([]);
});

test('daily checks: a wallet deduction without its entry, and an operation after the cutoff never recorded', async () => {
  const user = await newCustomer();
  await setSettings({ migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01T00:00:00Z') });
  const payment = await spend(user, 10);
  expect((await CHECKS.walletDeductions()).count).toBe(1);
  expect((await CHECKS.liveCoverage()).count).toBe(1);
  await post(await deposit(user, 10));
  await post(payment);
  expect((await CHECKS.walletDeductions()).count).toBe(0);
});
