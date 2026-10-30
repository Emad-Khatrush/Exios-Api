// The cases most likely to be forgotten (owner's request, 2026-10-03), through the system's own
// controllers, with the books checked against the system after every step.
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { OWNER_ID, call, net, usd, expectConsistent } = require('./e2eKit');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { emitAccountingEvent, processQueue } = require('../services/events');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const Balance = require('../../models/balance');
const UserStatement = require('../../models/userStatement');
const wallet = require('../../controllers/wallet');
const orders = require('../../controllers/orders');
const balance = require('../../controllers/balance');
const staff = require('../services/staffOperations');

jest.setTimeout(180000);

let owner;
let clerk;
let customer;
let unknown;
const users = () => mongoose.connection.collection('users');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2025-01-01', rate: 10 }]);
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  await users().insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  const clerkId = (await users().insertOne({ username: 'clerk', firstName: 'Clerk', lastName: 'Y', phone: 910000002, customerId: 'STF1', office: 'tripoli', roles: { isEmployee: true } })).insertedId;
  const customerId = (await users().insertOne({ username: 'c1', firstName: 'Customer', lastName: 'Z', phone: 910000003, customerId: 'C100', roles: { isClient: true } })).insertedId;
  const unknownId = (await users().insertOne({ username: 'a000', firstName: 'Unknown', lastName: '-', phone: 910000004, customerId: 'A000', roles: { isClient: true } })).insertedId;
  owner = await users().findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  clerk = await users().findOne({ _id: clerkId });
  customer = await users().findOne({ _id: customerId });
  unknown = await users().findOne({ _id: unknownId });
});
afterAll(stopDb);

const as = (user) => ({ user });
const purchase = async (amount, customerCode = 'C100') => (await call(orders.createOrder, {
  ...as(owner), body: { customerId: customerCode, fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'x', unitPrice: amount, quantity: 1 }]), paymentList: '[]' },
})).body;
const shipment = async (packages, customerCode = 'C100') => (await call(orders.createOrder, {
  ...as(owner),
  body: {
    customerId: customerCode, fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
    paymentList: JSON.stringify(packages.map((p, i) => ({ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: p.weight, measureUnit: 'KG', exiosPrice: p.price, trackingNumber: `E${Date.now()}${i}`, shipmentMethod: 'air' } }))),
  },
})).body;
const deposit = (who, amount, currency, extra = {}, user = owner) => call(wallet.addBalanceToWallet, {
  user, params: { id: String(who._id) }, body: { amount, currency, description: `إيداع ${amount}`, note: 'x', actionType: 'cash', office: 'tripoli', createdAt: now(), ...extra },
});
const pay = (who, order, amount, currency, rate = 0, user = owner, category = 'invoice') => call(wallet.useBalanceOfWallet, {
  user, params: { id: String(who._id) }, body: { amount, currency, rate, orderId: order.orderId, category, description: `خصم ${amount}`, note: `Order Id (${order.orderId}) => x`, createdAt: now() },
});
const walletOf = async (who, currency) => (await Wallet.findOne({ user: who._id, currency }).lean())?.balance || 0;
const paymentsOf = async (orderId) => (await call(orders.getPaymentsOfOrder, { params: { id: String(orderId) } })).body.results;
const deliver = (who, order, pkgs, payment) => call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(who._id) }, body: { selectedPackages: pkgs.map((p) => ({ id: String(p._id), orderId: order.orderId })), payment } });

test('1. a closed period: a clerk cannot add, edit or delete in it; the owner can, posted on the first open day', async () => {
  await deposit(customer, 100, 'USD');
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-02-28' } });
  invalidateConfig();
  const refused = await deposit(customer, 10, 'USD', { createdAt: '2026-02-10T10:00:00Z' }, clerk).catch((e) => e);
  if (refused.statusCode !== 403) console.log('DEBUG', refused.statusCode, refused.message);
  expect(refused.statusCode).toBe(403);
  await deposit(customer, 10, 'USD', { createdAt: '2026-02-10T10:00:00Z' }, owner);
  await expectConsistent('owner in closed period');
  const late = await JournalEntry.findOne({ eventType: 'DEPOSIT' }).sort({ createdAt: -1 }).lean();
  expect(late.day > '2026-02-28').toBe(true);
  const old = await UserStatement.findOne({ amount: 10 }).lean();
  await expect(call(wallet.updateStatement, { ...as(clerk), params: { id: String(customer._id), statementId: String(old._id) }, body: { amount: 11 } })).rejects.toMatchObject({ statusCode: 403 });
  await expect(call(wallet.deleteStatement, { ...as(clerk), params: { id: String(customer._id), statementId: String(old._id) } })).rejects.toMatchObject({ statusCode: 403 });
  await AccountingSettings.updateOne({ key: 'main' }, { $unset: { lockDate: 1 } });
  invalidateConfig();
});

test('2. partial deliveries: three packages in two invoices, then only the second invoice cancelled', async () => {
  const order = await shipment([{ weight: 2, price: 10 }, { weight: 3, price: 10 }, { weight: 1.5, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  await deposit(customer, 100, 'USD');
  await deliver(customer, full, full.paymentList.slice(0, 2), { amountUSD: 50 });
  await expectConsistent('first delivery');
  await deliver(customer, full, full.paymentList.slice(2), { amountUSD: 15 });
  await expectConsistent('second delivery');
  expect(-(await usd('410100', { orderId: order._id }))).toBe(6500);
  const Invoice = require('../../models/invoice');
  const second = await Invoice.findOne({ 'list.orderId': full.orderId }).sort({ createdAt: -1 }).lean();
  await call(orders.cancelInvoice, { ...as(owner), params: { id: String(second._id) }, body: {} });
  await expectConsistent('second invoice cancelled');
  expect(-(await usd('410100', { orderId: order._id }))).toBe(5000);
  expect(await usd('121000', { arKey: `SHP:${order._id}:${full.paymentList[2]._id}` })).toBe(1500);
});

test('3. a package re-priced after delivery and payment: the customer owes the difference, revenue waits for it', async () => {
  const order = await shipment([{ weight: 4, price: 10 }]);
  const full = await Order.findById(order._id).lean();
  await deposit(customer, 40, 'USD');
  await deliver(customer, full, full.paymentList, { amountUSD: 40 });
  await expectConsistent('delivered');
  const key = `SHP:${order._id}:${full.paymentList[0]._id}`;
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: full.paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, exiosPrice: 12 } })) } });
  await expectConsistent('re-priced up');
  expect(await usd('121000', { arKey: key })).toBe(800);
  // Within the 2$ tolerance the revenue was recognised; a bigger rise defers it until paid
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: (await Order.findById(order._id).lean()).paymentList.map((p) => ({ ...p, deliveredPackages: { ...p.deliveredPackages, exiosPrice: 15 } })) } });
  await expectConsistent('re-priced further');
  expect(await usd('121000', { arKey: key })).toBe(2000);
  expect(Math.abs(await usd('410100', { arKey: key }))).toBe(0);
});

test('4. a trip with costs cannot be deleted', async () => {
  const inventory = require('../../controllers/inventory');
  const trip = (await call(inventory.createInventory, { ...as(owner), body: { voyage: 'DEL-1', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN' } })).body;
  await staff.addTripCost(trip._id, { vendorName: 'Cargo', amount: 100, payFromAccountId: (await account('110121'))._id, day: today() }, { user: owner });
  await expect(call(inventory.deleteInventory, { ...as(owner), params: { id: String(trip._id) } })).rejects.toMatchObject({ statusCode: 400 });
  await expectConsistent('trip kept');
});

test('5. paid from the unknown customer A000, then given to the real customer with the wallet lines moved', async () => {
  const fresh = await users().findOne({ _id: (await users().insertOne({ username: 'c2', firstName: 'Real', lastName: 'C', phone: 910000006, customerId: 'C200', roles: { isClient: true } })).insertedId });
  const unknownBefore = await walletOf(unknown, 'USD');
  const order = await purchase(30, 'A000');
  await deposit(unknown, 30, 'USD');
  await pay(unknown, order, 30, 'USD');
  await expectConsistent('A000 paid');
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { customerId: 'C200' } });
  await expectConsistent('customer changed');
  expect(await usd('121000', { arKey: `PUR:${order._id}`, partnerId: unknown._id })).toBe(0);
  const customerChange = require('../services/customerChange');
  const { results } = await customerChange.movableStatements(order._id);
  // Offered: the payment (linked) and A000's deposit (from around the order's date)
  expect(results.some((r) => r.calculationType === '-')).toBe(true);
  expect(results.some((r) => r.calculationType === '+')).toBe(true);
  // The payment alone would leave the real customer's wallet below zero: refused
  await expect(customerChange.moveStatements(order._id, results.filter((r) => r.calculationType === '-').map((r) => r._id), { user: owner })).rejects.toMatchObject({ statusCode: 400 });
  const mine = results.filter((r) => r.calculationType === '-' || r.amount === 30);
  await customerChange.moveStatements(order._id, mine.map((r) => r._id), { user: owner });
  await expectConsistent('wallet lines moved');
  expect(await walletOf(unknown, 'USD')).toBe(unknownBefore);
  expect(await walletOf(fresh, 'USD')).toBe(0);
});

test('6. dinars deposited at 10 and spent at 9.8: an exchange loss; an emptied dinar wallet is empty in dollars too', async () => {
  const order = await purchase(100);
  await deposit(customer, 1000, 'LYD', { rate: 10 });
  await pay(customer, order, 980, 'LYD', 9.8);
  await expectConsistent('paid at 9.8');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(await usd('710100')).toBe(200);
  await call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount: 20, currency: 'LYD', actionType: 'withdrawal', office: 'tripoli', description: 'سحب', note: 'سحب', createdAt: now() } });
  await expectConsistent('dinars withdrawn');
  expect(await net('220200', { partnerId: customer._id })).toEqual({ usd: 0, foreign: 0 });
});

test('7. paying an order also pays its own debt; cancelling the payment reopens the debt', async () => {
  const order = await purchase(50);
  await call(balance.createBalance, { ...as(owner), body: { balanceType: 'debt', amount: 50, currency: 'USD', orderId: order.orderId, notes: 'متبقي', createdOffice: 'tripoli', debtType: 'invoice' } });
  await deposit(customer, 50, 'USD');
  await pay(customer, order, 50, 'USD');
  await expectConsistent('order and its debt paid');
  expect((await Balance.findOne({ order: order._id }).lean()).status).not.toBe('open');
  const payment = (await paymentsOf(order._id))[0];
  await call(wallet.cancelPayment, { ...as(owner), params: { id: String(customer._id) }, body: { payment } });
  await expectConsistent('payment cancelled');
  expect((await Balance.findOne({ order: order._id }).lean()).status).toBe('open');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(5000);
});

test('8. an inactive order paid, then cancelled: the payment comes back', async () => {
  const order = await purchase(25);
  await Order.updateOne({ _id: order._id }, { $set: { unsureOrder: true } });
  await emitAccountingEvent('order', order._id, {});
  await deposit(customer, 25, 'USD');
  const before = await walletOf(customer, 'USD');
  await pay(customer, order, 25, 'USD');
  await expectConsistent('inactive order paid', { allow: ['overpaid'] });
  await call(orders.cancelOrder, { ...as(owner), params: { id: String(order._id) }, body: { cancelationReason: 'x' } });
  await expectConsistent('inactive order cancelled');
  expect(await walletOf(customer, 'USD')).toBe(before);
});

test('9. a purchase invoice paid in instalments: revenue and cost in proportion, all at the last payment', async () => {
  const order = await purchase(100);
  await staff.addOrderCost(order._id, { vendorName: 'Shop', amount: 60, payFromAccountId: (await account('110121'))._id, day: today() }, { user: owner });
  await deposit(customer, 100, 'USD');
  await pay(customer, order, 50, 'USD');
  await expectConsistent('half paid');
  expect(-(await usd('410300', { orderId: order._id }))).toBe(5000);
  expect(await usd('510400', { orderId: order._id })).toBe(3000);
  await pay(customer, order, 50, 'USD');
  await expectConsistent('fully paid');
  expect(-(await usd('410300', { orderId: order._id }))).toBe(10000);
  expect(await usd('510400', { orderId: order._id })).toBe(6000);
});

test('10. an invoice lowered below what was paid: the customer has credit on it, settled by giving the payment back', async () => {
  const order = await purchase(100);
  await deposit(customer, 100, 'USD');
  await pay(customer, order, 100, 'USD');
  await expectConsistent('paid');
  await call(orders.updateOrderItems, { ...as(owner), params: { id: String(order._id) }, body: { items: [{ description: 'x', unitPrice: 80, quantity: 1 }] } });
  const fresh = await Order.findById(order._id).lean();
  await call(orders.confirmItemsChanges, { ...as(owner), params: { id: String(order._id) }, body: { status: 'accepted', requestedEditDetails: fresh.requestedEditDetails } });
  await expectConsistent('lowered', { allow: ['overpaid'] });
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(-2000);
  const payment = (await paymentsOf(order._id))[0];
  await call(wallet.cancelPayment, { ...as(owner), params: { id: String(customer._id) }, body: { payment } });
  await pay(customer, order, 80, 'USD');
  await expectConsistent('paid again at the new total');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
  expect(-(await usd('410300', { orderId: order._id }))).toBe(8000);
});

test('11. deposits into a bank and into a partner\'s current account, not a cash box', async () => {
  const bank = await account('110201');
  const wasl = await account('110401');
  await deposit(customer, 557, 'USD', { actionType: 'bank', accountId: String(bank._id) });
  await deposit(customer, 300, 'USD', { accountId: String(wasl._id) });
  await expectConsistent('deposits to bank and current account');
  expect(await usd('110201')).toBe(55700);
  expect(await usd('110401')).toBe(30000);
});

test('12. two payments on one order at the same moment are both posted once, the claim ends at zero', async () => {
  const order = await purchase(100);
  await deposit(customer, 100, 'USD');
  await Promise.all([pay(customer, order, 50, 'USD'), pay(customer, order, 50, 'USD')]);
  await expectConsistent('concurrent payments');
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
});

test('13. the same event recorded twice posts once', async () => {
  await deposit(customer, 12, 'USD');
  const line = await UserStatement.findOne({ amount: 12 }).sort({ _id: -1 }).lean();
  await emitAccountingEvent('statement', line._id, {});
  await emitAccountingEvent('statement', line._id, {});
  await processQueue();
  expect(await JournalEntry.countDocuments({ 'source.id': line._id, status: 'posted' })).toBe(1);
  await expectConsistent('duplicate events');
});

test('14. deleting a deposit already spent: refused, the wallet would go below zero', async () => {
  const spender = await users().findOne({ _id: (await users().insertOne({ username: 'c3', firstName: 'Spender', lastName: 'S', phone: 910000007, customerId: 'C300', roles: { isClient: true } })).insertedId });
  const order = await purchase(33, 'C300');
  await call(wallet.addBalanceToWallet, { ...as(owner), params: { id: String(spender._id) }, body: { amount: 33, currency: 'USD', description: 'إيداع', note: 'x', actionType: 'cash', office: 'tripoli', createdAt: now() } });
  await pay(spender, order, 33, 'USD');
  const line = await UserStatement.findOne({ user: spender._id, amount: 33, calculationType: '+' }).lean();
  await expect(call(wallet.deleteStatement, { ...as(owner), params: { id: String(spender._id), statementId: String(line._id) } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(call(wallet.updateStatement, { ...as(owner), params: { id: String(spender._id), statementId: String(line._id) }, body: { amount: 10 } })).rejects.toMatchObject({ statusCode: 400 });
  await expectConsistent('spent deposit kept');
});
