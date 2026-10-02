// The owner's additions in v8: volumetric weight, trip cost categories, domestic transport
// (cost shared over its own packages, fee charged on the package), abandoned goods, sub cash boxes.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const { refreshTripPackages } = require('../services/tripLinks');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const admin = { _id: oid(), roles: { isAdmin: true } };
const clerk = { _id: oid(), roles: {} };
const req = { user: admin };
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 10 }]);
});

let seq = 0;
const newCustomer = async () => (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', customerId: `V${++seq}` })).insertedId;

// packages: [{ weight, price, received, domesticFeeUsd }]
async function newOrder({ user, placedAt = 'tripoli', packages = [] }) {
  const paymentList = packages.map((p) => ({
    _id: oid(),
    status: { arrived: true, arrivedLibya: true, received: !!p.received },
    deliveredPackages: {
      trackingNumber: `T${Math.random().toString(36).slice(2, 7)}`, weight: { total: p.weight, measureUnit: 'KG' }, exiosPrice: p.price, shipmentMethod: 'air',
      ...(p.domesticFeeUsd && { domesticFee: { amount: p.domesticFeeUsd, currency: 'USD', usd: p.domesticFeeUsd } }),
    },
  }));
  const { insertedId } = await Order.collection.insertOne({
    orderId: `V${Date.now()}${Math.random().toString(36).slice(2, 6)}`, user, placedAt, isPayment: false, isShipment: true,
    totalInvoice: 0, unsureOrder: false, isCanceled: false, shipment: { method: 'air' }, paymentList, createdAt: new Date('2026-01-02'),
  });
  return { _id: insertedId, packageIds: paymentList.map((p) => p._id) };
}

const newTrip = async (packageIds, shippingType = 'air', place = 'tripoli') => {
  const { insertedId } = await Inventory.collection.insertOne({
    voyage: `${shippingType}-${Math.random().toString(36).slice(2, 5)}`, inventoryType: 'inventoryGoods', shippingType, inventoryPlace: place, status: 'processing',
    orders: packageIds.map((id) => ({ paymentList: { _id: id } })), createdAt: new Date(),
  });
  await refreshTripPackages(insertedId);
  return insertedId;
};

test('1. volumetric weight: CBM x 167 is what is billed; a saved weight is changed by admins only', async () => {
  const { normalizePackages, guardMeasures } = require('../../utils/packageMeasures');
  const rows = [
    { deliveredPackages: { trackingNumber: 'A', weight: { total: 10, measureUnit: 'KG' }, volumetric: { enabled: true, cbm: 0.12 } } },
    { deliveredPackages: { trackingNumber: 'B', weight: { total: 5, measureUnit: 'KG' }, volumetric: { enabled: true, length: 50, width: 40, height: 30 } } },
    { deliveredPackages: { trackingNumber: 'C', weight: { total: 8, measureUnit: 'KG' } } },
  ];
  await normalizePackages(rows);
  expect(rows[0].deliveredPackages.weight).toMatchObject({ total: 20.04, actual: 10 });
  expect(rows[1].deliveredPackages).toMatchObject({ weight: { total: 10.02, actual: 5 }, volumetric: { cbm: 0.06, factor: 167 } });
  expect(rows[2].deliveredPackages.weight).toEqual({ total: 8, measureUnit: 'KG' });
  await expect(normalizePackages([{ deliveredPackages: { weight: { total: 3, measureUnit: 'KG' }, volumetric: { enabled: true } } }])).rejects.toThrow('CBM');

  // The factor is a setting
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { volumetricFactor: 200 } });
  invalidateConfig();
  const again = [{ deliveredPackages: { weight: { total: 10, measureUnit: 'KG' }, volumetric: { enabled: true, cbm: 0.1 } } }];
  await normalizePackages(again);
  expect(again[0].deliveredPackages.weight.total).toBe(20);

  // Billing and the trip's cost follow the chargeable weight
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 20.04, price: 5 }, { weight: 10, price: 5 }] });
  const trip = await newTrip(order.packageIds);
  const [carrier] = await Vendor.create([{ name: 'Carrier', type: 'carrier' }]);
  await tx((session) => require('../services/posting/payables').createBill({ vendorId: carrier._id, day: '2026-01-03', currency: 'USD', lines: [{ description: 'air', amount: 30.04, target: 'trip', tripId: trip }] }, { session, req }));
  await tx((session) => syncOrder(order._id, { session }));
  expect(await balanceOf('121000')).toBe(15020); // 20.04 x 5 + 10 x 5

  // A saved weight: the clerk cannot change it, the admin can
  const saved = await Order.findById(order._id).lean();
  const edited = JSON.parse(JSON.stringify(saved.paymentList));
  edited[0].deliveredPackages.volumetric = { enabled: true, cbm: 0.2 };
  await expect(guardMeasures(saved, edited, clerk)).rejects.toMatchObject({ statusCode: 403 });
  await expect(guardMeasures(saved, edited, admin)).resolves.toBeUndefined();
  await expect(guardMeasures(saved, JSON.parse(JSON.stringify(saved.paymentList)), clerk)).resolves.toBeUndefined();
});
