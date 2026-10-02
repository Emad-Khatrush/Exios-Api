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

test('5. debts: a general debt from a cash box, paid from the wallet in dinars; closed by hand; deleted', async () => {
  const box = await account('110121');
  const created = (await call(balance.createBalance, { body: { balanceType: 'debt', amount: 20, currency: 'USD', customerId: 'C100', notes: 'دين تجربة', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String(box._id) } })).body;
  await expectConsistent('debt created');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(2000);
  await call(balance.createPaymentHistory, { params: { id: String(created._id) }, body: { amount: 100, currency: 'LYD', rate: 10, createdAt: new Date().toISOString() } });
  await expectConsistent('debt half paid in dinars');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(1000);
  await call(balance.closeDebtManually, { params: { id: String(created._id) }, body: { note: 'الباقي يُشطب' } });
  await expectConsistent('debt closed by hand');
  expect(await usd('121000', { arKey: `GEN:${created._id}` })).toBe(0);
  expect(await usd('520100')).toBe(1000);
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
