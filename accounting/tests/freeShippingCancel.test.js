const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');
const { getBalance } = require('../services/carrying');
const { AccountingSettings, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const payables = require('../services/posting/payables');
const offers = require('../services/freeShippingOffers');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');

beforeAll(startDb);
afterAll(stopDb);
const tx = fn => runInTransaction(fn);
const req = { user: { _id: oid(), roles: { isAdmin: true, isOwner: true } } };
const balance = async code => (await getBalance((await account(code))._id)).usd;
let order, user, trip, vendor, packages;

async function deliver(index) {
  await Order.updateOne({ _id: order, 'paymentList._id': packages[index] }, { $set: { 'paymentList.$.status.received': true } });
  await tx(session => syncOrder(order, { session }));
}
async function applyOffer(index) {
  const row = (await offers.review({ orderId: String(order) })).results.find(r => r.packageId === String(packages[index]));
  expect(row.blocked).toBe('');
  return offers.apply({ items: [{ orderId: String(order), packageId: String(packages[index]), fingerprint: row.fingerprint }],
    reason: 'Offer', confirmFreeShipping: true }, req);
}
const cancelOffer = index => offers.cancel({ orderId: String(order), packageId: String(packages[index]), reason: 'Mistake' }, req);
const reviewRow = async index => (await offers.review({ orderId: String(order) })).results.find(r => r.packageId === String(packages[index]));

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  user = (await mongoose.connection.collection('users').insertOne({ firstName: 'Customer', customerId: 'S1' })).insertedId;
  trip = oid(); packages = [oid(), oid()];
  order = (await Order.collection.insertOne({ orderId: 'FREE-TEST', user, placedAt: 'tripoli', isPayment: true, totalInvoice: 500,
    isShipment: false, orderStatus: 1, shipment: { method: 'air', fromWhere: 'CN', toWhere: 'LY' },
    customerInfo: { fullName: 'Customer' }, createdAt: new Date('2026-09-01'),
    paymentList: packages.map((_id, i) => ({ _id, tripId: trip, status: { received: false },
      deliveredPackages: { trackingNumber: `TRACK${i}`, weight: { total: (i + 1) * 10, measureUnit: 'KG' }, exiosPrice: 10, shipmentMethod: 'air' } })) })).insertedId;
  await Inventory.collection.insertOne({ _id: trip, voyage: 'AIR-FREE', inventoryType: 'inventoryGoods', shippingType: 'air',
    inventoryPlace: 'tripoli', orders: packages.map(_id => ({ paymentList: { _id } })), createdAt: new Date('2026-09-01') });
  vendor = await Vendor.create({ name: 'Carrier', type: 'carrier' });
  await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-10-28', currency: 'USD',
    lines: [{ target: 'trip', tripId: trip, amount: 180, description: 'Carrier cost' }] }, { session, req }));
});
afterEach(async () => {
  for (const entry of await JournalEntry.find().lean()) {
    expect(entry.lines.reduce((sum, line) => sum + (line.debit || 0) - (line.credit || 0), 0)).toBe(0);
  }
});

test('cancelling an offer on a delivered package restores claim, revenue and moves cost back to shipping', async () => {
  await deliver(0);
  const before = { ar: await balance('121000'), rev: await balance('410100'), air: await balance('510100'), pur: await balance('510400'), wip: await balance('130100') };
  await applyOffer(0);
  expect(await balance('410100')).toBe(0);
  expect(await balance('510100')).toBe(0);
  expect(await balance('510400') - before.pur).toBe(6000);
  const offered = await reviewRow(0);
  expect(offered.enabled).toBe(true);
  expect(offered.restoredChargeMinor).toBe(10000);

  await cancelOffer(0);
  expect(await balance('121000')).toBe(before.ar);
  expect(await balance('410100')).toBe(before.rev);
  expect(await balance('510100')).toBe(before.air);
  expect(await balance('510400')).toBe(before.pur);
  expect(await balance('130100')).toBe(before.wip);
  const row = await reviewRow(0);
  expect(row).toMatchObject({ enabled: false, chargeMinor: 10000, billedMinor: 10000, openMinor: 10000, revenueMinor: 10000 });
  const saved = (await Order.findById(order).lean()).paymentList[0];
  expect(saved.deliveredPackages.exiosPrice).toBe(10);
  expect(saved.freeShippingOffer).toMatchObject({ enabled: false, previousUnitPrice: 10, cancellationReason: 'Mistake' });

  // Idempotent: a second sync posts nothing, a second cancel is refused
  const count = await JournalEntry.countDocuments();
  await tx(session => syncOrder(order, { session }));
  expect(await JournalEntry.countDocuments()).toBe(count);
  await expect(cancelOffer(0)).rejects.toThrow();
});

test('cancelling before delivery restores only the claim; delivery then recognises shipping normally', async () => {
  await applyOffer(0);
  expect((await reviewRow(0)).billedMinor).toBe(0);
  await cancelOffer(0);
  const row = await reviewRow(0);
  expect(row).toMatchObject({ billedMinor: 10000, openMinor: 10000 });
  expect(row.revenueMinor + 0).toBe(0);
  await deliver(0);
  expect(await balance('410100')).toBe(-10000);
  expect(await balance('510100')).toBe(6000);
});

test('the offer can be applied again after a cancellation', async () => {
  await deliver(0);
  await applyOffer(0);
  await cancelOffer(0);
  await applyOffer(0);
  expect(await balance('410100')).toBe(0);
  expect(await balance('510100')).toBe(0);
  expect((await reviewRow(0))).toMatchObject({ enabled: true, billedMinor: 0, openMinor: 0 });
});
