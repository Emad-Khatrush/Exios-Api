// A lost or partly damaged package compensated from the order page (owner's request 2026-11-02):
// the goods' value into the dollar or dinar wallet; the package closed (lost, or damaged by choice:
// billed only the shipping paid) or kept open (damaged: delivered and paid as usual).
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb } = require('./helpers');
const { OWNER_ID, call, usd, expectConsistent } = require('./e2eKit');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate } = require('../models');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const UserStatement = require('../../models/userStatement');
const wallet = require('../../controllers/wallet');
const orders = require('../../controllers/orders');
const comp = require('../services/packageCompensation');
const { loadDeliverablePackages } = require('../../utils/helperApi');

jest.setTimeout(180000);

let owner;
let clerk;
let customer;
const users = () => mongoose.connection.collection('users');
const now = () => new Date().toISOString();
const as = (user) => ({ user });
const balanceOf = async (currency) => (await Wallet.findOne({ user: customer._id, currency }).lean())?.balance || 0;

beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2025-01-01', rate: 10 }]);
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  await users().insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  const ids = (await users().insertMany([
    { username: 'clerk', firstName: 'Clerk', lastName: 'T', phone: 910000002, customerId: 'STF1', office: 'tripoli', roles: { isEmployee: true } },
    { username: 'c1', firstName: 'Customer', lastName: 'Z', phone: 910000004, customerId: 'C100', roles: { isClient: true } },
  ])).insertedIds;
  owner = await users().findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  clerk = await users().findOne({ _id: ids[0] });
  customer = await users().findOne({ _id: ids[1] });
  await call(wallet.addBalanceToWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount: 500, currency: 'USD', description: 'إيداع', note: 'x', actionType: 'cash', office: 'tripoli', createdAt: now() } });
});
afterAll(stopDb);

// One package of weight x price, arrived in Libya, not delivered
const shipment = async (weight, price) => {
  const order = (await call(orders.createOrder, {
    ...as(owner),
    body: {
      customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
      paymentList: JSON.stringify([{ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight, measureUnit: 'KG', exiosPrice: price, trackingNumber: `C${Date.now()}`, shipmentMethod: 'air' } }]),
    },
  })).body;
  const full = await Order.findById(order._id).lean();
  return { order: full, pkg: full.paymentList[0], key: `SHP:${full._id}:${full.paymentList[0]._id}` };
};
const payShipping = (order, amount) => call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount, currency: 'USD', rate: 0, orderId: order.orderId, category: 'receivedGoods', description: 'خصم', note: `Order Id (${order.orderId}) => شحن`, createdAt: now() } });
const run = (order, pkg, body, user = owner) => comp.compensate(String(order._id), String(pkg._id), body, { user });
const packageOf = async (order) => (await Order.findById(order._id).lean()).paymentList[0];

test('only an admin or the owner compensates; the goods value is required', async () => {
  const { order, pkg } = await shipment(1, 10);
  await expect(run(order, pkg, { type: 'lost', currency: 'USD', goodsAmount: 5, reason: 'x' }, clerk)).rejects.toMatchObject({ statusCode: 403 });
  await expect(run(order, pkg, { type: 'lost', currency: 'USD', goodsAmount: 0, reason: 'x' })).rejects.toThrow('البضاعة');
});

test('lost, shipping unpaid: goods to the wallet, the package closed, its unpaid shipping cancelled', async () => {
  const { order, pkg, key } = await shipment(5, 10);
  await expectConsistent('priced');
  expect(await usd('121000', { arKey: key })).toBe(5000);
  const before = await balanceOf('USD');
  const compBefore = await usd('520000');
  await run(order, pkg, { type: 'lost', currency: 'USD', goodsAmount: 105, reason: 'ضاع في الرحلة' });
  await expectConsistent('lost compensated');
  expect(await balanceOf('USD')).toBe(before + 105);
  expect(await usd('520000') - compBefore).toBe(10500);
  expect(await usd('520000', { orderId: order._id })).toBe(10500);
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect((await packageOf(order)).deliveredPackages.compensation).toMatchObject({ type: 'lost', closed: true });
  // Its only package closed: the order is finished, the package not marked received
  const finished = await Order.findById(order._id).lean();
  expect(finished).toMatchObject({ isFinished: true, orderStatus: 4 });
  expect(finished.paymentList[0].status.received).toBe(false);
  expect(finished.activity.at(-1).description).toContain('تم تعويض العميل عن الطرد');
  const statement = await UserStatement.findOne({ 'packageCompensation.packageId': pkg._id }).lean();
  expect(statement.actionType).toBe('compensation');
  await expect(loadDeliverablePackages(customer._id, [{ id: String(pkg._id), orderId: order.orderId }])).rejects.toThrow('closed');
  // The customer's own statement screen cannot delete it
  await expect(call(wallet.deleteStatement, { ...as(owner), params: { id: String(customer._id), statementId: String(statement._id) } })).rejects.toThrow('order page');
});

test('lost, shipping paid: the paid shipping stays earned, only the goods are compensated', async () => {
  const { order, pkg, key } = await shipment(5, 10);
  await payShipping(order, 50);
  await expectConsistent('paid before delivery');
  const before = await balanceOf('USD');
  await run(order, pkg, { type: 'lost', currency: 'USD', goodsAmount: 80, reason: 'ضاع' });
  await expectConsistent('lost with paid shipping');
  expect(await balanceOf('USD')).toBe(before + 80);
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect(-(await usd('410100', { arKey: key }))).toBe(5000);
});

test('damaged and kept open: goods in dinars, then delivered and its shipping paid in full', async () => {
  const { order, pkg, key } = await shipment(5, 10);
  const lydBefore = await balanceOf('LYD');
  const compBefore = await usd('520000');
  await run(order, pkg, { type: 'damaged', currency: 'LYD', rate: 10, goodsAmount: 100, close: false, reason: 'كسر' });
  await expectConsistent('damaged compensated');
  expect((await packageOf(order)).deliveredPackages.compensation).toMatchObject({ type: 'damaged', closed: false });
  expect((await Order.findById(order._id).lean()).isFinished).toBe(false);
  expect(await balanceOf('LYD')).toBe(lydBefore + 100);
  expect(await usd('520000') - compBefore).toBe(1000);
  expect(await usd('121000', { arKey: key })).toBe(5000);
  const { totalCost } = await loadDeliverablePackages(customer._id, [{ id: String(pkg._id), orderId: order.orderId }]);
  expect(totalCost).toBe(50);
  await call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(pkg._id), orderId: order.orderId }], payment: { amountUSD: 50 } } });
  await expectConsistent('delivered');
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect(-(await usd('410100', { arKey: key }))).toBe(5000);
});

test('damaged and closed: no delivery, the unpaid shipping cancelled', async () => {
  const { order, pkg, key } = await shipment(3, 10);
  await run(order, pkg, { type: 'damaged', currency: 'USD', goodsAmount: 20, close: true, reason: 'تالف' });
  await expectConsistent('damaged closed');
  expect(await usd('121000', { arKey: key })).toBe(0);
  await expect(loadDeliverablePackages(customer._id, [{ id: String(pkg._id), orderId: order.orderId }])).rejects.toThrow('closed');
  // Editing the order from its page (which sends no compensation, or a forged one) keeps it as stored
  const saved = await Order.findById(order._id).lean();
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: saved.paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, compensation: undefined, abandoned: { status: 'sold' } } })) } });
  const after = (await packageOf(order)).deliveredPackages;
  expect(after.compensation).toMatchObject({ type: 'damaged', closed: true });
  expect(after.abandoned?.status).toBeUndefined();
  await expectConsistent('edited after the compensation');
});

test('undo: the wallet line goes, the package is owed again; refused once the money is spent', async () => {
  const { order, pkg, key } = await shipment(2, 10);
  const before = await balanceOf('USD');
  const compBefore = await usd('520000');
  await run(order, pkg, { type: 'lost', currency: 'USD', goodsAmount: 40, reason: 'x' });
  await expectConsistent('compensated');
  expect(await usd('121000', { arKey: key })).toBe(0);
  await comp.undo(String(order._id), String(pkg._id), { user: owner });
  await expectConsistent('undone');
  expect(await balanceOf('USD')).toBe(before);
  expect(await usd('520000')).toBe(compBefore);
  expect(await usd('121000', { arKey: key })).toBe(2000);
  expect((await packageOf(order)).deliveredPackages.compensation?.type).toBeUndefined();
  // The order it had finished is open again
  expect((await Order.findById(order._id).lean()).isFinished).toBe(false);

  // Compensated again, the customer spends the money: the undo is refused
  await run(order, pkg, { type: 'lost', currency: 'LYD', rate: 10, goodsAmount: 300, reason: 'x' });
  const other = await shipment(30, 10);
  await call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount: 300, currency: 'LYD', rate: 10, orderId: other.order.orderId, category: 'receivedGoods', description: 'خصم', note: 'x', createdAt: now() } });
  await expectConsistent('dinars spent');
  await expect(comp.undo(String(order._id), String(pkg._id), { user: owner })).rejects.toThrow('لا يمكن التراجع');
});

test('two packages: closing one leaves the order as it is; delivering the other finishes it', async () => {
  const order = (await call(orders.createOrder, {
    ...as(owner),
    body: {
      customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
      paymentList: JSON.stringify([1, 2].map((i) => ({ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: 1, measureUnit: 'KG', exiosPrice: 10, trackingNumber: `T${Date.now()}${i}`, shipmentMethod: 'air' } }))),
    },
  })).body;
  const full = await Order.findById(order._id).lean();
  const [lostPkg, otherPkg] = full.paymentList;
  await run(full, lostPkg, { type: 'lost', currency: 'USD', goodsAmount: 15, reason: 'ضاع' });
  await expectConsistent('one of two lost');
  const after = await Order.findById(order._id).lean();
  expect(after.isFinished).toBe(false);
  expect(after.orderStatus).toBe(full.orderStatus);
  await call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(otherPkg._id), orderId: full.orderId }], payment: { amountUSD: 10 } } });
  await expectConsistent('the other delivered');
  expect(await Order.findById(order._id).lean()).toMatchObject({ isFinished: true, orderStatus: 4 });
});
