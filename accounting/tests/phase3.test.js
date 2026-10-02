const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { JournalEntry, AccountingSettings, CurrencyRate, AccountingEvent } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const operations = require('../services/posting/operations');
const payables = require('../services/posting/payables');
const events = require('../services/events');
const { refreshTripPackages } = require('../services/tripLinks');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const UserStatement = require('../../models/userStatement');
const Balance = require('../../models/balance');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const req = { user: { _id: oid() } };
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;

const setLive = async (liveEnabled) => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled } });
  invalidateConfig();
};

beforeEach(async () => {
  await resetDb();
  await setLive(true);
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 9 }]);
});

let customerSeq = 0;
const newCustomer = async () => {
  customerSeq++;
  return (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: String(customerSeq), customerId: `T${customerSeq}`, phone: 910000000 + customerSeq })).insertedId;
};

// packages: [{ weight, price, received, method }]
async function newOrder({ user, isPayment = false, totalInvoice = 0, packages = [] }) {
  const paymentList = packages.map((p) => ({
    _id: oid(),
    status: { arrived: true, arrivedLibya: true, paid: false, received: !!p.received },
    deliveredPackages: { trackingNumber: `TRK${Math.random().toString(36).slice(2, 7)}`, weight: { total: p.weight, measureUnit: 'KG' }, exiosPrice: p.price, shipmentMethod: p.method || 'air' },
  }));
  const { insertedId } = await Order.collection.insertOne({
    orderId: `O${Date.now()}${Math.random().toString(36).slice(2, 6)}`, user, placedAt: 'tripoli', isPayment, isShipment: !isPayment,
    totalInvoice, unsureOrder: false, isCanceled: false, shipment: { method: 'air' }, paymentList, createdAt: new Date('2026-01-02'),
  });
  return { _id: insertedId, packageIds: paymentList.map((p) => p._id) };
}

// A trip holding these packages; their trip links follow, as the trip screens do
const newTrip = async (packageIds, shippingType = 'air') => {
  const { insertedId } = await Inventory.collection.insertOne({
    voyage: 'AIR-TEST', inventoryType: 'inventoryGoods', shippingType, inventoryPlace: 'tripoli', status: 'processing',
    orders: packageIds.map((id) => ({ paymentList: { _id: id } })), createdAt: new Date(),
  });
  await refreshTripPackages(insertedId);
  return insertedId;
};

const statement = (user, fields) => UserStatement.create({
  user, createdBy: oid(), description: 'حركة', total: 0, paymentType: 'wallet', createdAt: new Date('2026-01-05'), ...fields,
});
const deposit = (user, amount, currency, extra = {}) => statement(user, { amount, currency, calculationType: '+', actionType: 'cash', office: 'tripoli', ...extra });
const spend = (user, amount, currency, extra = {}) => statement(user, { amount, currency, calculationType: '-', actionType: 'wallet', ...extra });

const post = (statementDoc, options = {}) => tx((session) => operations.postStatement(statementDoc._id, { session, ...options }));
const sync = (orderId) => tx((session) => syncOrder(orderId, { session }));
const deliver = async (orderId, packageId) => {
  await Order.updateOne({ _id: orderId, 'paymentList._id': packageId }, { $set: { 'paymentList.$.status.received': true } });
  return sync(orderId);
};
const arKey = (orderId, packageId) => `SHP:${orderId}:${packageId}`;
const open = async (key) => (await operations.openBalances([key])).get(key) || 0;

test('scenario 1: dollar shipment paid in dinars, recognised only on delivery', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 50, price: 10 }] }); // 500$
  const [pkg] = order.packageIds;
  await newTrip([pkg]);
  await sync(order._id);
  expect(await open(arKey(order._id, pkg))).toBe(50000);
  expect(await balanceOf('220400')).toBe(-50000);

  await post(await deposit(user, 4500, 'LYD'));
  const payment = await spend(user, 4500, 'LYD', { rate: 9 });
  await post(payment, { target: { orderId: order._id, packageIds: [pkg] } });
  expect(await open(arKey(order._id, pkg))).toBe(0);
  expect(await getBalance((await account('220200'))._id, { partnerId: user })).toEqual({ usd: 0, foreign: 0 });
  expect(await balanceOf('410100')).toBe(0); // not delivered yet

  await deliver(order._id, pkg);
  expect(await balanceOf('410100')).toBe(-50000);
  expect(await balanceOf('220400')).toBe(0);
  // nothing anywhere is worth 4500$
  const big = await JournalEntry.countDocuments({ 'lines.debit': { $gte: 450000 } });
  expect(big).toBe(0);
});

test('scenario 2: delivered before paid stays deferred, recognised on payment', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 30, price: 10, received: true }] });
  const [pkg] = order.packageIds;
  await sync(order._id);
  expect(await balanceOf('410100')).toBe(0);
  expect(await open(arKey(order._id, pkg))).toBe(30000);

  await post(await deposit(user, 300, 'USD'));
  await post(await spend(user, 300, 'USD'), { target: { orderId: order._id, packageIds: [pkg] } });
  expect(await balanceOf('410100')).toBe(-30000);
});

test('scenario 3: one payment in two currencies over three packages', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 10, price: 10 }, { weight: 15, price: 10 }, { weight: 25, price: 10 }] });
  await sync(order._id);
  await post(await deposit(user, 200, 'USD'));
  await post(await deposit(user, 2700, 'LYD'));
  const target = { orderId: order._id, packageIds: order.packageIds };
  await post(await spend(user, 200, 'USD'), { target });
  await post(await spend(user, 2700, 'LYD', { rate: 9 }), { target });
  for (const pkg of order.packageIds) expect(await open(arKey(order._id, pkg))).toBe(0);
});

test('scenario 4: the dinar rate difference is booked the moment the wallet pays', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 9, price: 10 }] }); // 90$
  const [pkg] = order.packageIds;
  await sync(order._id);
  await post(await deposit(user, 900, 'LYD')); // day rate 9 -> 100$
  const payment = await spend(user, 900, 'LYD', { rate: 10 });
  await post(payment, { target: { orderId: order._id, packageIds: [pkg] } });

  const entry = await JournalEntry.findOne({ eventType: 'WALLET_PAYMENT' });
  expect(entry.lines.find((l) => l.accountCode === '220200').debit).toBe(10000);
  expect(entry.lines.find((l) => l.accountCode === '121000').credit).toBe(9000);
  expect(entry.lines.find((l) => l.accountCode === '710100').credit).toBe(1000);
  expect(await getBalance((await account('220200'))._id, { partnerId: user })).toEqual({ usd: 0, foreign: 0 });
});

test('scenario 5: trip profit with partial recognition, a late cost and the rest', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 100, price: 10 }, { weight: 150, price: 10 }, { weight: 250, price: 10 }] });
  const [a, b, c] = order.packageIds;
  const trip = await newTrip([a, b, c]);
  const carrier = await Vendor.create({ name: 'ناقل', type: 'carrier' });
  await tx((session) => payables.createBill({ vendorId: carrier._id, day: '2026-01-03', currency: 'USD', lines: [
    { description: 'شحن جوي', amount: 3000, target: 'trip', tripId: trip },
    { description: 'تخليص', amount: 200, target: 'trip', tripId: trip },
  ] }, { session, req }));
  await sync(order._id);

  await post(await deposit(user, 5000, 'USD'));
  await post(await spend(user, 1000, 'USD'), { target: { orderId: order._id, packageIds: [a] } });
  await deliver(order._id, a);
  expect(await balanceOf('410100')).toBe(-100000);
  expect(await balanceOf('510100')).toBe(64000);

  // a late cost: A's share is trued up, the rest waits in progress
  await tx((session) => payables.createBill({ vendorId: carrier._id, day: '2026-01-10', currency: 'USD', lines: [
    { description: 'رسوم متأخرة', amount: 300, target: 'trip', tripId: trip },
  ] }, { session, req }));
  expect(await balanceOf('510100')).toBe(70000);
  expect(await balanceOf('130100')).toBe(280000);

  await post(await spend(user, 4000, 'USD'), { target: { orderId: order._id, packageIds: [b, c] } });
  await deliver(order._id, b);
  await deliver(order._id, c);
  expect(await balanceOf('410100')).toBe(-500000);
  expect(await balanceOf('510100')).toBe(350000);
  expect(await balanceOf('130100')).toBe(0);
});

test('scenario 6 end: purchase invoice paid in full recognises sale and supplier costs', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, isPayment: true, totalInvoice: 500 });
  const supplier = await Vendor.create({ name: 'مورد', type: 'supplier' });
  await tx((session) => payables.createBill({ vendorId: supplier._id, day: '2026-01-03', currency: 'USD', lines: [
    { description: 'بضاعة', amount: 430, target: 'order', orderId: order._id },
  ] }, { session, req }));
  await sync(order._id);
  await post(await deposit(user, 500, 'USD'));
  await post(await spend(user, 500, 'USD'), { target: { orderId: order._id, category: 'invoice' } });
  expect(await balanceOf('410300')).toBe(-50000);
  expect(await balanceOf('510400')).toBe(43000);
  expect(await balanceOf('130200')).toBe(0);

  // a supplier bill after the sale goes straight to cost
  await tx((session) => payables.createBill({ vendorId: supplier._id, day: '2026-01-20', currency: 'USD', lines: [
    { description: 'شحن داخلي', amount: 20, target: 'order', orderId: order._id },
  ] }, { session, req }));
  expect(await balanceOf('510400')).toBe(45000);
});

test('scenario 7: cancelling a paid delivery gives the dinars back and un-recognises the revenue', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 50, price: 10 }] });
  const [pkg] = order.packageIds;
  await sync(order._id);
  await post(await deposit(user, 4500, 'LYD'));
  const payment = await spend(user, 4500, 'LYD', { rate: 9 });
  await post(payment, { target: { orderId: order._id, packageIds: [pkg] } });
  await deliver(order._id, pkg);
  expect(await balanceOf('410100')).toBe(-50000);

  // the invoice cancel: package back to "not received", money back to the wallet
  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg }, { $set: { 'paymentList.$.status.received': false } });
  const refund = await deposit(user, 4500, 'LYD', { actionType: 'cancellation', office: undefined });
  await post(refund, { reverses: payment._id, target: { orderId: order._id, packageIds: [pkg] } });
  expect(await open(arKey(order._id, pkg))).toBe(50000);
  expect(await balanceOf('410100')).toBe(0);
  expect(await getBalance((await account('220200'))._id, { partnerId: user })).toEqual({ usd: -50000, foreign: -4500000 });
});

test('scenario 8: posting and syncing twice changes nothing', async () => {
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 10, price: 10, received: true }] });
  await sync(order._id);
  const dep = await deposit(user, 100, 'USD');
  await post(dep);
  await post(dep);
  const count = await JournalEntry.countDocuments();
  await sync(order._id);
  await sync(order._id);
  expect(await JournalEntry.countDocuments()).toBe(count);
});

test('re-pricing, customer change and order cancellation follow the order', async () => {
  const first = await newCustomer();
  const second = await newCustomer();
  const order = await newOrder({ user: first, packages: [{ weight: 10, price: 10 }] });
  const [pkg] = order.packageIds;
  await sync(order._id);

  await Order.updateOne({ _id: order._id, 'paymentList._id': pkg }, { $set: { 'paymentList.$.deliveredPackages.exiosPrice': 12 } });
  await sync(order._id);
  expect(await open(arKey(order._id, pkg))).toBe(12000);

  await Order.updateOne({ _id: order._id }, { $set: { user: second } });
  await sync(order._id);
  expect(await balanceOf('121000', { partnerId: second })).toBe(12000);
  expect(await balanceOf('121000', { partnerId: first })).toBe(0);

  await Order.updateOne({ _id: order._id }, { $set: { isCanceled: true } });
  await sync(order._id);
  expect(await balanceOf('121000')).toBe(0);
  expect(await balanceOf('220400')).toBe(0);
});

test('deposits without an office wait in suspense; compensation is an expense', async () => {
  const user = await newCustomer();
  await post(await deposit(user, 100, 'USD', { office: undefined }));
  expect(await balanceOf('399000')).toBe(10000);
  const entry = await JournalEntry.findOne({ eventType: 'DEPOSIT' });
  expect(entry.fallbacks.join()).toMatch('المعلّق');

  await post(await deposit(user, 50, 'USD', { actionType: 'compensation' }));
  expect(await balanceOf('520000')).toBe(5000);
});

test('general debts: claim, paid from the wallet, remainder written off', async () => {
  const user = await newCustomer();
  const { insertedId: debtId } = await Balance.collection.insertOne({
    owner: user, createdBy: oid(), createdOffice: 'tripoli', balanceType: 'debt', amount: 100, initialAmount: 100,
    currency: 'USD', debtType: 'general', status: 'open', notes: 'دين', createdAt: new Date('2026-01-02'),
  });
  await tx((session) => operations.postGeneralDebt(debtId, { session }));
  expect(await open(`GEN:${debtId}`)).toBe(10000);

  await post(await deposit(user, 99.9, 'USD'));
  await post(await spend(user, 99.9, 'USD'), { target: { balanceId: debtId } });
  await Balance.collection.updateOne({ _id: debtId }, { $set: { status: 'closed', manualClosure: { note: 'فرق بسيط', writtenOffAmount: 0.1, closedAt: new Date('2026-01-06') } } });
  await tx((session) => operations.postDebtWriteOff(debtId, { session }));
  expect(await open(`GEN:${debtId}`)).toBe(0);
  expect(await balanceOf('520100')).toBe(10);
});

test('the outbox records events while live posting is off, posts nothing until it is on, then posts in order', async () => {
  const user = await newCustomer();
  await setLive(false);
  const dep = await deposit(user, 100, 'USD');
  await events.emitAccountingEvent('statement', dep._id);
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(1);
  expect((await events.processQueue()).processed).toBe(0);
  expect(await JournalEntry.countDocuments()).toBe(0);
  const order = await newOrder({ user, packages: [{ weight: 10, price: 10, received: true }] });
  expect((await sync(order._id)).skipped).toBeTruthy();

  // Recorded before the migration read the data: covered by it, never posted live
  expect(await events.markCovered(new Date())).toBe(1);
  expect(await AccountingEvent.countDocuments({ status: 'covered' })).toBe(1);

  await setLive(true);
  await events.emitAccountingEvent('order', order._id);
  await events.emitAccountingEvent('statement', dep._id);
  const pay = await spend(user, 100, 'USD');
  await events.emitAccountingEvent('statement', pay._id, { target: { orderId: order._id, packageIds: order.packageIds } });
  const result = await events.processQueue();
  expect(result).toEqual({ processed: 3, done: 3 });
  expect(await balanceOf('410100')).toBe(-10000);

  // no dinar rate that far back: the first later rate is used, and the entry says so
  const early = await deposit(user, 18, 'LYD', { createdAt: new Date('2025-06-01') });
  await events.emitAccountingEvent('statement', early._id);
  await events.processQueue();
  const entry = await JournalEntry.findOne({ 'source.id': early._id });
  expect(entry.fallbacks.join(' ')).toMatch('أقرب سعر بعد');

  // with that option off, an event that cannot post waits with its error
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { rateFallbackNext: false } });
  invalidateConfig();
  const lyd = await deposit(user, 10, 'LYD', { createdAt: new Date('2025-06-01') });
  await events.emitAccountingEvent('statement', lyd._id);
  await events.processQueue();
  const failed = await AccountingEvent.findOne({ status: 'failed' });
  expect(failed.lastError).toMatch('سعر صرف');
});

test('customers and their invoices as the books see them', async () => {
  const { customersList, customerInvoices } = require('../services/reports/customers');
  const user = await newCustomer();
  const paidOrder = await newOrder({ user, packages: [{ weight: 30, price: 10, received: true }] }); // 300$
  const openOrder = await newOrder({ user, packages: [{ weight: 10, price: 10 }] }); // 100$
  await sync(paidOrder._id);
  await sync(openOrder._id);
  await post(await deposit(user, 500, 'USD'));
  await post(await spend(user, 300, 'USD'), { target: { orderId: paidOrder._id, packageIds: paidOrder.packageIds } });

  const { results: [row], totals } = await customersList({ search: 'T' + customerSeq });
  expect(row).toMatchObject({ owed: 10000, walletUsd: 20000, walletLyd: 0, customer: { customerId: `T${customerSeq}` } });
  expect(totals.owed).toBe(10000);
  expect((await customersList({ view: 'owing' })).results.map((r) => String(r.partnerId))).toContain(String(user));

  const invoices = await customerInvoices({ userId: user });
  const byId = new Map(invoices.results.map((r) => [String(r._id), r]));
  expect(byId.get(String(paidOrder._id))).toMatchObject({ status: 'paid', billed: 30000, paid: 30000, open: 0, recognized: 30000, shipping: 30000 });
  expect(byId.get(String(openOrder._id))).toMatchObject({ status: 'unpaid', billed: 10000, paid: 0, open: 10000, deferred: 10000 });
  expect((await customerInvoices({ userId: user, status: 'unpaid' })).results).toHaveLength(1);
});

test('a statement edited or deleted after posting is reversed (and re-posted when edited)', async () => {
  const user = await newCustomer();
  const dep = await deposit(user, 100, 'USD');
  await post(dep);
  await UserStatement.updateOne({ _id: dep._id }, { $set: { amount: 120 }, $push: { editHistory: { editedAt: new Date() } } });
  await tx((session) => operations.repostStatement(dep._id, { session }));
  expect(await balanceOf('110121')).toBe(12000);
  await UserStatement.deleteOne({ _id: dep._id });
  await tx((session) => operations.reverseStatement(dep._id, { session }));
  expect(await balanceOf('110121')).toBe(0);
});

test('deleting an order takes its claims back; an order with payments cannot be deleted', async () => {
  const { deleteOrder } = require('../services/orderDeletion');
  const user = await newCustomer();
  const order = await newOrder({ user, packages: [{ weight: 10, price: 5 }] });
  await sync(order._id);
  const openOf = async (orderId) => (await JournalEntry.aggregate([
    { $unwind: '$lines' }, { $match: { 'lines.orderId': orderId } },
    { $group: { _id: '$lines.accountId', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } }, { $match: { net: { $ne: 0 } } },
  ])).length;
  expect(await openOf(order._id)).toBe(2);

  await deleteOrder(order._id, req.user);
  // Soft-deleted: gone from the system, still in accounting with its claims reversed and hidden
  expect(await Order.findById(order._id)).toBeNull();
  expect(await Order.countDocuments({ _id: order._id })).toBe(0);
  const kept = await Order.findById(order._id).setOptions({ withDeleted: true }).lean();
  expect(kept).toMatchObject({ isDeleted: true, isCanceled: true });
  expect(await openOf(order._id)).toBe(0);
  const claims = await JournalEntry.find({ 'source.model': 'Order', 'source.id': order._id }).lean();
  expect(claims.length).toBeGreaterThan(0);
  expect(claims.every((e) => e.hiddenWithCancel)).toBe(true);
  const { customerInvoices } = require('../services/reports/customers');
  expect((await customerInvoices({ userId: user })).results.map((r) => String(r._id))).not.toContain(String(order._id));
  expect((await customerInvoices({ userId: user, status: 'deleted' })).results[0]).toMatchObject({ status: 'deleted', billed: 0 });

  // Never reached the books: removed for good
  const blank = await newOrder({ user, packages: [{ weight: 1, price: 0 }] });
  await deleteOrder(blank._id, req.user);
  expect(await Order.findById(blank._id).setOptions({ withDeleted: true })).toBeNull();

  const paid = await newOrder({ user, packages: [{ weight: 10, price: 5 }] });
  await sync(paid._id);
  await mongoose.connection.collection('orderpaymenthistories').insertOne({ order: paid._id, customer: user, receivedAmount: 50, currency: 'USD' });
  await expect(deleteOrder(paid._id, req.user)).rejects.toThrow('دفعة');
  expect(await Order.findById(paid._id)).not.toBeNull();
});

test('A000 to the real customer: entries re-posted on their dates, wallet lines moved by choice', async () => {
  const { movableStatements, moveStatements } = require('../services/customerChange');
  const Wallet = require('../../models/wallet');
  const a000 = (await mongoose.connection.collection('users').insertOne({ firstName: 'A000', customerId: 'A000' })).insertedId;
  const real = await newCustomer();
  const order = await newOrder({ user: a000, packages: [{ weight: 10, price: 10 }] });
  const [pkg] = order.packageIds;
  await sync(order._id);
  // A000 deposited 100$ for the shipment and paid it from the wallet
  const dep = await deposit(a000, 100, 'USD', { description: `إيداع للطلب ${(await Order.findById(order._id)).orderId}` });
  await post(dep);
  const pay = await spend(a000, 100, 'USD');
  await mongoose.connection.collection('orderpaymenthistories').insertOne({ order: order._id, customer: a000, receivedAmount: 100, currency: 'USD', statementId: pay._id });
  await post(pay, { target: { orderId: order._id, packageIds: [pkg] } });
  await Wallet.create([{ user: a000, currency: 'USD', balance: 0 }]);
  expect(await open(arKey(order._id, pkg))).toBe(0);

  await Order.updateOne({ _id: order._id }, { $set: { user: real } });
  await sync(order._id);
  // The claim and the payment now sit on the real customer, each on its original date
  expect(await balanceOf('121000', { partnerId: real })).toBe(0);
  expect(await balanceOf('121000', { partnerId: a000 })).toBe(0);
  const moved = await JournalEntry.findOne({ eventKey: /^REPARTNER:/, eventType: 'WALLET_PAYMENT' }).lean();
  expect(moved.day).toBe('2026-01-05');
  expect(await JournalEntry.countDocuments({ eventKey: /^REPARTNER:/, eventType: 'CLAIM' })).toBe(1);
  expect(await JournalEntry.countDocuments({ eventType: 'RECLASS_PARTNER' })).toBe(0);
  // Running it again moves nothing
  await sync(order._id);
  expect(await JournalEntry.countDocuments({ eventKey: /^REPARTNER:/ })).toBe(2);

  // A000's wallet lines for this order: the payment (linked) and the deposit (mentions the order)
  const { results } = await movableStatements(order._id);
  expect(results.map((r) => String(r._id)).sort()).toEqual([String(dep._id), String(pay._id)].sort());
  await moveStatements(order._id, [dep._id, pay._id], req);
  expect(await UserStatement.countDocuments({ user: a000 })).toBe(0);
  expect(await UserStatement.countDocuments({ user: real })).toBe(2);
  expect((await Wallet.findOne({ user: real, currency: 'USD' })).balance).toBe(0);
  expect(await balanceOf('220100', { partnerId: a000 })).toBe(0);
  expect(await balanceOf('220100', { partnerId: real })).toBe(0);
  expect(await balanceOf('121000')).toBe(0);
  expect(await JournalEntry.countDocuments({ 'source.model': 'UserStatement', status: 'posted', reversalOf: null, hiddenWithCancel: { $ne: true }, 'lines.partnerId': a000 })).toBe(0);
  expect((await movableStatements(order._id)).results).toHaveLength(0);
});
