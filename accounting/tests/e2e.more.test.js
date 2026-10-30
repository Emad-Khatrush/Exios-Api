// Second wave of end-to-end cases (owner's request, 2026-10-03): domestic trips, volumetric
// weight, abandoned goods, write-offs, staff costs, Alipay transfers, partner debts, sub boxes,
// netting, removed packages and a currency with no rate yet; the books checked after each step.
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { OWNER_ID, call, net, usd, expectConsistent } = require('./e2eKit');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry, AccountingEvent } = require('../models');
const docs = require('../models/documents');
const { processQueue } = require('../services/events');
const { runInTransaction } = require('../services/transaction');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const wallet = require('../../controllers/wallet');
const orders = require('../../controllers/orders');
const balance = require('../../controllers/balance');
const inventory = require('../../controllers/inventory');
const staff = require('../services/staffOperations');
const payables = require('../services/posting/payables');

jest.setTimeout(180000);

let owner;
let clerk;
let clerk2;
let customer;
const users = () => mongoose.connection.collection('users');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const as = (user) => ({ user });

beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01'), abandonAfterDays: 1 } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2025-01-01', rate: 10 }, { currency: 'CNY', day: '2025-01-01', rate: 7 }]);
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  await users().insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  const ids = (await users().insertMany([
    { username: 'clerk', firstName: 'Clerk', lastName: 'T', phone: 910000002, customerId: 'STF1', office: 'tripoli', roles: { isEmployee: true } },
    { username: 'clerk2', firstName: 'Clerk', lastName: 'B', phone: 910000003, customerId: 'STF2', office: 'benghazi', roles: { isEmployee: true } },
    { username: 'c1', firstName: 'Customer', lastName: 'Z', phone: 910000004, customerId: 'C100', roles: { isClient: true } },
  ])).insertedIds;
  owner = await users().findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  clerk = await users().findOne({ _id: ids[0] });
  clerk2 = await users().findOne({ _id: ids[1] });
  customer = await users().findOne({ _id: ids[2] });
  await call(wallet.addBalanceToWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount: 2000, currency: 'USD', description: 'إيداع', note: 'x', actionType: 'cash', office: 'tripoli', createdAt: now() } });
});
afterAll(stopDb);

const shipment = async (packages) => (await call(orders.createOrder, {
  ...as(owner),
  body: {
    customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
    paymentList: JSON.stringify(packages.map((p, i) => ({ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: p.weight, measureUnit: 'KG', exiosPrice: p.price, trackingNumber: `M${Date.now()}${i}`, shipmentMethod: 'air', ...(p.volumetric && { volumetric: p.volumetric }) } }))),
  },
})).body;
const purchase = async (amount, extra = {}) => (await call(orders.createOrder, {
  ...as(owner), body: { customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'x', unitPrice: amount, quantity: 1 }]), paymentList: '[]', ...extra },
})).body;
const deliver = (order, pkgs, payment) => call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: pkgs.map((p) => ({ id: String(p._id), orderId: order.orderId })), payment } });
const pay = (order, amount, currency = 'USD', rate = 0, category = 'invoice') => call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount, currency, rate, orderId: order.orderId, category, description: 'خصم', note: `Order Id (${order.orderId}) => x`, createdAt: now() } });

test('1. a domestic trip: packages sent from the Tripoli warehouse to Benghazi carry its cost; delivered there', async () => {
  const order = await shipment([{ weight: 10, price: 10 }, { weight: 30, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  await call(inventory.addOrdersToTheInventory, { ...as(owner), query: { office: 'tripoli' }, body: full.paymentList.map((p) => ({ paymentList: { _id: String(p._id) } })) });
  const trip = (await call(inventory.createInternalShipping, { ...as(owner), params: { office: 'tripoli' }, body: { paymentListIds: full.paymentList.map((p) => String(p._id)), voyage: 'TRP-BEN', destination: 'benghazi' } })).body;
  const tripId = trip?._id || trip?.shipment?._id || (await mongoose.connection.collection('inventories').findOne({ voyage: 'TRP-BEN' }))._id;
  await expectConsistent('domestic trip created');
  await staff.addTripCost(tripId, { vendorName: 'نقل', amount: 80, payFromAccountId: (await account('110121'))._id, costCategory: 'transport', day: today() }, { user: owner });
  await expectConsistent('domestic cost');
  await deliver(full, full.paymentList, { amountUSD: 400 });
  await expectConsistent('delivered in Benghazi');
  expect(await usd('510300')).toBe(8000);
  expect(await usd('130100', { tripId: new mongoose.Types.ObjectId(String(tripId)) })).toBe(0);
});

test('2. volumetric weight: billed by volume; a clerk cannot change the saved measures', async () => {
  const order = await shipment([{ weight: 2, price: 10, volumetric: { enabled: true, cbm: 0.03 } }]);
  const full = await Order.findById(order._id).lean();
  expect(full.paymentList[0].deliveredPackages.weight.total).toBe(5.01);
  await expectConsistent('volumetric priced');
  expect(await usd('121000', { arKey: `SHP:${order._id}:${full.paymentList[0]._id}` })).toBe(5010);
  await expect(call(orders.updateOrder, { ...as(clerk), params: { id: String(order._id) }, body: { paymentList: full.paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, weight: { ...p.deliveredPackages.weight, total: 1 }, volumetric: { enabled: false } } })) } })).rejects.toMatchObject({ statusCode: 403 });
});

test('3. abandoned goods: declared, undone, declared again and sold', async () => {
  const abandoned = require('../services/abandoned');
  const order = await shipment([{ weight: 5, price: 10 }]);
  const pkg = (await Order.findById(order._id).lean()).paymentList[0];
  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg._id }, { $set: { 'paymentList.$.deliveredPackages.arrivedAt': new Date('2025-01-01') } });
  const key = `SHP:${order._id}:${pkg._id}`;
  await abandoned.declareAbandoned(String(order._id), String(pkg._id), { user: owner });
  await expectConsistent('declared');
  expect(await usd('121000', { arKey: key })).toBe(0);
  await abandoned.restoreAbandoned(String(order._id), String(pkg._id), { user: owner });
  await expectConsistent('undone');
  expect(await usd('121000', { arKey: key })).toBe(5000);
  await abandoned.declareAbandoned(String(order._id), String(pkg._id), { user: owner });
  await abandoned.sellAbandoned(String(order._id), String(pkg._id), { amount: 30, accountId: String((await account('110101'))._id), day: today() }, { user: owner });
  await expectConsistent('sold');
  expect(-(await usd('410800'))).toBe(3000);
});

test('4. a delivered unpaid package written off, then the customer pays after all', async () => {
  const { createWriteOff } = require('../services/posting/writeOff');
  const order = await shipment([{ weight: 3, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  const pkg = full.paymentList[0];
  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg._id }, { $set: { 'paymentList.$.status.received': true } });
  await require('../services/events').emitAccountingEvent('order', order._id, {});
  await expectConsistent('delivered unpaid');
  const key = `SHP:${order._id}:${pkg._id}`;
  await runInTransaction((session) => createWriteOff({ day: today(), arKey: key, reason: 'لن يدفع' }, { session, req: { user: owner } }));
  await expectConsistent('written off');
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect(Math.abs(await usd('410100', { arKey: key }))).toBe(0);
  await pay(full, 30, 'USD', 0, 'receivedGoods');
  await expectConsistent('paid after the write-off');
  expect(-(await usd('410100', { arKey: key }))).toBe(3000);
});

test('5. a trip cost by a clerk: refused to another clerk, taken back by them the same day', async () => {
  const trip = (await call(inventory.createInventory, { ...as(owner), body: { voyage: 'AIR-S', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN' } })).body;
  const [mainBefore, subBefore] = [await usd('110101'), await usd('110121')];
  const bill = await staff.addTripCost(trip._id, { vendorName: 'Cargo', amount: 50, payFromAccountId: (await account('110101'))._id, day: today() }, { user: clerk });
  await expectConsistent('clerk cost');
  // A clerk's cash comes out of their office's sub box whatever box was picked
  expect(await usd('110101')).toBe(mainBefore);
  expect(await usd('110121')).toBe(subBefore - 5000);
  await expect(staff.cancelOwnBill(String(bill._id), { user: clerk2 }, 'x')).rejects.toMatchObject({ statusCode: 403 });
  await staff.cancelOwnBill(String(bill._id), { user: clerk }, 'خطأ');
  await expectConsistent('taken back');
  expect(await usd('130100', { tripId: trip._id })).toBe(0);
});

test('6. an Alipay transfer order: paid by the customer, the yuan sent from Alipay at its average rate', async () => {
  const alipay = require('../services/posting/alipay');
  const box = await account('110301');
  const broker = await docs.Vendor.create({ name: 'وصل', type: 'service' });
  const usdBank = await account('110202');
  await runInTransaction((session) => alipay.createYuanPurchase({ vendorId: broker._id, day: today(), fromAccountId: usdBank._id, amount: 1000, toAccountId: box._id, cnyReceived: 6600 }, { session, req: { user: owner } }));
  const order = await purchase(1000, { isRemittance: 'true' });
  await Order.updateOne({ _id: order._id }, { $set: { isRemittance: true } });
  await pay(order, 1000);
  await runInTransaction((session) => alipay.sendRemittance(order._id, { accountId: String(box._id), cny: 6500, day: today() }, { session, req: { user: owner } }));
  await expectConsistent('remittance');
  expect(-(await usd('410700'))).toBe(100000);
  expect(await usd('510700')).toBe(98485);
});

test('6a. Alipay sent-yuan totals use only the bill lines for the selected order', async () => {
  const alipay = require('../services/posting/alipay');
  const box = await account('110301');
  const first = await purchase(100, { isRemittance: 'true' });
  const second = await purchase(100, { isRemittance: 'true' });
  await Order.updateMany({ _id: { $in: [first._id, second._id] } }, { $set: { isRemittance: true } });
  const vendor = await docs.Vendor.create({ name: 'Shared Alipay supplier', type: 'service' });
  const expense = await account('530800');
  await runInTransaction((session) => payables.createBill({
    vendorId: vendor._id, day: today(), currency: 'CNY', paidImmediatelyFrom: box._id,
    lines: [
      { description: 'First order', amount: 20, target: 'order', orderId: first._id },
      { description: 'Second order', amount: 30, target: 'order', orderId: second._id },
      { description: 'Shared fee', amount: 50, target: 'expense', accountId: expense._id, office: 'tripoli' },
    ],
  }, { session, req: { user: owner } }));
  const firstStatus = await alipay.remittanceStatus(first._id);
  const secondStatus = await alipay.remittanceStatus(second._id);
  expect(firstStatus.sentCny).toBe(20);
  expect(secondStatus.sentCny).toBe(30);
  await expectConsistent('shared Alipay vendor bill');
});

test('7. a tax the partner (Asswaq) paid for a customer: a debt on the customer from that account, paid from the wallet', async () => {
  const asswaq = await account('260100');
  const debt = (await call(balance.createBalance, { ...as(owner), body: { balanceType: 'debt', amount: 50, currency: 'USD', customerId: 'C100', notes: 'ضريبة', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String(asswaq._id) } })).body;
  await expectConsistent('debt from Asswaq');
  expect(await usd('260100')).toBe(-5000);
  await call(balance.createPaymentHistory, { ...as(owner), params: { id: String(debt._id) }, body: { amount: 50, currency: 'USD', rate: 1, createdAt: now() } });
  await expectConsistent('debt paid');
  expect(await usd('121000', { arKey: `GEN:${debt._id}` })).toBe(0);
});

test('8. a sub box handed over to the main box', async () => {
  const { subBoxes, handOver } = require('../services/subBoxes');
  await call(wallet.addBalanceToWallet, { ...as(clerk2), params: { id: String(customer._id) }, body: { amount: 120, currency: 'USD', description: 'إيداع', note: 'x', actionType: 'cash', office: 'benghazi', createdAt: now() } });
  await expectConsistent('cash into the Benghazi sub box');
  const sub = (await subBoxes()).find((r) => r.subCode === '110123');
  const before = await usd('110103');
  await runInTransaction((session) => handOver(sub.subId, { session, req: { user: owner } }));
  await expectConsistent('handed over');
  expect(await usd('110123')).toBe(0);
  expect(await usd('110103')).toBe(before + 12000);
});

test('9. netting a supplier bill into the customer\'s wallet, then cancelled', async () => {
  const people = require('../services/posting/people');
  const { cancelDocument } = require('../services/cancel');
  const vendor = await docs.Vendor.create({ name: 'شريك', type: 'service', linkedCustomer: customer._id });
  const bill = (await call(require('../controllers/documents').createBill, { ...as(owner), body: { vendorId: String(vendor._id), day: today(), currency: 'USD', lines: [{ description: 'خدمة', amount: 40, target: 'expense', accountId: String((await account('530800'))._id), office: 'tripoli' }] } })).body;
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const netting = await runInTransaction((session) => people.createNetting({ vendorId: vendor._id, customerId: customer._id, day: today(), mode: 'payable_to_wallet', billId: bill._id, walletCurrency: 'USD', amountUsd: 4000 }, { session, req: { user: owner } }));
  await expectConsistent('netted into the wallet');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before + 40);
  await runInTransaction((session) => cancelDocument('AccountingNetting', netting._id, { session, req: { user: owner }, reason: 'x', confirmNegative: true }));
  await expectConsistent('netting cancelled');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before);
});

test('10. a priced package removed from the order before payment: its claim goes', async () => {
  const order = await shipment([{ weight: 2, price: 10 }, { weight: 1, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  await expectConsistent('two packages priced');
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: [full.paymentList[0]] } });
  await expectConsistent('one removed');
  expect(await usd('121000', { arKey: `SHP:${order._id}:${full.paymentList[1]._id}` })).toBe(0);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${full.paymentList[0]._id}` })).toBe(2000);
});

test('11. a cash payment in euros: refused without a rate; with no euro box it waits with its reason until a box is added', async () => {
  const order = await purchase(50);
  await expect(call(orders.addPaymentToOrder, { ...as(owner), params: { id: String(order._id) }, body: { receivedAmount: 45, currency: 'EURO', paymentType: 'cash', category: 'invoice', customerId: String(customer._id), list: '[]', rate: 0, createdAt: now() } })).rejects.toMatchObject({ statusCode: 400 });
  await call(orders.addPaymentToOrder, { ...as(owner), params: { id: String(order._id) }, body: { receivedAmount: 45, currency: 'EURO', paymentType: 'cash', category: 'invoice', customerId: String(customer._id), list: '[]', rate: 0.9, createdAt: now() } });
  await processQueue();
  const failed = await AccountingEvent.findOne({ type: 'cashPayment' }).sort({ createdAt: -1 }).lean();
  expect(failed.status).toBe('failed');
  expect(failed.lastError).toBeTruthy();
  // A euro box for the office, then the waiting payment is retried
  const { Account } = require('../models');
  const group = await Account.findOne({ code: '110121' }).lean();
  const box = await Account.create({ code: '110199', name: 'خزينة طرابلس فرعية - يورو', type: 'asset', currency: 'EUR', isCash: true, cashKind: 'cash', parentId: group.parentId, office: 'tripoli' });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { 'subOfficeAccounts.tripoli.EUR': box._id } });
  invalidateConfig();
  await AccountingEvent.updateMany({ status: 'failed' }, { $set: { attempts: 0 } });
  await processQueue();
  await expectConsistent('euro posted');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
});
