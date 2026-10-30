// End to end through the system's own screens (owner's request, 2026-10-03): every step calls the
// same controller the admin page calls, the live posting worker runs, and the ledger is checked
// against the system after each step (books balanced, wallets equal, each order's claims equal what
// the system says is left, nothing failed, nothing on the suspense account).
// No files are uploaded and no messages are sent from the tests
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { processQueue } = require('../services/events');
const { CHECKS } = require('../services/reports/exceptions');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const UserStatement = require('../../models/userStatement');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const wallet = require('../../controllers/wallet');
const orders = require('../../controllers/orders');
const balance = require('../../controllers/balance');
const staff = require('../services/staffOperations');

jest.setTimeout(120000);

const OWNER_ID = '69deb74c4b5e921e7416ea11';
let owner;
let clerk;
let customer;

// Calls a controller like Express does; resolves with the JSON it sends, rejects with next(error)
const call = (handler, { params = {}, body = {}, query = {}, user = owner } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    send(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
  };
  Promise.resolve(handler({ params, body, query, user, files: undefined, ip: '127.0.0.1' }, res, (error) => (error ? reject(error) : resolve({ status: 200 })))).catch(reject);
});

// Net debit (cents) of an account, on the lines matching a filter (arKey, orderId, partnerId...)
const usd = async (code, filter = {}) => {
  const id = (await account(code))._id;
  const match = { 'lines.accountId': id, ...Object.fromEntries(Object.entries(filter).map(([k, v]) => [`lines.${k}`, v])) };
  const [row] = await JournalEntry.aggregate([{ $match: match }, { $unwind: '$lines' }, { $match: match }, { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } }]);
  return row?.net || 0;
};
const foreign = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).foreign;

// The ledger and the system agree: every check that must always hold finds nothing
async function expectConsistent(step) {
  await processQueue();
  const failed = [];
  for (const key of ['balanced', 'wallets', 'failedEvents', 'walletDeductions', 'claimsVsSystem', 'unrecognized', 'overpaid']) {
    const result = await CHECKS[key]();
    if (result.count) failed.push(`${key}: ${JSON.stringify(result.items.slice(0, 3))}`);
  }
  // Nothing from live operations lands on the suspense account
  const suspense = await JournalEntry.countDocuments({ isHistorical: { $ne: true }, 'lines.accountCode': '399000' });
  if (suspense) failed.push(`suspense: ${suspense} live entries`);
  if (failed.length) throw new Error(`${step}:\n${failed.join('\n')}`);
}

beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 10 }]);
  // The system's own settings rate (transport fees are priced with it)
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  const users = mongoose.connection.collection('users');
  await users.insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  const clerkId = (await users.insertOne({ username: 'clerk', firstName: 'Clerk', lastName: 'Y', phone: 910000002, customerId: 'STF1', office: 'benghazi', roles: { isEmployee: true } })).insertedId;
  const customerId = (await users.insertOne({ username: 'c1', firstName: 'Customer', lastName: 'Z', phone: 910000003, customerId: 'C100', roles: { isClient: true } })).insertedId;
  owner = await mongoose.connection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  clerk = await users.findOne({ _id: clerkId });
  customer = await users.findOne({ _id: customerId });
});
afterAll(stopDb);

test('statement edits and deletions roll back the wallet, history and archive when the outbox fails', async () => {
  const { AccountingEvent } = require('../models');
  const DeletedStatement = require('../../models/deletedStatement');
  await deposit(37, 'USD');
  await expectConsistent('deposit before failing statement changes');
  const original = await UserStatement.findOne({ user: customer._id, amount: 37 }).sort({ _id: -1 }).lean();
  const params = { id: String(customer._id), statementId: String(original._id) };
  const beforeWallet = await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean();
  const beforeLines = await UserStatement.find({ user: customer._id, currency: 'USD' }).sort({ _id: 1 }).lean();
  const beforeEvents = await AccountingEvent.countDocuments();
  const spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('test outbox unavailable'));
  try {
    await expect(call(wallet.updateStatement, { params, body: { amount: 39 } })).rejects.toMatchObject({ statusCode: 500 });
    await expect(call(wallet.deleteStatement, { params })).rejects.toMatchObject({ statusCode: 500 });
  } finally { spy.mockRestore(); }
  expect((await Wallet.findById(beforeWallet._id).lean()).balance).toBe(beforeWallet.balance);
  expect(await UserStatement.find({ user: customer._id, currency: 'USD' }).sort({ _id: 1 }).lean()).toEqual(beforeLines);
  expect(await DeletedStatement.countDocuments({ originalId: original._id })).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(beforeEvents);
  await expectConsistent('failed statement changes rolled back');
  await call(wallet.deleteStatement, { params });
  await expectConsistent('statement deletion retry');
});

test('two simultaneous deletes of one deposit debit once and archive once', async () => {
  const DeletedStatement = require('../../models/deletedStatement');
  await deposit(43, 'USD');
  await expectConsistent('deposit before concurrent deletion');
  const line = await UserStatement.findOne({ user: customer._id, amount: 43 }).sort({ _id: -1 }).lean();
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const args = { params: { id: String(customer._id), statementId: String(line._id) } };
  const results = await Promise.allSettled([call(wallet.deleteStatement, args), call(wallet.deleteStatement, args)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 404 });
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before - 43);
  expect(await DeletedStatement.countDocuments({ originalId: line._id })).toBe(1);
  await expectConsistent('one committed deletion');
});

test('simultaneous deposit edits use the current amount and leave the running totals and ledger equal', async () => {
  await deposit(41, 'USD');
  await expectConsistent('deposit before concurrent edit');
  const line = await UserStatement.findOne({ user: customer._id, amount: 41 }).sort({ _id: -1 }).lean();
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const params = { id: String(customer._id), statementId: String(line._id) };
  await Promise.all([call(wallet.updateStatement, { params, body: { amount: 45 } }), call(wallet.updateStatement, { params, body: { amount: 47 } })]);
  const saved = await UserStatement.findById(line._id).lean();
  const current = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  expect(current).toBe(before - 41 + saved.amount);
  expect(saved.editHistory).toHaveLength(2);
  expect((await UserStatement.findOne({ user: customer._id, currency: 'USD' }).sort({ _id: -1 }).lean()).total).toBe(current);
  await expectConsistent('concurrent edit ledger');
  await call(wallet.deleteStatement, { params });
  await expectConsistent('concurrent edit cleanup');
});

const newPurchaseOrder = async (items, user = owner) => (await call(orders.createOrder, {
  user,
  body: { customerId: 'C100', fullName: 'Customer Z', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify(items), paymentList: '[]' },
})).body;

const newShipmentOrder = async (packages, user = owner) => (await call(orders.createOrder, {
  user,
  body: {
    customerId: 'C100', fullName: 'Customer Z', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
    paymentList: JSON.stringify(packages.map((p, i) => ({ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: p.weight, measureUnit: 'KG', exiosPrice: p.price, trackingNumber: p.tracking || `TRK${Date.now()}${i}`, shipmentMethod: 'air' } }))),
  },
})).body;

const deposit = (amount, currency, extra = {}, user = owner) => call(wallet.addBalanceToWallet, {
  user, params: { id: String(customer._id) },
  body: { amount, currency, description: `إيداع ${amount} ${currency}`, note: 'test', actionType: 'cash', office: 'tripoli', createdAt: new Date().toISOString(), ...extra },
});

const payFromWallet = (order, amount, currency, rate, user = owner) => call(wallet.useBalanceOfWallet, {
  user, params: { id: String(customer._id) },
  body: { amount, currency, rate, orderId: order.orderId, category: 'invoice', description: `خصم ${amount} ${currency}`, note: `Order Id (${order.orderId}) => test`, createdAt: new Date().toISOString() },
});

const paymentsOf = async (orderId) => (await call(orders.getPaymentsOfOrder, { params: { id: String(orderId) } })).body.results;


test('1. deposits: owner cash to the office written on it, a clerk\'s to their own office; edit and delete follow', async () => {
  await deposit(500, 'USD');
  await deposit(3000, 'LYD', { rate: 10 });
  await expectConsistent('deposits');
  expect(await usd('110121')).toBe(50000);
  expect(await foreign('110122')).toBe(3000000);
  // A clerk of Benghazi typing "tripoli": the money is in Benghazi's box
  await deposit(100, 'USD', {}, clerk);
  await expectConsistent('clerk deposit');
  expect(await usd('110123')).toBe(10000);
  // The owner edits a deposit's office: the money moves box
  const line = await UserStatement.findOne({ user: customer._id, amount: 500 }).lean();
  await call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(line._id) }, body: { office: 'benghazi' } });
  await expectConsistent('edit office');
  expect(await usd('110121')).toBe(0);
  expect(await usd('110123')).toBe(60000);
  // Edit the amount, then back
  await call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(line._id) }, body: { amount: 450 } });
  await expectConsistent('edit amount');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(550);
  await call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(line._id) }, body: { amount: 500 } });
  await expectConsistent('edit amount back');
});

test('2. purchase order: claim at creation, paid from both wallets, cost, edit, cash, cancel a payment', async () => {
  const order = await newPurchaseOrder([{ description: 'سلة', unitPrice: 180, quantity: 1 }, { description: 'عمولة', unitPrice: 20, quantity: 1 }]);
  await expectConsistent('purchase created');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(20000);
  await payFromWallet(order, 150, 'USD', 0);
  await payFromWallet(order, 500, 'LYD', 10);
  await expectConsistent('paid from wallets');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(-(await usd('410300'))).toBe(20000);
  // Purchase cost paid from the Tripoli USD box
  const box = await account('110121');
  await staff.addOrderCost(order._id, { vendorName: '1688', amount: 180, payFromAccountId: box._id, day: new Date().toISOString().slice(0, 10) }, { user: owner });
  await expectConsistent('cost added');
  expect(await usd('510400')).toBe(18000);
  // The invoice raised to 210 (request + accept): 10$ owed, revenue in proportion (instalments)
  await call(orders.updateOrderItems, { params: { id: String(order._id) }, body: { items: [{ description: 'سلة', unitPrice: 180, quantity: 1 }, { description: 'عمولة', unitPrice: 30, quantity: 1 }] } });
  const fresh = await Order.findById(order._id).lean();
  await call(orders.confirmItemsChanges, { params: { id: String(order._id) }, body: { status: 'accepted', requestedEditDetails: fresh.requestedEditDetails } });
  await expectConsistent('invoice raised');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(1000);
  // 10$ cash on the order settles it
  await call(orders.addPaymentToOrder, { params: { id: String(order._id) }, body: { receivedAmount: 10, currency: 'USD', paymentType: 'cash', category: 'invoice', customerId: String(customer._id), list: '[]', createdAt: new Date().toISOString() } });
  await expectConsistent('cash payment');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(-(await usd('410300'))).toBe(21000);
  // The dinar payment cancelled from the order page: back to the wallet exactly
  const lyd = (await paymentsOf(order._id)).find((p) => p.currency === 'LYD');
  await call(wallet.cancelPayment, { params: { id: String(customer._id) }, body: { payment: lyd } });
  await expectConsistent('payment cancelled');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(5000);
});

test('3. cancelling an order with payments gives everything back to the wallet; the cost waits for the accountant', async () => {
  const order = await newPurchaseOrder([{ description: 'x', unitPrice: 100, quantity: 1 }]);
  await payFromWallet(order, 60, 'USD', 0);
  await payFromWallet(order, 400, 'LYD', 10);
  await expectConsistent('paid');
  const box = await account('110121');
  await staff.addOrderCost(order._id, { vendorName: 'Alibaba', amount: 90, payFromAccountId: box._id, day: new Date().toISOString().slice(0, 10) }, { user: owner });
  const before = { usd: (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance, lyd: (await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean()).balance };
  await call(orders.cancelOrder, { params: { id: String(order._id) }, body: { cancelationReason: 'test' } });
  await expectConsistent('cancelled with refund');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before.usd + 60);
  expect((await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean()).balance).toBe(before.lyd + 400);
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(await usd('130200', { orderId: order._id })).toBe(9000);
  const stuck = await CHECKS.canceledOrderCosts();
  expect(stuck.count).toBe(1);
});

test('4. shipping: priced packages, delivered and paid in dollars and dinars together, then the delivery cancelled', async () => {
  const order = await newShipmentOrder([{ weight: 3.05, price: 9.5 }, { weight: 1.2, price: 6 }]);
  await expectConsistent('shipment priced');
  const full = await Order.findById(order._id).lean();
  const selected = full.paymentList.map((p) => ({ id: String(p._id), orderId: full.orderId, trackingNumber: p.deliveredPackages.trackingNumber }));
  // 28.97 + 7.20 = 36.17: 10$ and the rest in dinars
  await call(orders.markPackagesAsDelivered, { params: { id: String(customer._id) }, body: { selectedPackages: selected, payment: { amountUSD: 10, amountLYD: 261.7 } } });
  await expectConsistent('delivered');
  const keys = full.paymentList.map((p) => `SHP:${order._id}:${p._id}`);
  for (const key of keys) expect(await usd('121000', { arKey: key })).toBe(0);
  expect(-(await usd('410100'))).toBe(3617);
  // A delivery payment cannot be deleted alone
  const shipping = (await paymentsOf(order._id)).filter((p) => p.category === 'receivedGoods');
  expect(shipping.every((p) => p.deliveryInvoice)).toBe(true);
  await expect(call(wallet.cancelPayment, { params: { id: String(customer._id) }, body: { payment: shipping[0] } })).rejects.toMatchObject({ statusCode: 400 });
  // Cancelling the delivery invoice gives it all back once, packages not received again
  const Invoice = require('../../models/invoice');
  const invoice = await Invoice.findOne({ 'list.orderId': full.orderId }).lean();
  await call(orders.cancelInvoice, { params: { id: String(invoice._id) }, body: {} });
  await expectConsistent('delivery cancelled');
  for (const key of keys) expect(await usd('121000', { arKey: key })).toBeGreaterThan(0);
  expect(await usd('410100')).toBe(0);
});

test('a package cannot be delivered and charged twice by simultaneous requests', async () => {
  const balanceBefore = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean())?.balance || 0;
  await deposit(100, 'USD');
  const order = await newShipmentOrder([{ weight: 1, price: 10, tracking: 'RACE-DELIVERY' }]);
  const saved = await Order.findById(order._id).lean();
  const input = {
    params: { id: String(customer._id) },
    body: { selectedPackages: [{ id: String(saved.paymentList[0]._id), orderId: saved.orderId }], payment: { amountUSD: 10, amountLYD: 0 } },
  };

  const outcomes = await Promise.allSettled([
    call(orders.markPackagesAsDelivered, input),
    call(orders.markPackagesAsDelivered, input),
  ]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  await expectConsistent('concurrent delivery');

  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(balanceBefore + 90);
  expect(await UserStatement.countDocuments({ user: customer._id, calculationType: '-', description: /RACE-DELIVERY/ })).toBe(1);
  expect(await OrderPaymentHistory.countDocuments({ order: order._id, category: 'receivedGoods' })).toBe(1);
  expect(await require('../../models/invoice').countDocuments({ customer: customer._id, 'list.packageId': String(saved.paymentList[0]._id) })).toBe(1);
});

test('a delivery invoice cannot be cancelled and refunded twice concurrently', async () => {
  const balanceBefore = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean())?.balance || 0;
  await deposit(20, 'USD');
  const order = await newShipmentOrder([{ weight: 1, price: 10, tracking: 'RACE-CANCEL' }]);
  const saved = await Order.findById(order._id).lean();
  await call(orders.markPackagesAsDelivered, {
    params: { id: String(customer._id) },
    body: { selectedPackages: [{ id: String(saved.paymentList[0]._id), orderId: saved.orderId }], payment: { amountUSD: 10 } },
  });
  const Invoice = require('../../models/invoice');
  const invoice = await Invoice.findOne({ 'list.orderId': saved.orderId }).sort({ createdAt: -1 }).lean();
  const cancel = () => call(orders.cancelInvoice, { params: { id: String(invoice._id) }, body: {} });
  const outcomes = await Promise.allSettled([cancel(), cancel()]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  await expectConsistent('concurrent invoice cancellation');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(balanceBefore + 20);
  expect(await OrderPaymentHistory.countDocuments({ order: order._id, category: 'receivedGoods' })).toBe(0);
  expect((await Order.findById(order._id).lean()).paymentList[0].status.received).toBe(false);
});

test('wallet API rejects zero and negative deposits or deductions without changing the balance', async () => {
  await expect(deposit(-25, 'USD')).rejects.toMatchObject({ statusCode: 400 });
  await expect(deposit(0, 'USD')).rejects.toMatchObject({ statusCode: 400 });
  await deposit(50, 'USD');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  await expect(call(wallet.useBalanceOfWallet, {
    params: { id: String(customer._id) },
    body: { amount: -10, currency: 'USD', createdAt: new Date().toISOString(), description: 'invalid negative deduction' },
  })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before);
  expect(await UserStatement.countDocuments({ user: customer._id, description: 'invalid negative deduction' })).toBe(0);
  await Wallet.updateOne({ user: customer._id, currency: 'USD' }, { $set: { balance: -0.01 } });
  expect((await CHECKS.wallets()).count).toBeGreaterThan(0);
  await Wallet.updateOne({ user: customer._id, currency: 'USD' }, { $set: { balance: before } });
  await expectConsistent('invalid wallet amount');
});

test('concurrent first deposits create one wallet and consistent running statement totals', async () => {
  const inserted = await mongoose.connection.collection('users').insertOne({ firstName: 'First wallet', customerId: 'FIRST-WALLET', roles: { isClient: true } });
  const add = (amount) => call(wallet.addBalanceToWallet, {
    params: { id: String(inserted.insertedId) },
    body: { amount, currency: 'USD', actionType: 'cash', office: 'tripoli', description: 'First deposit', createdAt: new Date().toISOString() },
  });
  await Promise.all([add(10), add(20)]);
  expect(await Wallet.countDocuments({ user: inserted.insertedId, currency: 'USD' })).toBe(1);
  expect((await Wallet.findOne({ user: inserted.insertedId, currency: 'USD' })).balance).toBe(30);
  const statements = await UserStatement.find({ user: inserted.insertedId }).sort({ _id: 1 }).lean();
  expect(statements).toHaveLength(2);
  expect(statements[0].total).toBe(statements[0].amount);
  expect(statements[1].total).toBe(30);
  await expectConsistent('concurrent first deposits');
});

test('deposit and order payment roll back all financial records when recording their outbox fails', async () => {
  const { AccountingEvent } = require('../models');
  const order = await newPurchaseOrder([{ description: 'outbox failure', unitPrice: 10, quantity: 1 }]);
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance;
  const statementsBefore = await UserStatement.countDocuments({ user: customer._id });
  for (const action of [() => deposit(10, 'USD'), () => payFromWallet(order, 10, 'USD', 0)]) {
    const recording = jest.spyOn(AccountingEvent, 'create').mockRejectedValueOnce(new Error('simulated outbox recording failure'));
    try {
      await expect(action()).rejects.toThrow('simulated outbox recording failure');
    } finally { recording.mockRestore(); }
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(before);
    expect(await UserStatement.countDocuments({ user: customer._id })).toBe(statementsBefore);
    expect(await OrderPaymentHistory.countDocuments({ order: order._id })).toBe(0);
  }
  await expectConsistent('outbox failure rollback');
});

test('payment cancellation rolls back on outbox failure, ignores client amounts and refunds once under concurrency', async () => {
  const { AccountingEvent } = require('../models');
  const order = await newPurchaseOrder([{ description: 'safe cancellation', unitPrice: 20, quantity: 1 }]);
  await deposit(10, 'USD');
  await payFromWallet(order, 10, 'USD', 0);
  await expectConsistent('before safe cancellation');
  const payment = await OrderPaymentHistory.findOne({ order: order._id }).lean();
  const beforeUSD = (await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance;
  const beforeLYD = (await Wallet.findOne({ user: customer._id, currency: 'LYD' })).balance;
  const cancel = () => call(wallet.cancelPayment, { params: { id: String(customer._id) }, body: { payment: { _id: payment._id, receivedAmount: 999999, currency: 'LYD', paymentType: 'cash' } } });
  const recording = jest.spyOn(AccountingEvent, 'create').mockRejectedValueOnce(new Error('simulated cancellation event failure'));
  try { await expect(cancel()).rejects.toThrow('simulated cancellation event failure'); }
  finally { recording.mockRestore(); }
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(beforeUSD);
  expect(await OrderPaymentHistory.exists({ _id: payment._id })).not.toBeNull();
  const outcomes = await Promise.allSettled([cancel(), cancel()]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(beforeUSD + 10);
  expect((await Wallet.findOne({ user: customer._id, currency: 'LYD' })).balance).toBe(beforeLYD);
  expect(await OrderPaymentHistory.exists({ _id: payment._id })).toBeNull();
  await expectConsistent('safe cancellation');
});

test('free delivery also rolls back its package and invoice if its order event cannot be recorded', async () => {
  const { AccountingEvent } = require('../models');
  const order = await newShipmentOrder([{ weight: 1, price: 0 }]);
  const saved = await Order.findById(order._id).lean();
  const pkg = saved.paymentList[0];
  const recording = jest.spyOn(AccountingEvent, 'create').mockRejectedValueOnce(new Error('simulated free delivery event failure'));
  try {
    await expect(call(orders.markPackagesAsDelivered, {
      params: { id: String(customer._id) },
      body: { selectedPackages: [{ id: String(pkg._id), orderId: saved.orderId }], payment: { amountUSD: 0 } },
    })).rejects.toThrow('simulated free delivery event failure');
  } finally { recording.mockRestore(); }
  expect((await Order.findById(order._id).lean()).paymentList[0].status.received).toBe(false);
  expect(await require('../../models/invoice').countDocuments({ 'list.packageId': String(pkg._id) })).toBe(0);
  await expectConsistent('free delivery rollback');
});

test('5. debts: a general debt from a cash box, paid from the wallet in dinars; closed by hand; deleted', async () => {
  const box = await account('110121');
  const created = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 20, currency: 'USD', customerId: 'C100', notes: 'دين تجربة', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String(box._id) } })).body;
  await deposit(300, 'LYD');
  const Wallet = require('../../models/wallet');
  const walletBefore = await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean();
  await expect(call(balance.createPaymentHistory, { params: { id: String(created._id) }, body: { amount: -1, currency: 'LYD', rate: 10, createdAt: new Date().toISOString() } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(call(balance.createPaymentHistory, { params: { id: String(created._id) }, body: { amount: 201, currency: 'LYD', rate: 10, createdAt: new Date().toISOString() } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Wallet.findOne({ user: customer._id, currency: 'LYD' })).balance).toBe(walletBefore.balance);
  await expectConsistent('debt created');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(2000);
  await call(balance.createPaymentHistory, { params: { id: String(created._id) }, body: { amount: 100, currency: 'LYD', rate: 10, createdAt: new Date().toISOString() } });
  await expectConsistent('debt half paid in dinars');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(1000);
  const closed = await call(balance.closeDebtManually, { params: { id: String(created._id) }, body: { note: 'الباقي يُشطب' } });
  await expectConsistent('debt closed by hand');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(0);
  expect(await usd('520100')).toBe(1000);

  const lostId = closed.body.manualClosure.lostBalance;
  await deposit(5, 'USD');
  await call(balance.createPaymentHistory, { params: { id: String(lostId) }, body: { amount: 5, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } });
  await expectConsistent('recovery of a written-off general debt');
  expect(await usd('520100')).toBe(500);
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(0);

  const order = await newPurchaseOrder([{ description: 'linked invoice', unitPrice: 10, quantity: 1 }]);
  const orderDebt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 10, currency: 'USD', orderId: order.orderId, notes: 'Order reminder', createdOffice: 'tripoli', debtType: 'invoice' } })).body;
  await expect(call(balance.closeDebtManually, { params: { id: String(orderDebt._id) }, body: { note: 'Use invoice write-off' } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await require('../../models/balance').findById(orderDebt._id).lean()).status).toBe('open');
});

test('6. a trip: packages added, shipping and customs costs, delivered one by one, cost shared by weight, trip finished', async () => {
  const inventory = require('../../controllers/inventory');
  const order = await newShipmentOrder([{ weight: 10, price: 8 }, { weight: 30, price: 8 }]);
  const full = await Order.findById(order._id).lean();
  const trip = (await call(inventory.createInventory, { body: { voyage: 'AIR-E2E', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN' } })).body;
  await call(inventory.addOrdersToTheInventory, { query: { id: String(trip._id) }, body: full.paymentList.map((p) => ({ paymentList: { _id: String(p._id) } })) });
  await expectConsistent('trip loaded');
  const usdBox = await account('110121');
  const lydBox = await account('110122');
  await staff.addTripCost(trip._id, { vendorName: 'Turkish Cargo', amount: 400, payFromAccountId: usdBox._id, costCategory: 'shipping', day: new Date().toISOString().slice(0, 10) }, { user: owner });
  await staff.addTripCost(trip._id, { vendorName: 'جمارك', amount: 1000, payFromAccountId: lydBox._id, costCategory: 'customs', day: new Date().toISOString().slice(0, 10) }, { user: owner });
  await expectConsistent('trip costs');
  const tripCost = await usd('130100', { tripId: trip._id });
  expect(tripCost).toBeGreaterThan(40000);
  const deliver = async (pkg, amountUSD) => call(orders.markPackagesAsDelivered, { params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(pkg._id), orderId: full.orderId }], payment: { amountUSD } } });
  await deposit(400, 'USD');
  await deliver(full.paymentList[0], 80);
  await expectConsistent('first package delivered');
  // A quarter of the weight: a quarter of the trip's cost
  expect(await usd('510100')).toBe(Math.round(tripCost / 4));
  await deliver(full.paymentList[1], 240);
  await expectConsistent('second package delivered');
  expect(await usd('510100')).toBe(tripCost);
  expect(await usd('130100', { tripId: trip._id })).toBe(0);
  await call(inventory.updateInventory, { query: { id: String(trip._id) }, body: { status: 'finished' } });
  await expectConsistent('trip finished');
});

test('7. a cash withdrawal from the wallet comes out of the box of whoever paid it out', async () => {
  const before = await usd('110123');
  await call(wallet.useBalanceOfWallet, { user: clerk, params: { id: String(customer._id) }, body: { amount: 50, currency: 'USD', actionType: 'withdrawal', office: 'benghazi', description: 'سحب 50', note: 'سحب', createdAt: new Date().toISOString() } });
  await expectConsistent('withdrawal');
  expect(await usd('110123')).toBe(before - 5000);
});

test('8. an office expense by a clerk is paid from their office box; they can take it back the same day', async () => {
  const { ExpenseType } = require('../models/documents');
  const type = await ExpenseType.findOne({ isActive: true }).lean();
  const before = await usd('110123');
  const bill = await staff.createOfficeExpense({ expenseTypeId: String(type._id), amount: 15, currency: 'USD', note: 'ضيافة', day: new Date().toISOString().slice(0, 10) }, [], { user: clerk });
  await expectConsistent('office expense');
  expect(await usd('110123')).toBe(before - 1500);
  await staff.deleteOfficeExpense(String(bill._id), { user: clerk });
  await expectConsistent('office expense taken back');
  expect(await usd('110123')).toBe(before);
});

test('9. a supplier refund on a purchase order: money into the bank, part to the wallet, profit follows; then cancelled', async () => {
  const { runInTransaction } = require('../services/transaction');
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  const { cancelDocument } = require('../services/cancel');
  const order = await newPurchaseOrder([{ description: 'x', unitPrice: 200, quantity: 1 }]);
  await payFromWallet(order, 200, 'USD', 0);
  const box = await account('110121');
  await staff.addOrderCost(order._id, { vendorName: 'Alibaba', amount: 180, payFromAccountId: box._id, day: new Date().toISOString().slice(0, 10) }, { user: owner });
  await expectConsistent('order paid and costed');
  const bank = await account('110202');
  const refund = await runInTransaction((session) => createCustomerRefund({ orderId: String(order._id), accountId: String(bank._id), amount: 30, walletUsd: 29, day: new Date().toISOString().slice(0, 10) }, { session, req: { user: owner } }));
  await expectConsistent('refund');
  const sales = -(await usd('410300', { orderId: order._id }));
  const cost = await usd('510400', { orderId: order._id });
  expect(sales).toBe(17100);
  expect(cost).toBe(15000);
  await runInTransaction((session) => cancelDocument('AccountingCustomerRefund', refund._id, { session, req: { user: owner }, reason: 'test', confirmNegative: true }));
  await expectConsistent('refund cancelled');
  expect(-(await usd('410300', { orderId: order._id }))).toBe(20000);
});

test('10. deleting an order created by mistake: its claim is reversed and it is hidden', async () => {
  const order = await newPurchaseOrder([{ description: 'خطأ', unitPrice: 75, quantity: 1 }]);
  await expectConsistent('created');
  await call(orders.deleteOrder, { params: { id: String(order._id) } });
  await expectConsistent('deleted');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(await Order.findById(order._id).lean()).toBeNull();
});

test('11. a package with a transport fee in dinars: shipping and fee claims, fee paid on its own from the dinar wallet', async () => {
  const order = await newShipmentOrder([{ weight: 2, price: 10 }]);
  const full0 = await Order.findById(order._id).lean();
  const pkg = full0.paymentList[0];
  // The fee typed on the package from the order page (the system's update)
  await call(orders.updateOrder, { params: { id: String(order._id) }, body: { paymentList: full0.paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, domesticFee: { amount: 50, currency: 'LYD' } } })) } });
  await expectConsistent('fee set');
  const full = await Order.findById(order._id).lean();
  const feeUsd = full.paymentList[0].deliveredPackages.domesticFee.usd;
  expect(feeUsd).toBe(5);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${pkg._id}:DOM` })).toBe(500);
  await deposit(20, 'USD');
  await call(orders.markPackagesAsDelivered, { params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(pkg._id), orderId: full.orderId }], payment: { amountUSD: 20 } } });
  await expectConsistent('delivered with fee');
  expect(await usd('121000', { arKey: `SHP:${order._id}:${pkg._id}` })).toBe(0);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${pkg._id}:DOM` })).toBe(0);
  expect(-(await usd('410500', { orderId: order._id }))).toBe(500);
});

test('delivery can collect a dinar transport fee in USD at the current rate without debiting the dinar wallet', async () => {
  const order = await newShipmentOrder([{ weight: 2, price: 10 }]);
  const initial = await Order.findById(order._id).lean();
  const pkg = initial.paymentList[0];
  await call(orders.updateOrder, { params: { id: String(order._id) }, body: { paymentList: initial.paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, domesticFee: { amount: 50, currency: 'LYD' } } })) } });
  const saved = await Order.findById(order._id).lean();
  const beforeLYD = (await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean())?.balance || 0;
  const shippingRevenueBefore = -(await usd('410100'));
  await deposit(25, 'USD');

  await call(orders.markPackagesAsDelivered, {
    params: { id: String(customer._id) },
    body: { selectedPackages: [{ id: String(pkg._id), orderId: saved.orderId }], payment: { amountUSD: 25 }, feeMode: 'usd' },
  });
  await expectConsistent('dinar fee collected in USD');

  expect((await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean())?.balance || 0).toBe(beforeLYD);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${pkg._id}` })).toBe(0);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${pkg._id}:DOM` })).toBe(0);
  expect(-(await usd('410100')) - shippingRevenueBefore).toBe(2000);
  expect(-(await usd('410500', { orderId: order._id }))).toBe(500);
  const Invoice = require('../../models/invoice');
  const invoice = await Invoice.findOne({ 'list.packageId': String(pkg._id) }).sort({ createdAt: -1 }).lean();
  expect(invoice.total).toBe(25);
  expect(invoice.amountUSD).toBe(25);
  expect(invoice.amountLYD).toBe(0);
});

test('12. an order entered for the unknown customer A000 then given to the real customer: claims and payments follow', async () => {
  const users = mongoose.connection.collection('users');
  const unknownId = (await users.insertOne({ username: 'a000', firstName: 'Unknown', lastName: '-', phone: 910000099, customerId: 'A000', roles: { isClient: true } })).insertedId;
  const order = (await call(orders.createOrder, { body: { customerId: 'A000', fullName: 'Unknown', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'x', unitPrice: 40, quantity: 1 }]), paymentList: '[]' } })).body;
  await expectConsistent('A000 order');
  expect(await usd('121000', { arKey: `PUR:${order._id}`, partnerId: unknownId })).toBe(4000);
  await call(orders.updateOrder, { params: { id: String(order._id) }, body: { customerId: 'C100' } });
  await expectConsistent('customer changed');
  expect(await usd('121000', { arKey: `PUR:${order._id}`, partnerId: unknownId })).toBe(0);
  expect(await usd('121000', { arKey: `PUR:${order._id}`, partnerId: customer._id })).toBe(4000);
});

test('13. an inactive (unsure) order bills nothing; once activated its claim is posted', async () => {
  const order = await newPurchaseOrder([{ description: 'x', unitPrice: 30, quantity: 1 }]);
  await Order.updateOne({ _id: order._id }, { $set: { unsureOrder: true } });
  await require('../services/events').emitAccountingEvent('order', order._id, {});
  await expectConsistent('made inactive');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  await call(orders.updateOrder, { params: { id: String(order._id) }, body: { unsureOrder: false } });
  await expectConsistent('activated');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(3000);
});

test('14. statement lines: a deposit retyped as a refund and back; a payment given back cannot be edited or deleted', async () => {
  await deposit(70, 'USD');
  const line = await UserStatement.findOne({ user: customer._id, amount: 70 }).sort({ _id: -1 }).lean();
  const refundsBefore = await usd('520200');
  await call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(line._id) }, body: { actionType: 'refund' } });
  await expectConsistent('retyped as refund');
  expect(await usd('520200')).toBe(refundsBefore + 7000);
  await call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(line._id) }, body: { actionType: 'cash' } });
  await expectConsistent('retyped as cash');
  expect(await usd('520200')).toBe(refundsBefore);
  const returned = await UserStatement.findOne({ user: customer._id, actionType: 'cancellation' }).lean();
  await expect(call(wallet.updateStatement, { params: { id: String(customer._id), statementId: String(returned._id) }, body: { amount: 1 } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(call(wallet.deleteStatement, { params: { id: String(customer._id), statementId: String(returned._id) } })).rejects.toMatchObject({ statusCode: 400 });
  await call(wallet.deleteStatement, { params: { id: String(customer._id), statementId: String(line._id) } });
  await expectConsistent('deposit deleted');
});

test('a delivery invoice cancelled one package at a time: only that package comes back, then the rest', async () => {
  await deposit(60, 'USD');
  const order = await newShipmentOrder([{ weight: 2, price: 10 }, { weight: 3, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  const selected = full.paymentList.map((p) => ({ id: String(p._id), orderId: full.orderId, trackingNumber: p.deliveredPackages.trackingNumber }));
  await call(orders.markPackagesAsDelivered, { params: { id: String(customer._id) }, body: { selectedPackages: selected, payment: { amountUSD: 50 } } });
  await expectConsistent('delivered');
  const [first, second] = full.paymentList;
  const keyOf = (p) => `SHP:${order._id}:${p._id}`;
  const usdWallet = async () => (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const Invoice = require('../../models/invoice');
  const invoice = await Invoice.findOne({ 'list.orderId': full.orderId }).sort({ createdAt: -1 }).lean();
  const before = await usdWallet();

  // The first package only: its 20$ back, it is open again, the second stays paid and handed over
  const partial = (await call(orders.cancelInvoice, { params: { id: String(invoice._id) }, body: { packageIds: [String(first._id)] } })).body.results;
  expect(partial.whole).toBe(false);
  expect(partial.refundedUSD).toBe(20);
  expect(await usdWallet()).toBe(before + 20);
  await expectConsistent('one package cancelled');
  expect(await usd('121000', { arKey: keyOf(first) })).toBe(2000);
  expect(await usd('121000', { arKey: keyOf(second) })).toBe(0);
  let saved = await Invoice.findById(invoice._id).lean();
  expect(saved.isCanceled).toBe(false);
  expect(saved.list.filter((p) => p.canceledAt)).toHaveLength(1);
  const after = await Order.findById(order._id).lean();
  expect(after.paymentList.find((p) => String(p._id) === String(first._id)).status.received).toBe(false);
  expect(after.paymentList.find((p) => String(p._id) === String(second._id)).status.received).toBe(true);
  // The same package again: refused
  await expect(call(orders.cancelInvoice, { params: { id: String(invoice._id) }, body: { packageIds: [String(first._id)] } })).rejects.toMatchObject({ statusCode: 400 });

  // The rest: the invoice is now cancelled, all 50$ back
  const rest = (await call(orders.cancelInvoice, { params: { id: String(invoice._id) }, body: {} })).body.results;
  expect(rest.whole).toBe(true);
  expect(await usdWallet()).toBe(before + 50);
  saved = await Invoice.findById(invoice._id).lean();
  expect(saved.isCanceled).toBe(true);
  expect(saved.cancellation.refundedUSD).toBe(50);
  await expectConsistent('whole invoice cancelled');
  expect(await usd('121000', { arKey: keyOf(second) })).toBe(3000);
});


test('debt payment rolls back on outbox failure and retry keeps 1.13 exactly in wallet, history and ledger', async () => {
  const Balance = require('../../models/balance');
  const { AccountingEvent } = require('../models');
  const box = await account('110121');
  await deposit(2, 'USD');
  const debt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 1.13, currency: 'USD', customerId: 'C100', notes: 'atomic payment', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String(box._id) } })).body;
  await expectConsistent('before failed debt payment');
  const beforeDebt = await Balance.findById(debt._id).lean();
  const beforeWallet = await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean();
  const beforeStatements = await UserStatement.countDocuments();
  const beforeEvents = await AccountingEvent.countDocuments();
  const args = { params: { id: String(debt._id) }, body: { amount: 1.13, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } };
  const spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('debt outbox unavailable'));
  try { await expect(call(balance.createPaymentHistory, args)).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await Balance.findById(debt._id).lean()).toEqual(beforeDebt);
  expect((await Wallet.findById(beforeWallet._id).lean()).balance).toBe(beforeWallet.balance);
  expect(await UserStatement.countDocuments()).toBe(beforeStatements);
  expect(await AccountingEvent.countDocuments()).toBe(beforeEvents);
  await expectConsistent('failed debt payment rolled back');
  await call(balance.createPaymentHistory, args);
  const saved = await Balance.findById(debt._id).lean();
  expect(saved.amount).toBe(0);
  expect(saved.paymentHistory).toHaveLength(1);
  expect(saved.paymentHistory[0].amount).toBe(1.13);
  expect((await Wallet.findById(beforeWallet._id).lean()).balance).toBe(Math.round((beforeWallet.balance - 1.13) * 100) / 100);
  await expectConsistent('debt payment retried');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('concurrent full debt payments debit the wallet and record settlement only once', async () => {
  const Balance = require('../../models/balance');
  const box = await account('110121');
  await deposit(10, 'USD');
  const debt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 10, currency: 'USD', customerId: 'C100', notes: 'concurrent payment', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String(box._id) } })).body;
  await expectConsistent('before concurrent debt payments');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const args = { params: { id: String(debt._id) }, body: { amount: 10, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } };
  const results = await Promise.allSettled([call(balance.createPaymentHistory, args), call(balance.createPaymentHistory, args)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 400 });
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(Math.round((before - 10) * 100) / 100);
  expect((await Balance.findById(debt._id).lean()).paymentHistory).toHaveLength(1);
  await expectConsistent('one committed debt payment');
});

test('a linked debt payment rolls back its order payment history when the outbox fails', async () => {
  const Balance = require('../../models/balance');
  const { AccountingEvent } = require('../models');
  const order = await newPurchaseOrder([{ description: 'atomic linked debt', unitPrice: 10, quantity: 1 }]);
  const debt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 10, currency: 'USD', orderId: order.orderId, notes: 'atomic linked debt', createdOffice: 'tripoli', debtType: 'invoice' } })).body;
  await deposit(10, 'USD');
  await expectConsistent('before linked debt payment');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const args = { params: { id: String(debt._id) }, body: { amount: 10, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } };
  const spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('linked debt outbox unavailable'));
  try { await expect(call(balance.createPaymentHistory, args)).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await OrderPaymentHistory.countDocuments({ order: order._id })).toBe(0);
  expect((await Balance.findById(debt._id).lean()).paymentHistory).toHaveLength(0);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(before);
  await expectConsistent('linked debt payment rolled back');
  await call(balance.createPaymentHistory, args);
  expect(await OrderPaymentHistory.countDocuments({ order: order._id })).toBe(1);
  await expectConsistent('linked debt payment retry');
});


test('concurrent reductions of different deposits cannot spend the same available wallet balance', async () => {
  const id = (await mongoose.connection.collection('users').insertOne({ username: 'reduction-race', firstName: 'Reduction', lastName: 'Race', phone: 910000088, customerId: 'C888', roles: { isClient: true } })).insertedId;
  const params = { id: String(id) };
  for (let i = 0; i < 2; i++) {
    await call(wallet.addBalanceToWallet, { params, body: { amount: 50, currency: 'USD', description: 'race deposit', actionType: 'cash', office: 'tripoli', createdAt: new Date().toISOString() } });
  }
  const order = (await call(orders.createOrder, { body: { customerId: 'C888', fullName: 'Reduction Race', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'spent deposit funds', unitPrice: 50, quantity: 1 }]), paymentList: '[]' } })).body;
  await call(wallet.useBalanceOfWallet, { params, body: { amount: 50, currency: 'USD', rate: 1, orderId: order.orderId, category: 'invoice', description: 'spent deposit funds', createdAt: new Date().toISOString() } });
  await expectConsistent('before concurrent reductions');
  const lines = await UserStatement.find({ user: id, calculationType: '+' }).lean();
  const results = await Promise.allSettled(lines.map(line => call(wallet.updateStatement, { params: { ...params, statementId: String(line._id) }, body: { amount: 10 } })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 400 });
  expect((await Wallet.findOne({ user: id, currency: 'USD' }).lean()).balance).toBe(10);
  expect((await UserStatement.findOne({ user: id, currency: 'USD' }).sort({ _id: -1 }).lean()).total).toBe(10);
  await expectConsistent('only one reduction covered by balance');
});


const generalDebtForTest = async (amount, notes) => (await call(balance.createBalance, { body: {
  balanceType: 'debt', amount, currency: 'USD', customerId: 'C100', notes,
  createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String((await account('110121'))._id),
} })).body;

test('debt creation and deletion roll back when outbox persistence fails', async () => {
  const Balance = require('../../models/balance');
  const Activities = require('../../models/activities');
  const { AccountingEvent } = require('../models');
  const countBefore = await Balance.countDocuments();
  let spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('creation outbox unavailable'));
  try { await expect(generalDebtForTest(13, 'atomic creation')).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await Balance.countDocuments()).toBe(countBefore);
  await expectConsistent('creation failure rolled back');
  const debt = await generalDebtForTest(13, 'atomic creation');
  await expectConsistent('created debt for deletion failure');
  const original = await Balance.findById(debt._id).lean();
  const activityCount = await Activities.countDocuments();
  spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('deletion outbox unavailable'));
  try { await expect(call(balance.deleteBalance, { params: { id: String(debt._id) } })).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await Balance.findById(debt._id).lean()).toEqual(original);
  expect(await Activities.countDocuments()).toBe(activityCount);
  await expectConsistent('deletion failure rolled back');
  await call(balance.deleteBalance, { params: { id: String(debt._id) } });
  await expectConsistent('deletion retry');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('manual closure rolls back original debt and lost remainder on outbox failure, then writes off 1.13 exactly', async () => {
  const Balance = require('../../models/balance');
  const { AccountingEvent } = require('../models');
  const debt = await generalDebtForTest(1.13, 'atomic closure');
  await expectConsistent('before manual closure failure');
  const original = await Balance.findById(debt._id).lean();
  const expenseBefore = await usd('520100');
  const args = { params: { id: String(debt._id) }, body: { note: 'write off remainder' } };
  const spy = jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('closure outbox unavailable'));
  try { await expect(call(balance.closeDebtManually, args)).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await Balance.findById(debt._id).lean()).toEqual(original);
  expect(await Balance.countDocuments({ sourceBalance: debt._id })).toBe(0);
  await expectConsistent('closure failure rolled back');
  const closed = (await call(balance.closeDebtManually, args)).body;
  expect(closed.manualClosure.writtenOffAmount).toBe(1.13);
  expect((await Balance.findById(closed.manualClosure.lostBalance).lean()).amount).toBe(1.13);
  await expectConsistent('closure retry');
  expect(await usd('520100')).toBe(expenseBefore + 113);
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
  await call(balance.deleteBalance, { params: args.params });
  await expectConsistent('deleted unpaid closed debt and remainder');
  expect(await Balance.countDocuments({ sourceBalance: debt._id })).toBe(0);
  expect(await usd('520100')).toBe(expenseBefore);
});

test('simultaneous manual closures create one lost debt and one writeoff', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(17, 'concurrent closure');
  await expectConsistent('before concurrent closures');
  const expenseBefore = await usd('520100');
  const args = { params: { id: String(debt._id) }, body: { note: 'concurrent writeoff' } };
  const results = await Promise.allSettled([call(balance.closeDebtManually, args), call(balance.closeDebtManually, args)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 400 });
  expect(await Balance.countDocuments({ sourceBalance: debt._id })).toBe(1);
  await expectConsistent('one manual closure');
  expect(await usd('520100')).toBe(expenseBefore + 1700);
});

test('deleting an original written-off debt is refused when its lost remainder has recoveries', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(10, 'recovered remainder');
  await expectConsistent('created recoverable debt');
  const closed = (await call(balance.closeDebtManually, { params: { id: String(debt._id) }, body: { note: 'recoverable writeoff' } })).body;
  await expectConsistent('written off recoverable debt');
  await deposit(3, 'USD');
  await call(balance.createPaymentHistory, { params: { id: String(closed.manualClosure.lostBalance) }, body: { amount: 3, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } });
  await expectConsistent('recovered part of remainder');
  await expect(call(balance.deleteBalance, { params: { id: String(debt._id) } })).rejects.toMatchObject({ statusCode: 400 });
  expect(await Balance.findById(debt._id).lean()).not.toBeNull();
  expect((await Balance.findById(closed.manualClosure.lostBalance).lean()).paymentHistory).toHaveLength(1);
  await expectConsistent('paid remainder preserved');
});

test('concurrent payment and debt deletion cannot leave a wallet deduction without its debt', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(12, 'delete payment race');
  await deposit(12, 'USD');
  await expectConsistent('before delete payment race');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const results = await Promise.allSettled([
    call(balance.deleteBalance, { params: { id: String(debt._id) } }),
    call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 12, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const saved = await Balance.findById(debt._id).lean();
  const after = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  if (saved) {
    expect(saved.amount).toBe(0);
    expect(saved.paymentHistory).toHaveLength(1);
    expect(after).toBe(Math.round((before - 12) * 100) / 100);
  } else { expect(after).toBe(before); }
  await expectConsistent('delete payment race resolved');
});

test('direct wallet payment preserves 1.13 in the deduction, order payment and running balance', async () => {
  const order = await newPurchaseOrder([{ description: 'exact cents payment', unitPrice: 1.13, quantity: 1 }]);
  await deposit(2, 'USD');
  await expectConsistent('before exact cents wallet payment');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  await payFromWallet(order, 1.13, 'USD', 1);
  const payment = await OrderPaymentHistory.findOne({ order: order._id }).lean();
  expect(payment.receivedAmount).toBe(1.13);
  const statement = await UserStatement.findById(payment.statementId).lean();
  expect(statement.amount).toBe(1.13);
  expect(statement.total).toBe(Math.round((before - 1.13) * 100) / 100);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(statement.total);
  await expectConsistent('exact cents wallet payment');
  expect(await usd('121000', { arKey: 'PUR:' + order._id })).toBe(0);
});


test('a partial payment racing manual closure is either refused or deducted from the written-off remainder', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(10, 'partial payment closure race');
  await deposit(4, 'USD');
  await expectConsistent('before closure payment race');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const expenseBefore = await usd('520100');
  const results = await Promise.allSettled([
    call(balance.closeDebtManually, { params: { id: String(debt._id) }, body: { note: 'partial payment race closure' } }),
    call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 4, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } }),
  ]);
  expect(results[0].status).toBe('fulfilled');
  const paid = results[1].status === 'fulfilled';
  const saved = await Balance.findById(debt._id).lean();
  const lost = await Balance.findById(saved.manualClosure.lostBalance).lean();
  expect(saved.paymentHistory).toHaveLength(paid ? 1 : 0);
  expect(saved.manualClosure.writtenOffAmount).toBe(paid ? 6 : 10);
  expect(lost.amount).toBe(paid ? 6 : 10);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(Math.round((before - (paid ? 4 : 0)) * 100) / 100);
  await expectConsistent('closure payment race resolved');
  expect(await usd('520100')).toBe(expenseBefore + (paid ? 600 : 1000));
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('failure to save deletion audit preserves original debt, its remainder and queued accounting events', async () => {
  const Balance = require('../../models/balance');
  const Activities = require('../../models/activities');
  const { AccountingEvent } = require('../models');
  const debt = await generalDebtForTest(9, 'deletion audit rollback');
  await expectConsistent('created debt before audit rollback');
  const closed = (await call(balance.closeDebtManually, { params: { id: String(debt._id) }, body: { note: 'audit rollback remainder' } })).body;
  await expectConsistent('closed debt before audit rollback');
  const beforeEvents = await AccountingEvent.countDocuments();
  const original = await Balance.findById(debt._id).lean();
  const remainder = await Balance.findById(closed.manualClosure.lostBalance).lean();
  const spy = jest.spyOn(Activities, 'create').mockRejectedValue(new Error('deletion audit unavailable'));
  try { await expect(call(balance.deleteBalance, { params: { id: String(debt._id) } })).rejects.toMatchObject({ statusCode: 500 }); }
  finally { spy.mockRestore(); }
  expect(await Balance.findById(debt._id).lean()).toEqual(original);
  expect(await Balance.findById(remainder._id).lean()).toEqual(remainder);
  expect(await AccountingEvent.countDocuments()).toBe(beforeEvents);
  await expectConsistent('audit failure rolled back');
  await call(balance.deleteBalance, { params: { id: String(debt._id) } });
  await expectConsistent('audit deletion retry');
});


test('settlement approval follows full debt payment and leaves wallets, claims and journal unchanged', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(10, 'settlement approval');
  await deposit(10, 'USD');
  await expectConsistent('before settlement approval');
  await expect(call(balance.confirmDebt, { params: { id: String(debt._id) }, body: { amount: 0 } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Balance.findById(debt._id).lean()).amount).toBe(10);
  await call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 10, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } });
  await expectConsistent('fully settled before approval');
  const walletBefore = await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean();
  const journalBefore = await JournalEntry.countDocuments();
  await call(balance.confirmDebt, { params: { id: String(debt._id) } });
  expect((await Balance.findById(debt._id).lean()).status).toBe('closed');
  expect((await Wallet.findById(walletBefore._id).lean()).balance).toBe(walletBefore.balance);
  expect(await JournalEntry.countDocuments()).toBe(journalBefore);
  await expectConsistent('approval changes state only');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('approval racing full payment never closes a debt before settlement commits', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(10, 'payment approval race');
  await deposit(10, 'USD');
  await expectConsistent('before payment approval race');
  const results = await Promise.allSettled([
    call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 10, currency: 'USD', rate: 1, createdAt: new Date().toISOString() } }),
    call(balance.confirmDebt, { params: { id: String(debt._id) } }),
  ]);
  expect(results[0].status).toBe('fulfilled');
  const saved = await Balance.findById(debt._id).lean();
  expect(saved.amount).toBe(0);
  expect(saved.paymentHistory).toHaveLength(1);
  if (results[1].status === 'rejected') {
    expect(results[1].reason).toMatchObject({ statusCode: 400 });
    expect(saved.status).toBe('waitingApproval');
    await call(balance.confirmDebt, { params: { id: String(debt._id) } });
  } else { expect(saved.status).toBe('closed'); }
  await expectConsistent('payment approval race resolved');
});


test.each([0, '0', undefined])('USD debt accepts same-currency partial and full payment with rate %s', async rate => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(2.26, 'same currency zero rate');
  await deposit(2.26, 'USD');
  await expectConsistent('before same currency zero-rate payment');
  const before = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance;
  const args = { params: { id: String(debt._id) }, body: { amount: 1.13, currency: 'USD', rate, createdAt: new Date().toISOString() } };
  await call(balance.createPaymentHistory, args);
  expect((await Balance.findById(debt._id).lean()).amount).toBe(1.13);
  await expectConsistent('same currency zero-rate partial payment');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(113);
  await call(balance.createPaymentHistory, args);
  const saved = await Balance.findById(debt._id).lean();
  expect(saved.amount).toBe(0);
  expect(saved.status).toBe('waitingApproval');
  expect(saved.paymentHistory.map(p => p.rate)).toEqual([0, 0]);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(Math.round((before - 2.26) * 100) / 100);
  await expectConsistent('same currency zero-rate full payment');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('LYD debt accepts LYD payment at zero rate and uses the accounting daily rate for book valuation', async () => {
  const debt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 100, currency: 'LYD', customerId: 'C100', notes: 'same dinar currency', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String((await account('110122'))._id) } })).body;
  await deposit(100, 'LYD');
  await expectConsistent('before same dinar zero rate');
  await call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 100, currency: 'LYD', rate: 0, createdAt: new Date().toISOString() } });
  expect((await require('../../models/balance').findById(debt._id).lean()).amount).toBe(0);
  await expectConsistent('same dinar zero-rate payment');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('USD debt still refuses conversion from LYD at zero, missing, negative or invalid exchange rates', async () => {
  const Balance = require('../../models/balance');
  const debt = await generalDebtForTest(10, 'conversion requires rate');
  await deposit(100, 'LYD');
  await expectConsistent('before invalid conversion rates');
  const original = await Balance.findById(debt._id).lean();
  const before = (await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean()).balance;
  for (const rate of [0, '0', undefined, '', -1, 'invalid', true]) {
    await expect(call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 100, currency: 'LYD', rate, sameCurrency: 'true', createdAt: new Date().toISOString() } })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(await Balance.findById(debt._id).lean()).toEqual(original);
  expect((await Wallet.findOne({ user: customer._id, currency: 'LYD' }).lean()).balance).toBe(before);
  await call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 100, currency: 'LYD', rate: 10, createdAt: new Date().toISOString() } });
  await expectConsistent('valid conversion still accepted');
  expect(await usd('121000', { arKey: 'GEN:' + debt._id })).toBe(0);
});

test('order-linked USD debt can settle at rate zero and its payment reaches the order and ledger', async () => {
  const order = await newPurchaseOrder([{ description: 'linked zero rate', unitPrice: 10, quantity: 1 }]);
  const debt = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 10, currency: 'USD', orderId: order.orderId, notes: 'linked zero rate', createdOffice: 'tripoli', debtType: 'invoice' } })).body;
  await deposit(10, 'USD');
  await expectConsistent('before linked zero rate');
  await call(balance.createPaymentHistory, { params: { id: String(debt._id) }, body: { amount: 10, currency: 'USD', rate: 0, createdAt: new Date().toISOString() } });
  const payment = await OrderPaymentHistory.findOne({ order: order._id }).lean();
  expect(payment.receivedAmount).toBe(10);
  expect(payment.rate).toBe(0);
  await expectConsistent('linked zero-rate settlement');
  expect(await usd('121000', { arKey: 'PUR:' + order._id })).toBe(0);
});
