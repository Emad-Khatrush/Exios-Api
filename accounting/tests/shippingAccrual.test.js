const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');
const { getBalance } = require('../services/carrying');
const { AccountingSettings, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const operations = require('../services/posting/operations');
const payables = require('../services/posting/payables');
const { tripSummary } = require('../services/reports/summaries');
const recognition = require('../services/shippingRecognition');
const review = require('../services/accountingReview');
const { reverseEntry } = require('../services/ledger');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Statement = require('../../models/userStatement');

beforeAll(startDb);
afterAll(stopDb);
const tx = fn => runInTransaction(fn);
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const sync = options => tx(session => syncOrder(order, { session, ...options }));
const balance = async code => (await getBalance((await account(code))._id)).usd;
let order, user, trip, vendor, packages;
async function cost(amount, day = '2026-10-28') {
  return tx(session => payables.createBill({ vendorId: vendor._id, day, currency: 'USD',
    lines: [{ target: 'trip', tripId: trip, amount, description: 'Carrier cost' }] }, { session, req }));
}
async function deliver(index, value = true, options) {
  await Order.updateOne({ _id: order, 'paymentList._id': packages[index] }, { $set: { 'paymentList.$.status.received': value } });
  await sync(options);
}
async function pay(amount, index = 0) {
  for (const calculationType of ['+', '-']) {
    const statement = await Statement.create({ user, createdBy: req.user._id, description: 'Shipping payment',
      total: 0, paymentType: 'wallet', createdAt: new Date('2026-10-28'), amount, currency: 'USD',
      calculationType, actionType: calculationType === '+' ? 'cash' : 'wallet', office: 'tripoli' });
    await tx(session => operations.postStatement(statement._id, { session,
      ...(calculationType === '-' && { target: { orderId: order, packageIds: [packages[index]] } }) }));
  }
}
beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  user = (await mongoose.connection.collection('users').insertOne({ firstName: 'Customer', customerId: 'S1' })).insertedId;
  trip = oid(); packages = [oid(), oid()];
  order = (await Order.collection.insertOne({ orderId: 'SHIP-TEST', user, placedAt: 'tripoli', isPayment: false,
    isShipment: true, orderStatus: 0, shipment: { method: 'air' }, createdAt: new Date('2026-09-01'),
    paymentList: packages.map((_id, i) => ({ _id, tripId: trip, status: { received: false },
      deliveredPackages: { trackingNumber: `TRACK${i}`, weight: { total: (i + 1) * 10, measureUnit: 'KG' }, exiosPrice: 10, shipmentMethod: 'air' } })) })).insertedId;
  await Inventory.collection.insertOne({ _id: trip, voyage: 'AIR-TEST', inventoryType: 'inventoryGoods', shippingType: 'air',
    inventoryPlace: 'tripoli', orders: packages.map(_id => ({ paymentList: { _id } })), createdAt: new Date('2026-09-01') });
  vendor = await Vendor.create({ name: 'Carrier', type: 'carrier' });
});
afterEach(async () => {
  for (const entry of await JournalEntry.find().lean()) {
    expect(entry.lines.reduce((sum, line) => sum + (line.debit || 0) - (line.credit || 0), 0)).toBe(0);
  }
});

test('partial collection does not prorate revenue/cost; undelivered shares remain in WIP; later cash adds no profit', async () => {
  await cost(180);
  await pay(80);
  expect(await balance('410100')).toBe(0);
  await deliver(0);
  let report = await tripSummary(trip);
  expect(report.totals).toMatchObject({ revenue: 10000, cost: 6000, costInProgress: 12000, profit: 4000, collected: 8000, open: 22000 });
  expect(report.packages.find(p => String(p.packageId) === String(packages[0])).open).toBe(2000);
  await pay(20);
  expect(await balance('410100')).toBe(-10000);
  expect(await balance('510100')).toBe(6000);
  await deliver(1);
  report = await tripSummary(trip);
  expect(report.totals).toMatchObject({ revenue: 30000, cost: 18000, costInProgress: 0, profit: 12000, collected: 10000, open: 20000 });
  const count = await JournalEntry.countDocuments();
  await sync();
  expect(await JournalEntry.countDocuments()).toBe(count);
});

test('unpaid delivery recognises its full share; late carrier bills adjust delivered cost only', async () => {
  await cost(180);
  await deliver(0);
  await cost(30);
  expect((await tripSummary(trip)).totals).toMatchObject({ revenue: 10000, cost: 7000, costInProgress: 14000, profit: 3000 });
  await deliver(0, false);
  expect(await balance('410100')).toBe(0);
  expect(await balance('510100')).toBe(0);
  expect(await balance('130100')).toBe(21000);
});

test('free offer has zero shipping revenue and its full delivered cost belongs to the purchase order', async () => {
  await Order.updateOne({ _id: order }, { $set: { isPayment: true, totalInvoice: 500, orderStatus: 1,
    'paymentList.0.freeShippingOffer': { enabled: true } } });
  await cost(180);
  await deliver(0);
  expect(await balance('410100')).toBe(0);
  expect(await balance('510400')).toBe(6000);
  expect(await balance('130100')).toBe(12000);
});

test('legacy preview/apply preserves receivables, wallet, purchase revenue and original journals', async () => {
  await cost(180);
  await Order.updateOne({ _id: order }, { $set: { isPayment: true, totalInvoice: 500, orderStatus: 1 } });
  await deliver(0, true, { isHistorical: true });
  expect(await balance('410100')).toBe(0);
  const originals = await JournalEntry.find().select('_id day lines').lean();
  const ar = await balance('121000'), wallet = await balance('220100');
  const preview = await recognition.review();
  expect(preview).toMatchObject({ packages: 1, revenueToRecognize: 10000, costToRecognize: 6000, profitImpact: 4000 });
  await recognition.apply({ orderIds: [String(order)], fingerprint: preview.fingerprint }, req);
  expect(await balance('410100')).toBe(-10000);
  expect(await balance('510100')).toBe(6000);
  expect(await balance('410300')).toBe(0); // Review must not adopt the purchase recognition change.
  expect(await balance('121000')).toBe(ar);
  expect(await balance('220100')).toBe(wallet);
  expect((await recognition.review()).rows).toHaveLength(0);
  for (const entry of originals) expect(await JournalEntry.findById(entry._id).select('_id day lines').lean()).toEqual(entry);
  await expect(recognition.apply({ orderIds: [String(order)], fingerprint: preview.fingerprint }, req)).rejects.toThrow();
});

test('cost-only legacy differences are previewed without recognising the sale twice', async () => {
  await cost(180);
  await deliver(0);
  const entry = await JournalEntry.findOne({ eventType: 'COST_RECOGNITION' });
  await tx(session => reverseEntry(entry._id, { session, user: req.user, reason: 'Test missing cost' }));
  const preview = await recognition.review();
  expect(preview).toMatchObject({ packages: 1, revenueToRecognize: 0, costToRecognize: 6000, profitImpact: -6000 });
  await recognition.apply({ orderIds: [String(order)], fingerprint: preview.fingerprint }, req);
  expect(await balance('410100')).toBe(-10000);
  expect(await balance('510100')).toBe(6000);
});

test('cost review makes completed trip reviewed, and a late cost reopens the review', async () => {
  await cost(180);
  await deliver(0); await deliver(1);
  expect((await tripSummary(trip)).profitStatus).toBe('provisional');
  await tx(session => review.certifyTrip(trip, {}, { session, req }));
  expect((await tripSummary(trip)).profitStatus).toBe('reviewed');
  await cost(30);
  const report = await tripSummary(trip);
  expect(report.profitStatus).toBe('provisional');
  expect(report.costReview.changedSinceReview).toBe(true);
});

test('month end includes WIP from previous months even without new revenue', async () => {
  await cost(180, '2026-08-28');
  const report = await review.queue({ from: '2026-09-01', to: '2026-09-30', storedChecks: true });
  expect(report.allItems.find(i => i.key === `tripProgress:${trip}:2026-09-30`)).toMatchObject({ blocking: false, reviewTripId: String(trip) });
  expect(report.allItems.find(i => i.key === `tripCost:${trip}`)).toBeDefined();
});

test('a live transition keeps its effective date for historical replay, and closed periods are preserved', async () => {
  await cost(180);
  await deliver(0, true, { isHistorical: true });
  expect(await balance('410100')).toBe(0);
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-10-31' } });
  invalidateConfig();
  const preview = await recognition.review();
  const outcome = await recognition.apply({ orderIds: [String(order)], fingerprint: preview.fingerprint }, req);
  expect(outcome.day).toBe('2026-11-01');
  const entries = await JournalEntry.find({ eventType: { $in: ['RECOGNITION', 'COST_RECOGNITION'] } }).lean();
  expect(entries.every(e => e.day === '2026-11-01')).toBe(true);
  expect((await Order.findById(order).lean()).paymentList[0].shippingRecognitionFrom.toISOString().slice(0, 10)).toBe('2026-11-01');
  const count = await JournalEntry.countDocuments();
  await sync({ isHistorical: true, date: '2026-11-01' });
  expect(await JournalEntry.countDocuments()).toBe(count);
});

test('unpaid domestic transport and customs fees are earned on delivery independently of collection', async () => {
  await Order.updateOne({ _id: order }, { $set: {
    'paymentList.0.deliveredPackages.domesticFee': { usd: 15 },
    'paymentList.0.deliveredPackages.customsFee': { usd: 7 },
  } });
  await cost(180);
  await deliver(0);
  expect(await balance('220400')).toBe(-20000); // Only the undelivered second package stays deferred.
  const summary = await require('../services/reports/summaries').orderSummary(order);
  expect(summary.claims.find(c => c.kind === 'DOM')).toMatchObject({ recognized: 1500, open: 1500 });
  expect(summary.claims.find(c => c.kind === 'CUS')).toMatchObject({ recognized: 700, open: 700 });
});

test('cancelling an unpaid order unwinds revenue/cost and keeps the carrier obligation in WIP', async () => {
  await cost(180);
  await deliver(0);
  await Order.updateOne({ _id: order }, { $set: { isCanceled: true } });
  await sync();
  expect(await balance('410100')).toBe(0);
  expect(await balance('510100')).toBe(0);
  expect(await balance('130100')).toBe(18000);
  expect(await balance('121000')).toBe(0);
});

test('concurrent attempts to apply the same reviewed legacy correction post it only once', async () => {
  await cost(180);
  await deliver(0, true, { isHistorical: true });
  const preview = await recognition.review();
  const input = { orderIds: [String(order)], fingerprint: preview.fingerprint };
  const results = await Promise.allSettled([recognition.apply(input, req), recognition.apply(input, req)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(await balance('410100')).toBe(-10000);
  expect(await balance('510100')).toBe(6000);
});
