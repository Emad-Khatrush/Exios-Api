const { startDb, stopDb, resetDb, oid } = require('./helpers');
const Order = require('../../models/order');
const User = require('../../models/user');
const Inventory = require('../../models/inventory');
const { AccountingSettings, JournalEntry } = require('../models');
const { list } = require('../../controllers/xTracking');
const { getTapTypeQuery } = require('../../middleware/helper');

let ar;
beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb({ setup: false }); ar = oid();
  await AccountingSettings.create({ key: 'main', accountRoles: { customer_receivable: ar } });
});
const order = (orderId, fields = {}) => Order.create({ orderId, customerInfo: { fullName: 'Example customer' },
  placedAt: 'tripoli', shipment: { fromWhere: 'CN', toWhere: 'LY', method: 'air' }, isPayment: true, ...fields });
async function claim(o, billed = 10000, open = billed) {
  const dims = { accountId: ar, orderId: o._id, arKey: `PUR:${o._id}` };
  await JournalEntry.collection.insertMany([
    { number: `${o.orderId}-CLAIM`, eventKey: `${o.orderId}-CLAIM`, eventType: 'CLAIM', status: 'posted', lines: [{ ...dims, debit: billed, credit: 0 }] },
    { number: `${o.orderId}-PAY`, eventKey: `${o.orderId}-PAY`, eventType: 'PAYMENT', status: 'posted', lines: [{ ...dims, debit: 0, credit: billed - open }] },
  ]);
}
const fetch = query => new Promise((resolve, reject) => list({ query }, { json: resolve }, reject));

test('waiting purchase uses exactly the original Unpaid stage, regardless of receivable balance', async () => {
  const waiting = await order('WAIT', { orderStatus: 0 }); await claim(waiting, 10000, 0);
  await order('SHIPPING', { isPayment: false, isShipment: true, orderStatus: 0 });
  await order('PURCHASED', { orderStatus: 1 });
  await order('UNSURE', { orderStatus: 0, unsureOrder: true });
  await order('CANCELED', { orderStatus: 0, isCanceled: true });
  const expected = await Order.find(getTapTypeQuery('unpaid')).lean();
  const data = await fetch({ stage: 'waitingPurchase' });
  expect(data.orders.map(o => String(o._id))).toEqual(expected.map(o => String(o._id)));
  expect(data.orders[0].paymentState).toBe('paid');
});

test('category and payment selectors combine instead of replacing each other', async () => {
  const paid = await order('PUR-PAID'); await claim(paid, 10000, 0);
  const partial = await order('PUR-PARTIAL'); await claim(partial, 10000, 3000);
  const shipping = await order('SHIP-PARTIAL', { isPayment: false, isShipment: true }); await claim(shipping, 10000, 5000);
  const data = await fetch({ stage: 'purchase', payment: 'partial' });
  expect(data.total).toBe(1); expect(data.orders[0].orderId).toBe('PUR-PARTIAL');
  expect((await fetch({ stage: 'shipping', payment: 'paid' })).total).toBe(0);
  expect((await fetch({ stage: 'purchase', payment: 'all' })).total).toBe(2);
});

test('tracking search is literal, case insensitive, and returns each order once', async () => {
  await order('SEARCH', { isShipment: true, paymentList: Array.from({ length: 4 }, (_, i) => ({
    deliveredPackages: { trackingNumber: i < 2 ? 'TR[123]' : `OTHER-${i}`, arrivedAt: new Date(2026, 9, i + 1) },
  })) });
  await order('EXCLUDED', { paymentList: [{ deliveredPackages: { trackingNumber: 'TR1123' } }] });
  const data = await fetch({ searchType: 'trackingNumber', search: 'tr[123]' });
  expect(data.total).toBe(1); expect(data.orders).toHaveLength(1);
  expect(data.orders[0].packages).toHaveLength(3);
  expect(data.orders[0].matchedTrackings).toContain('TR[123]');
  expect((await fetch({ searchType: 'orderId', search: 'SEARCH' })).orders[0].orderId).toBe('SEARCH');
});

test('successive twenty-order pages have stable unique IDs and the same total', async () => {
  await Order.insertMany(Array.from({ length: 23 }, (_, i) => ({ orderId: `PAGE-${i}`, customerInfo: { fullName: 'Customer' },
    placedAt: 'tripoli', shipment: { fromWhere: 'CN', toWhere: 'LY' }, isPayment: true, createdAt: new Date('2026-10-01') })));
  const first = await fetch({ limit: '20' }); const next = await fetch({ skip: '20', limit: '20' });
  expect(first.orders).toHaveLength(20); expect(next.orders).toHaveLength(3);
  expect(first.total).toBe(23); expect(next.total).toBe(23);
  expect(new Set([...first.orders, ...next.orders].map(o => String(o._id))).size).toBe(23);
});

test('category counts respect payment selection while payment counts respect category', async () => {
  const paid = await order('PUR-PAID'); await claim(paid, 10000, 0);
  const partial = await order('PUR-PARTIAL'); await claim(partial, 10000, 3000);
  const shipping = await order('SHIP-UNPAID', { isPayment: false, isShipment: true }); await claim(shipping);
  const data = await fetch({ stage: 'purchase', payment: 'partial', countsOnly: 'true' });
  expect(data.counts.all).toBe(1); expect(data.counts.purchase).toBe(1); expect(data.counts.shipping).toBe(0);
  expect(data.paymentCounts.all).toBe(2); expect(data.paymentCounts.paid).toBe(1); expect(data.paymentCounts.partial).toBe(1);
});

test('Exios search accepts order number, saved customer name, current full name and customer code', async () => {
  const user = await User.create({ username: 'test-customer', customerId: 'T388', firstName: 'Mosab', lastName: 'Almezoghi', phone: 9000001, password: 'test-only-password' });
  await order('2105-6725', { user: user._id, customerInfo: { fullName: 'مصعب المزوقي' } });
  await order('OTHER');
  for (const search of ['2105-6725', 'مصعب', 'Mosab Almezoghi', 't388']) {
    const data = await fetch({ searchType: 'orderId', search });
    expect(data.orders.map(o => o.orderId)).toEqual(['2105-6725']);
    const totals = await fetch({ searchType: 'orderId', search, countsOnly: 'true' });
    expect(totals.counts.all).toBe(data.total);
  }
});

test('tracking mode does not match order numbers, names or customer codes', async () => {
  const user = await User.create({ username: 'test-customer', customerId: 'T388', firstName: 'Mosab', lastName: 'Almezoghi', phone: 9000001, password: 'test-only-password' });
  await order('2105-6725', { user: user._id, customerInfo: { fullName: 'مصعب المزوقي' }, paymentList: [{ deliveredPackages: { trackingNumber: 'TRACK-ONLY' } }] });
  for (const search of ['2105-6725', 'مصعب', 'Mosab', 'T388']) expect((await fetch({ searchType: 'trackingNumber', search })).total).toBe(0);
  expect((await fetch({ searchType: 'trackingNumber', search: 'track-only' })).total).toBe(1);
});

test('quick pages load ten records and determine hasMore without computing the total', async () => {
  await Order.insertMany(Array.from({ length: 23 }, (_, i) => ({ orderId: `FAST-${i}`, customerInfo: { fullName: 'Customer' },
    placedAt: 'tripoli', shipment: { fromWhere: 'CN', toWhere: 'LY' }, isPayment: true, createdAt: new Date('2026-10-01') })));
  const first = await fetch({ quick: 'true' });
  const next = await fetch({ quick: 'true', skip: '10' });
  const last = await fetch({ quick: 'true', skip: '20' });
  expect(first.orders).toHaveLength(10); expect(next.orders).toHaveLength(10); expect(last.orders).toHaveLength(3);
  expect(first.total).toBeNull(); expect(first.totalExact).toBe(false);
  expect(first.hasMore).toBe(true); expect(next.hasMore).toBe(true); expect(last.hasMore).toBe(false);
  expect(new Set([...first.orders, ...next.orders, ...last.orders].map(o => String(o._id))).size).toBe(23);
  expect((await fetch({ countsOnly: 'true' })).counts.all).toBe(23);
});

test('quick financial filters produce the same results as the exact list', async () => {
  const paid = await order('QUICK-PAID'); await claim(paid, 10000, 0);
  const partial = await order('QUICK-PARTIAL'); await claim(partial, 10000, 3000);
  const shipping = await order('QUICK-SHIP', { isPayment: false, isShipment: true }); await claim(shipping, 10000, 5000);
  const full = await fetch({ stage: 'purchase', payment: 'partial' });
  const quick = await fetch({ stage: 'purchase', payment: 'partial', quick: 'true' });
  expect(quick.orders.map(o => String(o._id))).toEqual(full.orders.map(o => String(o._id)));
  expect(quick.orders[0].openCents).toBe(3000); expect(quick.hasMore).toBe(false);
});

test('the customer reference sent to the UI contains the profile ID', async () => {
  const user = await User.create({ username: 'profile-test', customerId: 'T999', firstName: 'Jane', lastName: 'Austen', phone: 9000012, password: 'test-only-password' });
  await order('PROFILE', { user: user._id });
  const data = await fetch({ quick: 'true' });
  expect(String(data.orders[0].user._id)).toBe(String(user._id));
  expect(data.orders[0].user.customerId).toBe('T999');
});

test('light trip projection preserves explicit and legacy package links', async () => {
  const tripId = oid(); const first = oid(); const second = oid();
  await order('TRIP-ROW', { isShipment: true, paymentList: [
    { _id: first, tripId, deliveredPackages: { trackingNumber: 'DIRECT' } },
    { _id: second, deliveredPackages: { trackingNumber: 'LEGACY' } },
  ] });
  await Inventory.collection.insertOne({ _id: tripId, inventoryType: 'inventoryGoods', shippingType: 'air', voyage: 'CN-162',
    orders: [{ paymentList: { _id: first } }, { paymentList: { _id: second } }, ...Array.from({ length: 50 }, () => ({ paymentList: { _id: oid() } }))] });
  const data = await fetch({ quick: 'true' });
  expect(data.orders[0].packages).toHaveLength(2);
  data.orders[0].packages.forEach(p => {
    expect(p.trip.name).toBe('CN-162'); expect(String(p.trip._id)).toBe(String(tripId));
    expect(p.trip.orders).toBeUndefined();
  });
});
