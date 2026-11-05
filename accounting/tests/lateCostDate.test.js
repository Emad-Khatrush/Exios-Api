// A cost entered late (a statement line of 10-10 matched on 11-04) goes to cost of sales on the day
// it belongs to, the later of its own day and its revenue's day, never on the day it was typed
// (matching principle; owner's report 2026-11-05).
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const payables = require('../services/posting/payables');
const { today } = require('../services/dates');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');

beforeAll(startDb);
afterAll(stopDb);
const tx = fn => runInTransaction(fn);
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let user, vendor;
const costDays = async (filter = {}) => (await JournalEntry.find({ eventType: 'COST_RECOGNITION', status: 'posted', ...filter }).sort({ _id: 1 }).lean()).map(e => e.day);
const bill = (day, amount, line) => tx(session => payables.createBill({ vendorId: vendor._id, day, currency: 'USD', lines: [{ description: 'cost', amount, ...line }] }, { session, req }));

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  user = (await mongoose.connection.collection('users').insertOne({ firstName: 'Customer', customerId: 'L1' })).insertedId;
  vendor = await Vendor.create({ name: 'Supplier', type: 'supplier' });
});

async function purchaseOrder(day) {
  const id = (await Order.collection.insertOne({ orderId: `P-${Date.now()}`, user, placedAt: 'tripoli', isPayment: true, totalInvoice: 100,
    orderStatus: 1, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date(`${day}T10:00:00Z`) })).insertedId;
  // Bought and recognised on that day
  await tx(session => syncOrder(id, { session, date: day }));
  return id;
}

test('a purchase paid on 10-10 and matched today is a cost of 10-10, the order recognised then', async () => {
  const order = await purchaseOrder('2026-10-10');
  expect(await JournalEntry.findOne({ eventType: 'RECOGNITION' }).lean()).toMatchObject({ day: '2026-10-10' });
  await bill('2026-10-10', 60, { target: 'order', orderId: order });
  expect(await costDays()).toEqual(['2026-10-10']);
});

test('a cost dated before its revenue waits for the revenue day; one dated today stays today', async () => {
  const order = await purchaseOrder('2026-10-10');
  await bill('2026-10-05', 40, { target: 'order', orderId: order });
  await bill(today(), 10, { target: 'order', orderId: order });
  expect(await costDays()).toEqual(['2026-10-10', today()]);
});

test('an order purchased today: its earlier cost is recognised today with its revenue', async () => {
  const order = (await Order.collection.insertOne({ orderId: 'P-NOW', user, placedAt: 'tripoli', isPayment: true, totalInvoice: 100,
    orderStatus: 0, unsureOrder: false, isCanceled: false, paymentList: [] })).insertedId;
  await bill('2026-10-10', 60, { target: 'order', orderId: order });
  expect(await costDays()).toEqual([]);
  await Order.updateOne({ _id: order }, { $set: { orderStatus: 1 } });
  await tx(session => syncOrder(order, { session }));
  expect(await costDays()).toEqual([today()]);
});

test('a trip cost entered late goes to the day the package was recognised', async () => {
  const trip = oid(); const pkg = oid();
  const order = (await Order.collection.insertOne({ orderId: 'SHIP-LATE', user, placedAt: 'tripoli', isPayment: false, isShipment: true, orderStatus: 0,
    shipment: { method: 'air' }, createdAt: new Date('2026-09-01'), paymentList: [{ _id: pkg, tripId: trip, status: { received: true },
      deliveredPackages: { trackingNumber: 'LATE1', weight: { total: 10, measureUnit: 'KG' }, exiosPrice: 10, shipmentMethod: 'air' } }] })).insertedId;
  await Inventory.collection.insertOne({ _id: trip, voyage: 'AIR-LATE', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli',
    orders: [{ paymentList: { _id: pkg } }], createdAt: new Date('2026-09-01') });
  await tx(session => syncOrder(order, { session, date: '2026-10-12' }));
  const carrier = await Vendor.create({ name: 'Carrier', type: 'carrier' });
  await tx(session => payables.createBill({ vendorId: carrier._id, day: '2026-10-08', currency: 'USD', lines: [{ target: 'trip', tripId: trip, amount: 50, description: 'freight' }] }, { session, req }));
  expect(await costDays({ 'lines.tripId': trip })).toEqual(['2026-10-12']);
});
