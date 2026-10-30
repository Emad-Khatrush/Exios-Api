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
const newCustomer = async () => (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', customerId: `V${++seq}`, phone: 920000000 + seq })).insertedId;

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

const UserStatement = require('../../models/userStatement');
const operations = require('../services/posting/operations');
const payables = require('../services/posting/payables');
const pay = async (user, orderId, packageIds, amount, day = '2026-02-01') => {
  const dep = await UserStatement.create({ user, createdBy: oid(), description: 'إيداع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date(day) });
  await tx((session) => operations.postStatement(dep._id, { session }));
  const spend = await UserStatement.create({ user, createdBy: oid(), description: 'دفع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date(day) });
  await tx((session) => operations.postStatement(spend._id, { session, target: { orderId, packageIds } }));
};
const deliver = async (orderId, packageId) => {
  await Order.updateOne({ _id: orderId, 'paymentList._id': packageId }, { $set: { 'paymentList.$.status.received': true } });
  await tx((session) => syncOrder(orderId, { session }));
};
const costBill = async (tripId, amount, costCategory) => {
  const [carrier] = await Vendor.create([{ name: `C${Math.random()}`, type: 'carrier' }]);
  return tx((session) => payables.createBill({ vendorId: carrier._id, day: '2026-01-05', currency: 'USD', lines: [{ description: 'x', amount, target: 'trip', tripId, costCategory }] }, { session, req }));
};

test('3-4. domestic transport: its cost shared over its own packages; the fee is its own claim and 410500', async () => {
  const customer = await newCustomer();
  // A stays in Tripoli; B goes on to Benghazi by truck with a 10$ transport fee
  const order = await newOrder({ user: customer, packages: [{ weight: 20, price: 10 }, { weight: 10, price: 10, domesticFeeUsd: 10 }] });
  const [a, b] = order.packageIds;
  const flight = await newTrip([a, b], 'air');
  const truck = await newTrip([b], 'domestic', 'benghazi');
  await costBill(flight, 240, 'shipping');
  await costBill(flight, 60, 'customs');
  await costBill(truck, 50, 'transport');
  await tx((session) => syncOrder(order._id, { session }));
  // 200 + 100 shipping, 10 transport fee
  expect(await balanceOf('121000')).toBe(31000);
  expect(await balanceOf('130100')).toBe(35000);

  await pay(customer, order._id, [a], 200);
  await pay(customer, order._id, [b], 110);
  expect(await balanceOf('121000')).toBe(0);
  await deliver(order._id, a);
  await deliver(order._id, b);
  expect(await balanceOf('410100')).toBe(-30000);
  expect(await balanceOf('410500')).toBe(-1000);
  expect(await balanceOf('510100')).toBe(30000); // the flight (shipping + customs) by weight
  expect(await balanceOf('510300')).toBe(5000); // the truck, on B only
  expect(await balanceOf('130100')).toBe(0);

  // A late domestic cost goes straight to 510300 on the same packages
  await costBill(truck, 20, 'transport');
  expect(await balanceOf('510300')).toBe(7000);
  expect(await balanceOf('130100')).toBe(0);
  const lines = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $match: { 'lines.accountCode': '510300' } }, { $group: { _id: '$lines.packageId' } }]);
  expect(lines.map((l) => String(l._id))).toEqual([String(b)]);

  // The trip report: cost by category, per KG by delivery office, before and after transport
  const { tripProfitability } = require('../services/reports/operations');
  const { results } = await tripProfitability({});
  const air = results.find((r) => String(r.tripId) === String(flight));
  expect(air.byCategory).toMatchObject({ shipping: 24000, customs: 6000 });
  expect(air.costPerUnit).toBe(1000); // 300$ over 30 KG
  expect(air.profitBeforeDomestic).toBe(0);
  expect(air.profitAfterDomestic).toBe(-7000);
  // Tripoli: 20 KG sold at 10$, cost 10$/KG. Benghazi: 10 KG, cost 10$ + 7$ transport per KG
  expect(air.offices.find((o) => o.office === 'tripoli')).toMatchObject({ weight: 20, costPerUnit: 1000, fullCostPerUnit: 1000, sellPerUnit: 1000 });
  expect(air.offices.find((o) => o.office === 'benghazi')).toMatchObject({ weight: 10, costPerUnit: 1000, fullCostPerUnit: 1700, sellPerUnit: 1000, domesticCost: 7000 });
  const road = results.find((r) => String(r.tripId) === String(truck));
  expect(road).toMatchObject({ totalCost: 7000, packages: 1, weight: 10, feesBilled: 1000, feesRecognized: 1000, extraCostPerUnit: 700 });
});

test('trip profitability allocates leftover cents exactly like the ledger', async () => {
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [1, 2, 3].map(() => ({ weight: 1, price: 1 })) });
  const flight = await newTrip(order.packageIds, 'air');
  const truck = await newTrip(order.packageIds, 'domestic', 'benghazi');
  await costBill(truck, 0.02, 'transport'); // two USD cents split over three equal packages
  await tx((session) => syncOrder(order._id, { session }));

  for (const packageId of order.packageIds) {
    await pay(customer, order._id, [packageId], 1);
    await deliver(order._id, packageId);
  }

  const { results } = await require('../services/reports/operations').tripProfitability({});
  const report = results.find((row) => String(row.tripId) === String(flight));
  expect(report.offices.reduce((total, office) => total + office.domesticCost, 0)).toBe(2);
  expect(await balanceOf('510300', { tripId: truck })).toBe(2);
});

test('trip profitability allocates office cost cents without creating or losing value', async () => {
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [1, 2, 3].map(() => ({ weight: 1, price: 1 })) });
  const flight = await newTrip(order.packageIds, 'air');
  for (const [index, office] of ['benghazi', 'misrata', 'sabha'].entries()) {
    await newTrip([order.packageIds[index]], 'domestic', office);
  }
  await costBill(flight, 0.02, 'shipping');

  const { results } = await require('../services/reports/operations').tripProfitability({});
  const report = results.find((row) => String(row.tripId) === String(flight));
  expect(report.offices).toHaveLength(3);
  expect(report.offices.reduce((total, office) => total + office.ownCost, 0)).toBe(report.totalCost);
  expect(report.totalCost).toBe(2);
});

test('4. live: a wallet deduction noted "نقل داخلي" with no order is domestic shipping revenue (rule 76)', async () => {
  const customer = await newCustomer();
  const dep = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount: 50, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-01') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  const fee = await UserStatement.create({ user: customer, createdBy: oid(), description: 'خصم', note: 'نقل داخلي إلى بنغازي', amount: 15, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postStatement(fee._id, { session }));
  expect(await balanceOf('410500')).toBe(-1500);
  expect(await balanceOf('399000')).toBe(0);
});

test('5. abandoned goods: unpaid part reversed, paid part revenue, full cost; undo; then sale to 410800', async () => {
  const ab = require('../services/abandoned');
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 10, price: 10 }] }); // 100$
  const [pkg] = order.packageIds;
  const trip = await newTrip([pkg]);
  await Inventory.collection.updateOne({ _id: trip }, { $set: { arrivalDate: new Date('2024-01-01') } });
  await costBill(trip, 60, 'shipping');
  await tx((session) => syncOrder(order._id, { session }));
  await pay(customer, order._id, [pkg], 30);
  expect(await balanceOf('121000')).toBe(7000);

  // Listed after a year in Libya
  const { results } = await ab.abandonedList();
  expect(results.map((r) => String(r.packageId))).toContain(String(pkg));
  await expect(ab.declareAbandoned(order._id, pkg, { user: clerk })).rejects.toMatchObject({ statusCode: 403 });

  await ab.declareAbandoned(order._id, pkg, req);
  expect(await balanceOf('121000')).toBe(0);
  expect(await balanceOf('220400')).toBe(0);
  expect(await balanceOf('410100')).toBe(-3000); // what was paid
  expect(await balanceOf('510100')).toBe(6000); // the whole cost
  expect(await balanceOf('220100', { partnerId: customer })).toBe(0); // wallet untouched

  // Undo before the sale: the claim and the cost come back
  await ab.restoreAbandoned(order._id, pkg, req);
  expect(await balanceOf('121000')).toBe(7000);
  expect(await balanceOf('410100')).toBe(0);
  expect(await balanceOf('510100')).toBe(0);

  // Declared again and sold for 400 dinars into the Tripoli dinar box
  await ab.declareAbandoned(order._id, pkg, req);
  const box = await account('110102');
  await ab.sellAbandoned(order._id, pkg, { day: '2026-03-01', amount: 400, accountId: box._id }, req);
  expect(await balanceOf('410800')).toBe(-4000);
  expect((await getBalance(box._id)).foreign).toBe(400000);
  await expect(ab.restoreAbandoned(order._id, pkg, req)).rejects.toThrow('بعد البيع');
  const saved = await Order.findById(order._id).lean();
  expect(saved.paymentList[0].deliveredPackages.abandoned.status).toBe('sold');
});

test('6. sub cash boxes: staff cash lands on their office sub box, history on the main box, hand-over moves it all', async () => {
  const staff = require('../services/staffOperations');
  const { subBoxes, handOver } = require('../services/subBoxes');
  const clerkId = (await mongoose.connection.collection('users').insertOne({ firstName: 'موظف', office: 'benghazi', roles: { isEmployee: true }, phone: 930000001 })).insertedId;
  const benghaziClerk = { _id: clerkId, roles: { isEmployee: true } };
  const customer = await newCustomer();

  // A cash deposit entered by a Benghazi clerk, though the screen says Tripoli
  const dep = await UserStatement.create({ user: customer, createdBy: clerkId, description: 'إيداع', amount: 100, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-01') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  expect(await balanceOf('110123')).toBe(10000);
  expect(await balanceOf('110101')).toBe(0);

  // The same in the historical replay goes to the main box
  const old = await UserStatement.create({ user: customer, createdBy: clerkId, description: 'إيداع قديم', amount: 50, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2025-03-01') });
  await tx((session) => operations.postStatement(old._id, { session, isHistorical: true, migrationRunId: 'TEST' }));
  expect(await balanceOf('110101')).toBe(5000);

  // A trip cost paid "from the Tripoli box" by the clerk comes out of the Benghazi sub box
  const order = await newOrder({ user: customer, packages: [{ weight: 5, price: 10 }] });
  const trip = await newTrip(order.packageIds);
  const lyd = await account('110102');
  await staff.addTripCost(trip, { vendorName: 'جمارك', amount: 200, payFromAccountId: lyd._id, costCategory: 'customs', day: '2026-03-02' }, { user: benghaziClerk });
  expect((await getBalance((await account('110124'))._id)).foreign).toBe(-200000);
  expect((await getBalance(lyd._id)).foreign).toBe(0);

  // The clerk's forms offer the sub box, not the main boxes
  const { accounts } = await staff.options(benghaziClerk, {});
  const codes = accounts.map((a) => a.code || a.name);
  expect(accounts.some((a) => a.name.includes('فرعية بنغازي'))).toBe(true);
  expect(accounts.some((a) => a.kind === 'cash' && !a.name.includes('فرعية'))).toBe(false);
  expect(codes.length).toBeGreaterThan(0);

  // The accountant hands the Benghazi dollars over to the main box
  const rows = await subBoxes();
  const usdSub = rows.find((r) => r.subCode === '110123');
  expect(usdSub).toMatchObject({ foreign: 10000, mainCode: '110103' });
  await tx((session) => handOver(usdSub.subId, { session, req }));
  expect(await balanceOf('110123')).toBe(0);
  expect(await balanceOf('110103')).toBe(10000);
});

test('4b. a transport fee in dinars paid from the dinar wallet on its own, the shipping in dollars', async () => {
  const { loadDeliverablePackages } = require('../../utils/helperApi');
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 10, price: 10, received: false }] });
  const [pkg] = order.packageIds;
  // 50 LYD fee, set when the rate was 8 (6.25$); delivered when it is 10
  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg }, { $set: { 'paymentList.$.deliveredPackages.domesticFee': { amount: 50, currency: 'LYD', usd: 6.25 } } });
  await tx((session) => syncOrder(order._id, { session }));
  expect(await balanceOf('121000')).toBe(10625);

  const saved = await Order.findById(order._id).lean();
  const loaded = await loadDeliverablePackages(customer, [{ id: String(pkg), orderId: saved.orderId }], { feeMode: 'separate' });
  expect(loaded).toMatchObject({ totalCost: 100, totalFeeLYD: 50 });
  expect(loaded.packages[0]).toMatchObject({ cost: 100, separateFee: true });
  // The fee's dollars follow today's rate
  expect((await Order.findById(order._id).lean()).paymentList[0].deliveredPackages.domesticFee.usd).toBe(5);
  await tx((session) => syncOrder(order._id, { session }));

  // The two wallet payments the delivery makes: shipping in USD, the fee in LYD at today's rate
  const usdIn = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount: 100, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-01') });
  await tx((session) => operations.postStatement(usdIn._id, { session }));
  const lydIn = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount: 50, currency: 'LYD', rate: 10, total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-01') });
  await tx((session) => operations.postStatement(lydIn._id, { session }));
  const ship = await UserStatement.create({ user: customer, createdBy: oid(), description: 'شحن', amount: 100, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postStatement(ship._id, { session, target: { arKeys: [`SHP:${order._id}:${pkg}`] } }));
  const fee = await UserStatement.create({ user: customer, createdBy: oid(), description: 'رسوم النقل الداخلي', amount: 50, currency: 'LYD', rate: 10, total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postStatement(fee._id, { session, target: { arKeys: [`SHP:${order._id}:${pkg}:DOM`] } }));
  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg }, { $set: { 'paymentList.$.status.received': true } });
  await tx((session) => syncOrder(order._id, { session }));
  expect(await balanceOf('121000')).toBe(0);
  expect(await balanceOf('410500')).toBe(-500);
  expect(await balanceOf('410100')).toBe(-10000);
});

test('D. a purchase invoice paid in part: the paid share is revenue, its cost in the same proportion', async () => {
  const customer = await newCustomer();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'D-1', user: customer, placedAt: 'tripoli', isPayment: true, totalInvoice: 200, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-02-01'),
  });
  const [shop] = await Vendor.create([{ name: 'Shop', type: 'supplier' }]);
  await tx((session) => payables.createBill({ vendorId: shop._id, day: '2026-02-01', currency: 'USD', lines: [{ description: 'goods', amount: 150, target: 'order', orderId }] }, { session, req }));
  const payInvoice = async (amount) => {
    const dep = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-02-02') });
    await tx((session) => operations.postStatement(dep._id, { session }));
    const spend = await UserStatement.create({ user: customer, createdBy: oid(), description: 'دفع', amount, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-02-02') });
    await tx((session) => operations.postStatement(spend._id, { session, target: { orderId, category: 'invoice' } }));
  };
  await tx((session) => syncOrder(orderId, { session }));
  expect(await balanceOf('410300')).toBe(0);

  await payInvoice(100);
  expect(await balanceOf('410300')).toBe(-10000);
  expect(await balanceOf('510400')).toBe(7500);
  expect(await balanceOf('220300')).toBe(-10000);
  expect(await balanceOf('130200')).toBe(7500);

  await payInvoice(100);
  expect(await balanceOf('410300')).toBe(-20000);
  expect(await balanceOf('510400')).toBe(15000);
  expect(await balanceOf('220300')).toBe(0);
  expect(await balanceOf('130200')).toBe(0);
});

test('E. an old expense paid before the count day comes out of the opening balance, not a box', async () => {
  const expense = await account('530800');
  const [shop] = await Vendor.create([{ name: 'Old shop', type: 'service' }]);
  const line = [{ description: 'كهرباء سبتمبر', amount: 40, target: 'expense', accountId: expense._id, office: 'tripoli' }];
  // Before the historical migration is committed it is refused (enter it normally then)
  await expect(tx((session) => payables.createBill({ vendorId: shop._id, day: '2026-09-15', currency: 'USD', paidBeforeCount: true, lines: line }, { session, req }))).rejects.toThrow('بعد اعتماد');
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { cutoffAt: new Date('2026-09-30T20:00:00Z') } });
  invalidateConfig();
  await tx((session) => payables.createBill({ vendorId: shop._id, day: '2026-09-15', currency: 'USD', paidBeforeCount: true, lines: line }, { session, req }));
  expect(await balanceOf('530800')).toBe(4000);
  expect(await balanceOf('390000')).toBe(-4000);
  expect(await balanceOf('110101')).toBe(0);
  await expect(tx((session) => payables.createBill({ vendorId: shop._id, day: '2026-10-05', currency: 'USD', paidBeforeCount: true, lines: line }, { session, req }))).rejects.toThrow('قبله');
});

test('G. an Alipay transfer order: the yuan are sent in one step at the Alipay average rate', async () => {
  const alipay = require('../services/posting/alipay');
  const [wasl] = await Vendor.create([{ name: 'وصل', type: 'service' }]);
  const box = await account('110301');
  const cashBox = await account('110101');
  await tx((session) => alipay.createYuanPurchase({ vendorId: wasl._id, day: '2026-02-01', fromAccountId: cashBox._id, amount: 1000, toAccountId: box._id, cnyReceived: 6600 }, { session, req }));
  const customer = await newCustomer();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'G-1', user: customer, placedAt: 'tripoli', isPayment: true, isRemittance: true, totalInvoice: 1000, unsureOrder: false, isCanceled: false, paymentList: [],
    purchaseItems: [{ _id: oid(), description: 'علي باي', unitPrice: 6500, currency: 'CNY' }], createdAt: new Date('2026-02-02'),
  });
  await tx((session) => syncOrder(orderId, { session }));
  const status = await alipay.remittanceStatus(orderId);
  expect(status).toMatchObject({ suggestedCny: 6500, sentCny: 0 });
  await tx((session) => alipay.sendRemittance(orderId, { accountId: box._id, cny: 6500, day: '2026-02-03' }, { session, req }));
  expect(await balanceOf('130200')).toBe(98485); // 6500 / 6.6
  expect((await alipay.remittanceStatus(orderId)).suggestedCny).toBe(0);
  // Sending more than the recorded yuan is allowed (a top-up may not be entered yet): the box goes below zero
  await tx((session) => alipay.sendRemittance(orderId, { accountId: box._id, cny: 500, day: '2026-02-03' }, { session, req }));
  expect((await require('../services/carrying').getBalance(box._id)).foreign).toBe(-40000);
});

test('concurrent Alipay remittances cannot spend the same yuan balance twice', async () => {
  const alipay = require('../services/posting/alipay');
  const { SupplierBill } = require('../models/documents');
  const [broker] = await Vendor.create([{ name: 'Concurrent Alipay broker', type: 'service' }]);
  const box = await account('110301');
  const cashBox = await account('110101');
  await tx((session) => alipay.createYuanPurchase({ vendorId: broker._id, day: '2026-02-01', fromAccountId: cashBox._id, amount: 100, toAccountId: box._id, cnyReceived: 1000 }, { session, req }));
  const customer = await newCustomer();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'G-RACE', user: customer, placedAt: 'tripoli', isPayment: true, isRemittance: true, totalInvoice: 1000,
    purchaseItems: [{ _id: oid(), description: 'Customer purchase', unitPrice: 1600, currency: 'CNY' }],
    unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-02-02'),
  });
  const send = (idempotencyKey) => tx((session) => alipay.sendRemittance(orderId, {
    accountId: box._id, cny: 800, day: '2026-02-03', idempotencyKey,
  }, { session, req }));

  const outcomes = await Promise.allSettled([send('alipay-race-1'), send('alipay-race-2')]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect((await getBalance(box._id)).foreign).toBe(20000);
  expect(await SupplierBill.countDocuments({ 'lines.orderId': orderId, status: 'posted', currency: 'CNY' })).toBe(1);
});

test('H. a purchase typed once (50$) that the bank charged in two lira payments is linked to both', async () => {
  const bank = require('../services/posting/bank');
  const { BankStatementLine } = require('../models/documents');
  await CurrencyRate.create([{ currency: 'TRY', day: '2026-01-01', rate: 40 }]);
  const lira = await account('110204');
  const itemId = oid();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'H-1', user: oid(), placedAt: 'tripoli', isPayment: true, totalInvoice: 70, unsureOrder: false, isCanceled: false, paymentList: [],
    purchaseItems: [{ _id: itemId, date: new Date('2026-03-01'), description: 'Trendyol', unitPrice: 50, currency: 'USD' }], createdAt: new Date('2026-03-01'),
  });
  await tx((session) => bank.importLines(lira._id, [
    { day: '2026-03-02', description: 'TRENDYOL 1', amount: -600 },
    { day: '2026-03-02', description: 'TRENDYOL 2', amount: -1400 },
  ], { session, req }));
  const lines = await BankStatementLine.find({ accountId: lira._id }).lean();
  expect((await bank.orderPurchaseItems(orderId)).items[0]).toMatchObject({ unitPrice: 50, linked: false });
  await tx((session) => bank.linkGroup(lines.map((l) => l._id), { orderId, itemId }, { session, req }));
  // 2000 lira at 40 = 50$: one bill on the order, two payments from the lira account
  expect(await balanceOf('130200')).toBe(5000);
  expect(await getBalance(lira._id)).toEqual({ usd: -5000, foreign: -200000 });
  expect(await balanceOf('210200')).toBe(0);
  expect((await BankStatementLine.find({ accountId: lira._id }).lean()).every((l) => l.lineStatus === 'created_entry')).toBe(true);
  expect((await bank.orderPurchaseItems(orderId)).items[0].linked).toBe(true);

  // Undoing one line keeps the bill for the other; undoing the second takes the bill away
  await tx((session) => bank.cancelLineEntry(lines[0]._id, { session, req, reason: 'خطأ' }));
  expect(await balanceOf('130200')).toBe(5000);
  await tx((session) => bank.cancelLineEntry(lines[1]._id, { session, req, reason: 'خطأ' }));
  expect(await balanceOf('130200')).toBe(0);
  expect(await getBalance(lira._id)).toEqual({ usd: 0, foreign: 0 });
});

test('6b. the owner\'s or accountant\'s cash follows the office on the operation, also after an edit; a clerk\'s stays in their office', async () => {
  const customer = await newCustomer();
  const accountantId = (await mongoose.connection.collection('users').insertOne({ firstName: 'محاسب', office: 'tripoli', roles: { isAccountant: true }, phone: 930000002 })).insertedId;
  const dep = await UserStatement.create({ user: customer, createdBy: accountantId, description: 'إيداع', amount: 220, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-05') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  expect(await balanceOf('110121')).toBe(22000);
  // The office changed to Benghazi on the statement: the money moves to Benghazi's sub box
  await UserStatement.updateOne({ _id: dep._id }, { $set: { office: 'benghazi' }, $push: { editHistory: { editedAt: new Date(), before: { office: 'tripoli' } } } });
  await tx((session) => operations.repostStatement(dep._id, { session }));
  expect(await balanceOf('110121')).toBe(0);
  expect(await balanceOf('110123')).toBe(22000);
  const posted = await JournalEntry.findOne({ eventKey: `DEPOSIT:${dep._id}:v2` }).lean();
  expect(posted.lines.find((l) => l.debit).office).toBe('benghazi');
});

test('6c. an edited refund linked to an order stays on that order', async () => {
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 10, price: 10 }] });
  await tx((session) => syncOrder(order._id, { session }));
  const refund = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'ريفاند', amount: 30, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '+', actionType: 'refund', office: 'tripoli', createdAt: new Date('2026-03-06') });
  const { emitAccountingEvent } = require('../services/events');
  await emitAccountingEvent('statement', refund._id, { target: { orderId: order._id } });
  await tx((session) => operations.postStatement(refund._id, { session, target: { orderId: order._id } }));
  const expenseBefore = await balanceOf('520200');
  await UserStatement.updateOne({ _id: refund._id }, { $set: { amount: 40 }, $push: { editHistory: { editedAt: new Date() } } });
  await tx((session) => operations.repostStatement(refund._id, { session }));
  // Not turned into a refund expense: still on the order's claim
  expect(await balanceOf('520200')).toBe(expenseBefore);
  const posted = await JournalEntry.findOne({ eventKey: `REFUND:${refund._id}:v2` }).lean();
  expect(posted.lines.some((l) => l.arKey && l.debit === 4000)).toBe(true);
});

test('7. cancelling an order with payments gives everything back to the wallet; the supplier cost waits for the accountant', async () => {
  const { returnOrderPayments } = require('../../utils/orderCancellation');
  const { processQueue } = require('../services/events');
  const OrderPaymentHistory = require('../../models/orderPaymentHistory');
  const Wallet = require('../../models/wallet');
  const { createBill } = require('../services/posting/payables');
  const exceptions = require('../services/reports/exceptions');
  const customer = await newCustomer();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'CXL-1', user: customer, placedAt: 'tripoli', isPayment: true, isShipment: false, unsureOrder: false, isCanceled: false,
    totalInvoice: 195, paymentList: [], createdAt: new Date('2026-03-01'),
  });
  await tx((session) => syncOrder(orderId, { session }));
  // 190$ from the wallet, 5$ cash on the order
  await Wallet.create({ user: customer, currency: 'USD', balance: 10 });
  const paidFromWallet = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'خصم', amount: 190, currency: 'USD', total: 10, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postStatement(paidFromWallet._id, { session, target: { orderId, category: 'invoice' } }));
  await OrderPaymentHistory.create({ order: orderId, customer, createdBy: admin._id, paymentType: 'wallet', category: 'invoice', receivedAmount: 190, currency: 'USD', statementId: paidFromWallet._id, createdAt: new Date('2026-03-02') });
  const cash = await OrderPaymentHistory.create({ order: orderId, customer, createdBy: admin._id, paymentType: 'cash', category: 'invoice', receivedAmount: 5, currency: 'USD', createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postCashPayment(cash._id, { session, office: 'tripoli' }));
  const vendor = await Vendor.create({ name: '1688', type: 'supplier' });
  await tx((session) => createBill({ vendorId: vendor._id, day: '2026-03-02', currency: 'USD', lines: [{ description: 'شراء', amount: 179.17, target: 'order', orderId }] }, { session, req }));
  const boxBefore = await balanceOf('110121');

  const order = await Order.findById(orderId).lean();
  const returned = await returnOrderPayments(order, admin);
  await Order.updateOne({ _id: orderId }, { $set: { isCanceled: true } });
  await require('../services/events').emitAccountingEvent('order', orderId, {});
  await processQueue();

  expect(returned.map((r) => r.amount)).toEqual([190, 5]);
  expect(await OrderPaymentHistory.countDocuments({ order: orderId })).toBe(0);
  // The wallet got all 195$ back, in the system and in the books
  expect((await Wallet.findOne({ user: customer, currency: 'USD' }).lean()).balance).toBe(205);
  // Books: the 190$ taken (debit) and the 195$ given back (credit)
  expect(await balanceOf('220100', { partnerId: customer })).toBe(19000 - 19500);
  // Nothing left on the customer's claim; the 5$ cash stays in the box
  expect(await balanceOf('121000', { arKey: `PUR:${orderId}` })).toBe(0);
  expect(await balanceOf('110121')).toBe(boxBefore);
  // The supplier cost waits on the order, listed for the accountant
  expect(await balanceOf('130200', { orderId })).toBe(17917);
  const check = await exceptions.CHECKS.canceledOrderCosts();
  expect(check.items.map((i) => i.label)).toContain('CXL-1');
});

test('8. a dinar wallet payment counts at its own rate: on the statement, or on the payment it made (old data)', async () => {
  const OrderPaymentHistory = require('../../models/orderPaymentHistory');
  const customer = await newCustomer();
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'RATE-1', user: customer, placedAt: 'benghazi', isPayment: true, isShipment: false, unsureOrder: false, isCanceled: false,
    totalInvoice: 70, paymentList: [], createdAt: new Date('2026-03-01'),
  });
  await tx((session) => syncOrder(orderId, { session }));
  const dep = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'إيداع', amount: 665, currency: 'LYD', total: 665, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'benghazi', createdAt: new Date('2026-03-01') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  // The statement has no rate (old screens); the payment it made says 9.5
  const paid = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'خصم', amount: 665, currency: 'LYD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-02') });
  await OrderPaymentHistory.create({ order: orderId, customer, createdBy: admin._id, paymentType: 'wallet', category: 'invoice', receivedAmount: 665, currency: 'LYD', rate: 9.5, statementId: paid._id, createdAt: new Date('2026-03-02') });
  await tx((session) => operations.postStatement(paid._id, { session, target: { orderId, category: 'invoice' } }));
  // 665 / 9.5 = 70$: the claim is fully paid, not at the day's rate of 10 (66.50$)
  expect(await balanceOf('121000', { arKey: `PUR:${orderId}` })).toBe(0);
  // The migration passes the rate it found on the matching payment
  const other = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'خصم', amount: 95, currency: 'LYD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-03-03') });
  await tx((session) => operations.postStatement(other._id, { session, isHistorical: true, target: { orderId, category: 'invoice', rate: 9.5 } }));
  const entry = await JournalEntry.findOne({ eventKey: `WALLET_PAYMENT:${other._id}` }).lean();
  expect(entry.lines.find((l) => l.arKey).credit).toBe(1000);
});

test('9. cancelling an old wallet payment with no link to its wallet line still reverses its entry exactly', async () => {
  const { refundWalletPayment } = require('../../utils/helperApi');
  const { processQueue } = require('../services/events');
  const OrderPaymentHistory = require('../../models/orderPaymentHistory');
  const Wallet = require('../../models/wallet');
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, packages: [{ weight: 3.05, price: 9.5, received: true }] });
  await tx((session) => syncOrder(order._id, { session }));
  // 305 LYD deposited at 10 (30.50$), the shipping paid at the payment's own rate 10.5281 (28.97$)
  const dep = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'إيداع', amount: 305, currency: 'LYD', total: 305, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-03-01T10:00:00Z') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  const paid = await UserStatement.create({ user: customer, createdBy: admin._id, description: 'تم دفع قيمة الشحن', amount: 305, currency: 'LYD', total: 0, paymentType: 'wallet', calculationType: '-', createdAt: new Date('2026-03-02T10:00:00Z') });
  await tx((session) => operations.postStatement(paid._id, { session, target: { orderId: order._id, packageIds: order.packageIds, category: 'receivedGoods', rate: 10.5281 } }));
  await Wallet.create({ user: customer, currency: 'LYD', balance: 0 });
  // The payment record from before the link existed: no statementId
  const payment = await OrderPaymentHistory.create({ order: order._id, customer, createdBy: admin._id, paymentType: 'wallet', category: 'receivedGoods', receivedAmount: 305, currency: 'LYD', rate: 10.5281, list: order.packageIds.map((id) => ({ id })), createdAt: new Date('2026-03-02T10:00:30Z') });
  const key = `SHP:${order._id}:${order.packageIds[0]}`;
  expect(await balanceOf('121000', { arKey: key })).toBe(0);

  await refundWalletPayment(admin, payment.toObject(), 'إلغاء', 'note');
  await processQueue();
  // Exactly the 28.97$ the payment counted for is owed again, and the wallet is back to its deposit
  expect(await balanceOf('121000', { arKey: key })).toBe(2897);
  const wallet = await getBalance((await account('220200'))._id, { partnerId: customer });
  expect(wallet).toMatchObject({ foreign: -305000, usd: -3050 });
});
