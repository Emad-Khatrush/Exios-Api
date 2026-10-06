// The owner's requests of 2026-10-03 (third round): document numbers after a discarded dry run,
// deposits edited twice in a row, deposit places by currency, money dated before the opening
// count, Alipay transfers, free shipping and customs clearance sold to the customer. Each step goes
// through the same code the screens call and the books are checked after it.
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { OWNER_ID, call, usd, expectConsistent } = require('./e2eKit');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry, MigrationRun, AccountingOffice } = require('../models');
const docs = require('../models/documents');
const { processQueue } = require('../services/events');
const { runInTransaction } = require('../services/transaction');
const { cancelDocument } = require('../services/cancel');
const Order = require('../../models/order');
const UserStatement = require('../../models/userStatement');
const wallet = require('../../controllers/wallet');
const orders = require('../../controllers/orders');

jest.setTimeout(180000);

let owner;
let customer;
const users = () => mongoose.connection.collection('users');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const as = (user) => ({ user });
const tx = (fn) => runInTransaction(fn);

beforeAll(async () => {
  await startDb();
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2025-01-01', rate: 10 }, { currency: 'CNY', day: '2025-01-01', rate: 7 }]);
  await mongoose.connection.collection('exchangerates').insertOne({ fromCurrency: 'usd', toCurrency: 'lyd', rate: 10 });
  await users().insertOne({ _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', firstName: 'Owner', lastName: 'X', phone: 910000001, customerId: 'OWN1', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } });
  const id = (await users().insertOne({ username: 'c1', firstName: 'Customer', lastName: 'Z', phone: 910000004, customerId: 'C100', roles: { isClient: true } })).insertedId;
  owner = await users().findOne({ _id: new mongoose.Types.ObjectId(OWNER_ID) });
  customer = await users().findOne({ _id: id });
  // These end-to-end workflows spend company cash; start the test books with explicit opening
  // capital so balance guards exercise realistic funded boxes instead of relying on overdrafts.
  const { createEquity } = require('../services/posting/people');
  await tx(async (session) => createEquity({ type: 'capital_in', partyName: 'Opening test capital', day: '2026-01-02', accountId: (await account('110101'))._id, amount: 10000 }, { session, req: { user: owner } }));
});
afterAll(stopDb);

const deposit = (amount, currency, extra = {}) => call(wallet.addBalanceToWallet, {
  ...as(owner), params: { id: String(customer._id) },
  body: { amount, currency, description: `إيداع ${amount} ${currency}`, note: 'x', actionType: 'cash', office: 'tripoli', createdAt: now(), ...extra },
});
const editLine = (line, body) => call(wallet.updateStatement, { ...as(owner), params: { id: String(customer._id), statementId: String(line._id) }, body });

test('1. a discarded dry run does not restart the numbers of yuan purchases, refunds, write-offs and receipts', async () => {
  const alipay = require('../services/posting/alipay');
  const { rebuildCounters } = require('../services/migration');
  const broker = await docs.Vendor.create({ name: 'وسيط', type: 'service' });
  const input = async () => ({ vendorId: broker._id, day: today(), fromAccountId: (await account('110101'))._id, amount: 100, toAccountId: (await account('110301'))._id, cnyReceived: 700 });
  const first = await tx(async (session) => alipay.createYuanPurchase(await input(), { session, req: { user: owner } }));
  // What discarding a dry run does to the counters
  await rebuildCounters();
  const second = await tx(async (session) => alipay.createYuanPurchase(await input(), { session, req: { user: owner } }));
  expect(first.number).not.toBe(second.number);
});

test('2. a deposit edited twice before the queue runs keeps exactly one entry, in the last office', async () => {
  await deposit(300, 'USD');
  await expectConsistent('deposit');
  const line = await UserStatement.findOne({ user: customer._id, amount: 300 }).lean();
  // Two edits back to back, then a third one: the queue sees them all at once
  await editLine(line, { office: 'benghazi' });
  await editLine(line, { office: 'tripoli' });
  await editLine(line, { office: 'benghazi' });
  await processQueue();
  const live = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': line._id, reversalOf: null, status: 'posted' }).lean();
  expect(live).toHaveLength(1);
  await expectConsistent('edited three times');
  expect(await usd('110123')).toBe(30000);
  expect(await usd('110121')).toBe(0);
});

test('3. deposits go only where there is a box in their currency; Misurata is no office', async () => {
  const { depositPlaces } = require('../services/moneyAccounts');
  expect(await AccountingOffice.exists({ code: 'misurata' })).toBeNull();
  const lyd = (await depositPlaces('LYD')).map((p) => p.value);
  expect(lyd).toEqual(expect.arrayContaining(['tripoli', 'benghazi']));
  expect(lyd).not.toContain('turkey');
  expect(lyd).not.toContain('china');
  expect((await depositPlaces('USD')).map((p) => p.value)).toEqual(expect.arrayContaining(['tripoli', 'benghazi', 'turkey', 'china']));
  await expect(deposit(500, 'LYD', { office: 'turkey' })).rejects.toMatchObject({ statusCode: 400 });
  // A refund names no box: any office
  await deposit(5, 'LYD', { office: 'turkey', actionType: 'refund' });
  await deposit(500, 'LYD', { office: 'benghazi' });
  const line = await UserStatement.findOne({ user: customer._id, amount: 500, currency: 'LYD' }).lean();
  await expect(editLine(line, { office: 'china' })).rejects.toMatchObject({ statusCode: 400 });
  await expectConsistent('deposit places');
});

test('4. money dated before the count leaves the counted boxes alone and goes to the opening balance', async () => {
  const payables = require('../services/posting/payables');
  const countDay = '2026-06-30';
  const sub = await account('110121');
  await MigrationRun.create({ runId: 'MIG-TEST-COUNT', status: 'committed', committedAt: new Date(), cutoff: new Date('2026-06-30T20:00:00Z'), config: { countDay, openingCounts: [{ accountId: sub._id, amount: 0 }] } });
  invalidateConfig();
  const cashVendor = await docs.Vendor.findOne({ seedKey: 'cash_expenses' }).lean();
  const rent = await account('530200');
  const boxBefore = await usd('110121');
  const openingBefore = await usd('390000');
  // An old rent forgotten until after go-live, paid from the counted box
  const bill = await tx((session) => payables.createBill({
    vendorId: cashVendor._id, day: '2026-06-15', currency: 'USD', isQuickExpense: true, paidImmediatelyFrom: sub._id,
    lines: [{ description: 'إيجار يونيو', amount: 250, target: 'expense', accountId: rent._id, office: 'tripoli' }],
  }, { session, req: { user: owner } }));
  expect(await usd('110121')).toBe(boxBefore);
  expect(await usd('390000')).toBe(openingBefore - 25000);
  // The expense is in June
  const [june] = await JournalEntry.aggregate([{ $match: { day: { $gte: '2026-06-01', $lte: '2026-06-30' }, 'lines.accountId': rent._id } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': rent._id } }, { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } }]);
  expect(june.net).toBe(25000);
  const notes = (await JournalEntry.find({ 'notes.0': { $exists: true }, day: '2026-06-15' }).lean()).flatMap((e) => e.notes);
  expect(notes.join(' ')).toContain('قبل الجرد');
  // Cancelling it undoes exactly what it did
  await tx((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req: { user: owner }, reason: 'x' }));
  expect(await usd('110121')).toBe(boxBefore);
  expect(await usd('390000')).toBe(openingBefore);
  // A deposit dated before the count: the wallet gets it, the box does not
  await deposit(40, 'USD', { createdAt: '2026-06-20T10:00:00Z' });
  await expectConsistent('old deposit');
  expect(await usd('110121')).toBe(boxBefore);
  expect(await usd('390000')).toBe(openingBefore + 4000);
  // After the count day the box moves as always
  await deposit(60, 'USD', { createdAt: '2026-07-02T10:00:00Z' });
  await expectConsistent('new deposit');
  expect(await usd('110121')).toBe(boxBefore + 6000);
  await MigrationRun.deleteOne({ runId: 'MIG-TEST-COUNT' });
  invalidateConfig();
});

const purchase = async (amount, extra = {}) => (await call(orders.createOrder, {
  ...as(owner), body: { customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'x', unitPrice: amount, quantity: 1 }]), paymentList: '[]', ...extra },
})).body;
const pay = (order, amount, currency = 'USD', rate = 0, category = 'invoice') => call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount, currency, rate, orderId: order.orderId, category, description: 'خصم', note: `Order Id (${order.orderId}) => x`, createdAt: now() } });
const orderCost = (order, amount, extra = {}) => tx(async (session) => require('../services/posting/payables').createBill({
  vendorId: (await docs.Vendor.findOne({ seedKey: 'cash_expenses' }).lean())._id, day: today(), currency: 'USD', paidImmediatelyFrom: (await account('110101'))._id,
  lines: [{ description: 'شراء', amount, target: 'order', orderId: order._id }], ...extra,
}, { session, req: { user: owner } }));

test('5. Alipay: an order marked a transfer after it was paid moves its revenue and cost; no transfer cost typed as a plain expense; no future dates', async () => {
  const { emitAccountingEvent } = require('../services/events');
  await deposit(2000, 'USD');
  const order = await purchase(500);
  await pay(order, 500);
  await orderCost(order, 300);
  await expectConsistent('purchase paid and bought');
  const byOrder = { orderId: new mongoose.Types.ObjectId(String(order._id)) };
  expect(-(await usd('410300', byOrder))).toBe(50000);
  expect(await usd('510400', byOrder)).toBe(30000);
  // Marked "Alipay transfer" afterwards: both move to the transfer accounts
  await Order.updateOne({ _id: order._id }, { $set: { isRemittance: true } });
  await emitAccountingEvent('order', order._id, {});
  await expectConsistent('marked a transfer');
  expect(await usd('410300', byOrder)).toBe(0);
  expect(await usd('510400', byOrder)).toBe(0);
  expect(-(await usd('410700', byOrder))).toBe(50000);
  expect(await usd('510700', byOrder)).toBe(30000);
  // And back
  await Order.updateOne({ _id: order._id }, { $set: { isRemittance: false } });
  await emitAccountingEvent('order', order._id, {});
  await expectConsistent('unmarked');
  expect(await usd('410700', byOrder)).toBe(0);
  expect(-(await usd('410300', byOrder))).toBe(50000);
  expect(await usd('510400', byOrder)).toBe(30000);

  // The yuan of a transfer typed as a plain expense on the transfer cost: refused
  const cashVendor = await docs.Vendor.findOne({ seedKey: 'cash_expenses' }).lean();
  await expect(tx(async (session) => require('../services/posting/payables').createBill({
    vendorId: cashVendor._id, day: today(), currency: 'USD', paidImmediatelyFrom: (await account('110101'))._id,
    lines: [{ description: 'حوالة للعميل', amount: 150, target: 'expense', accountId: (await account('510700'))._id, office: 'china' }],
  }, { session, req: { user: owner } }))).rejects.toThrow('تكلفة مبيعات');

  // A transfer dated tomorrow: refused
  const alipay = require('../services/posting/alipay');
  const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const broker = await docs.Vendor.create({ name: 'وسيط 2', type: 'service' });
  await expect(tx(async (session) => alipay.createYuanPurchase({ vendorId: broker._id, day: tomorrow, fromAccountId: (await account('110101'))._id, amount: 100, toAccountId: (await account('110301'))._id, cnyReceived: 700 }, { session, req: { user: owner } }))).rejects.toThrow('المستقبل');
});

test('6. free shipping with a purchase: the free package carries its weight share of the trip into the order\'s purchase cost', async () => {
  const inventory = require('../../controllers/inventory');
  const staff = require('../services/staffOperations');
  const order = (await call(orders.createOrder, {
    ...as(owner),
    body: {
      customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'true', isShipment: 'true', placedAt: 'tripoli',
      items: JSON.stringify([{ description: 'سلة', unitPrice: 1000, quantity: 1 }]),
      paymentList: JSON.stringify([
        { arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: 10, measureUnit: 'KG', exiosPrice: 0, trackingNumber: `FREE${Date.now()}`, shipmentMethod: 'air' } },
        { arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: 30, measureUnit: 'KG', exiosPrice: 8, trackingNumber: `PAID${Date.now()}`, shipmentMethod: 'air' } },
      ]),
    },
  })).body;
  const full = await Order.findById(order._id).lean();
  await deposit(1500, 'USD');
  await pay(order, 1000);
  await orderCost(order, 700);
  const trip = (await call(inventory.createInventory, { ...as(owner), body: { voyage: 'AIR-FREE', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', shippedCountry: 'CN' } })).body;
  await call(inventory.addOrdersToTheInventory, { ...as(owner), query: { id: String(trip._id) }, body: full.paymentList.map((p) => ({ paymentList: { _id: String(p._id) } })) });
  await staff.addTripCost(trip._id, { vendorName: 'Turkish Cargo', amount: 400, payFromAccountId: (await account('110121'))._id, costCategory: 'shipping', day: today() }, { user: owner });
  await expectConsistent('free and paid packages on a trip with its cost');
  const byOrder = { orderId: new mongoose.Types.ObjectId(String(order._id)) };
  const tripId = new mongoose.Types.ObjectId(String(trip._id));
  expect(await usd('510400', byOrder)).toBe(70000);
  const deliver = (pkg, amountUSD) => call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(pkg._id), orderId: full.orderId }], payment: { amountUSD } } });
  // The free package delivered: a quarter of the trip (10 of 40 kg) joins the purchase cost
  await deliver(full.paymentList[0], 0);
  await expectConsistent('free package delivered');
  expect(await usd('510400', byOrder)).toBe(70000 + 10000);
  expect(await usd('510400', { ...byOrder, tripId })).toBe(10000);
  expect(await usd('130100', { tripId })).toBe(30000);
  // The paid one: its share is shipping cost as always, and the trip is empty
  await deliver(full.paymentList[1], 240);
  await expectConsistent('paid package delivered');
  expect(await usd('510100', byOrder)).toBe(30000);
  expect(await usd('130100', { tripId })).toBe(0);
  // A later cost on the trip (a forgotten invoice) is shared again, the free part to the order
  await staff.addTripCost(trip._id, { vendorName: 'تخزين', amount: 40, payFromAccountId: (await account('110121'))._id, costCategory: 'shipping', day: today() }, { user: owner });
  await expectConsistent('later trip cost');
  expect(await usd('510400', { ...byOrder, tripId })).toBe(11000);
  expect(await usd('130100', { tripId })).toBe(0);
});

test('7. a full container: shipping 4,500 USD, customs clearance sold for 3,000 LYD, the agent owed 2,500 LYD; revenue and cost each in their own account', async () => {
  const payables = require('../services/posting/payables');
  const order = (await call(orders.createOrder, {
    ...as(owner),
    body: {
      customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'sea', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
      paymentList: JSON.stringify([{ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: 1, measureUnit: 'CBM', exiosPrice: 4500, trackingNumber: `CONT${Date.now()}`, shipmentMethod: 'sea', customsFee: { amount: 3000, currency: 'LYD' } } }]),
    },
  })).body;
  const full = await Order.findById(order._id).lean();
  const pkg = full.paymentList[0];
  expect(pkg.deliveredPackages.customsFee).toMatchObject({ amount: 3000, currency: 'LYD', usd: 300 });
  await expectConsistent('container billed');
  const customsKey = `SHP:${order._id}:${pkg._id}:CUS`;
  expect(await usd('121000', { arKey: customsKey })).toBe(30000);

  // The clearing agent's invoice, owed until paid
  const agent = await docs.Vendor.create({ name: 'مخلّص جمركي', type: 'service' });
  await tx((session) => payables.createBill({
    vendorId: agent._id, day: today(), currency: 'LYD', rate: 10,
    lines: [{ description: 'تخليص حاوية', amount: 2500, target: 'customs', orderId: order._id, packageId: pkg._id }],
  }, { session, req: { user: owner } }));
  await expectConsistent('agent invoice');
  const byPackage = { packageId: new mongoose.Types.ObjectId(String(pkg._id)) };
  expect(await usd('130300', byPackage)).toBe(25000);
  expect(await usd('510800')).toBe(0);
  expect(await usd('210200', { vendorId: agent._id })).toBe(-25000);

  // The customer pays: dollars for the container, dinars for the customs, and takes it
  const lydBefore = (await mongoose.connection.collection('wallets').findOne({ user: customer._id, currency: 'LYD' }))?.balance || 0;
  await deposit(4500, 'USD');
  await deposit(3000, 'LYD');
  await call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(pkg._id), orderId: full.orderId }], payment: { amountUSD: 4500 } } });
  await expectConsistent('container delivered and paid');
  expect(await usd('121000', { arKey: customsKey })).toBe(0);
  expect(-(await usd('410900'))).toBe(30000);
  expect(-(await usd('410200', { orderId: new mongoose.Types.ObjectId(String(order._id)) }))).toBe(450000);
  expect(await usd('510800')).toBe(25000);
  expect(await usd('130300', byPackage)).toBe(0);
  const lyd = await mongoose.connection.collection('wallets').findOne({ user: customer._id, currency: 'LYD' });
  // The 3,000 LYD went to the customs clearance
  expect(lyd.balance).toBeCloseTo(lydBefore, 2);
});

test('8. on the count day itself: what was done before the count is in it, a withdrawal that afternoon leaves the box', async () => {
  const sub = await account('110121');
  // Counted when the dry run read the books, on 2026-08-10 at 09:39 Libya time
  await MigrationRun.create({ runId: 'MIG-TEST-SAMEDAY', status: 'committed', committedAt: new Date(), cutoff: new Date('2026-08-10T07:39:00Z'), countAt: new Date('2026-08-10T07:39:00Z'), config: { countDay: '2026-08-10', openingCounts: [{ accountId: sub._id, amount: 0 }] } });
  invalidateConfig();
  await deposit(500, 'USD', { createdAt: '2026-08-11T09:00:00Z' });
  await expectConsistent('money for the withdrawals');
  const box = await usd('110121');
  const opening = await usd('390000');
  const withdraw = (amount, createdAt) => call(wallet.useBalanceOfWallet, { ...as(owner), params: { id: String(customer._id) }, body: { amount, currency: 'USD', actionType: 'withdrawal', office: 'tripoli', description: `سحب ${amount}`, note: 'سحب', createdAt } });
  // That morning, before the count: already out of the counted box
  await withdraw(30, '2026-08-10T06:00:00Z');
  await expectConsistent('withdrawal before the count');
  expect(await usd('110121')).toBe(box);
  expect(await usd('390000')).toBe(opening - 3000);
  // That afternoon, after the count: out of the box
  await withdraw(100, '2026-08-10T14:50:00Z');
  await expectConsistent('withdrawal after the count');
  expect(await usd('110121')).toBe(box - 10000);
  expect(await usd('390000')).toBe(opening - 3000);
  await MigrationRun.deleteOne({ runId: 'MIG-TEST-SAMEDAY' });
  invalidateConfig();
});

test('9. an expense paid in dinars is valued at the rate of its own date, or the rate typed; the box gives at its average', async () => {
  const payables = require('../services/posting/payables');
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-04-10', rate: 8 }]);
  await deposit(3000, 'LYD');
  await expectConsistent('dinars in the box');
  const box = await account('110122');
  const cashVendor = await docs.Vendor.findOne({ seedKey: 'cash_expenses' }).lean();
  const rent = await account('530200');
  const expense = (day, rate) => tx((session) => payables.createBill({
    vendorId: cashVendor._id, day, currency: 'LYD', rate, isQuickExpense: true, paidImmediatelyFrom: box._id,
    lines: [{ description: `إيجار ${day}`, amount: 800, target: 'expense', accountId: rent._id, office: 'tripoli' }],
  }, { session, req: { user: owner } }));
  const rentOf = async (bill) => (await JournalEntry.findOne({ eventKey: `BILL:${bill._id}` }).lean()).lines.find((l) => String(l.accountId) === String(rent._id)).debit;
  // April, no rate typed: April's rate (8), not today's
  expect(await rentOf(await expense('2026-04-20'))).toBe(10000);
  // A rate typed on it wins
  expect(await rentOf(await expense('2026-04-21', 9.5))).toBe(8421);
  await expectConsistent('expenses in dinars');
});

test('10. cancelling an order after a supplier refund gives back exactly what was paid, not the refund twice', async () => {
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  const walletUsd = async () => Number((await mongoose.connection.collection('wallets').findOne({ user: customer._id, currency: 'USD' }))?.balance || 0);
  await deposit(200, 'USD');
  const start = await walletUsd();
  const order = await purchase(100);
  await pay(order, 100);
  await orderCost(order, 80);
  // The supplier gave 30$ back; all of it to the customer's wallet
  await tx(async (session) => createCustomerRefund({ orderId: String(order._id), accountId: String((await account('110101'))._id), amount: 30, walletUsd: 30, day: today() }, { session, req: { user: owner } }));
  await expectConsistent('refund');
  expect(await walletUsd()).toBeCloseTo(start - 100 + 30, 2);
  await call(orders.cancelOrder, { ...as(owner), params: { id: String(order._id) }, body: { cancelationReason: 'test' } });
  await expectConsistent('cancelled after the refund');
  // 100 back, the 30 of the refund taken off: in all the customer has what they had
  expect(await walletUsd()).toBeCloseTo(start, 2);
  expect(await usd('121000', { arKey: `PUR:${order._id}` })).toBe(0);
});

test('11. a supplier refund on an order with no cost recorded is flagged; on a transfer order its negative cost moves with it', async () => {
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  const { CHECKS } = require('../services/reports/exceptions');
  const { emitAccountingEvent } = require('../services/events');
  await deposit(100, 'USD');
  const order = await purchase(60);
  await pay(order, 60);
  await tx(async (session) => createCustomerRefund({ orderId: String(order._id), accountId: String((await account('110101'))._id), amount: 40, walletUsd: 40, day: today() }, { session, req: { user: owner } }));
  await expectConsistent('refund with no cost');
  expect((await CHECKS.negativeOrderCost()).items.map((i) => i.label)).toContain(order.orderId);
  const byOrder = { orderId: new mongoose.Types.ObjectId(String(order._id)) };
  expect(await usd('510400', byOrder)).toBe(-4000);
  // Marked a transfer afterwards: the negative cost goes to the transfer cost with the revenue
  await Order.updateOne({ _id: order._id }, { $set: { isRemittance: true } });
  await emitAccountingEvent('order', order._id, {});
  await expectConsistent('marked a transfer');
  expect(await usd('510400', byOrder)).toBe(0);
  expect(await usd('510700', byOrder)).toBe(-4000);
  expect(-(await usd('410700', byOrder))).toBe(2000);
});

test('12. a refund cannot give the wallet more than was paid; transfer orders show their revenue on the order screens', async () => {
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  const { orderSummary } = require('../services/reports/summaries');
  const { customerInvoices } = require('../services/reports/customers');
  await deposit(100, 'USD');
  const order = await purchase(70);
  await pay(order, 70);
  await orderCost(order, 50);
  const refund = (walletUsd) => tx(async (session) => createCustomerRefund({ orderId: String(order._id), accountId: String((await account('110101'))._id), amount: walletUsd, walletUsd, day: today() }, { session, req: { user: owner } }));
  await refund(43);
  await expect(refund(30)).rejects.toThrow('أقصى ما يُضاف لمحفظته الآن 27$');
  await refund(27);
  await expectConsistent('refunded up to what was paid');
  // Marked an Alipay transfer: the order screens read the transfer accounts too
  await Order.updateOne({ _id: order._id }, { $set: { isRemittance: true } });
  await require('../services/events').emitAccountingEvent('order', order._id, {});
  await deposit(50, 'USD');
  const other = await purchase(40);
  await Order.updateOne({ _id: other._id }, { $set: { isRemittance: true } });
  await pay(other, 40);
  await expectConsistent('transfer paid');
  expect((await orderSummary(String(other._id))).totals).toMatchObject({ billed: 4000, recognized: 4000, open: 0 });
  const row = (await customerInvoices({ search: other.orderId })).results.find((r) => r.orderNumber === other.orderId);
  expect(row).toMatchObject({ billed: 4000, recognized: 4000, status: 'paid' });
});

test('12a. concurrent supplier refunds cannot give the customer more than the paid invoice amount', async () => {
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  await deposit(100, 'USD');
  const order = await purchase(70);
  await pay(order, 70);
  await expectConsistent('refund concurrency setup');
  const before = Number((await mongoose.connection.collection('wallets').findOne({ user: customer._id, currency: 'USD' }))?.balance || 0);
  const refund = () => tx(async (session) => createCustomerRefund({
    orderId: String(order._id), accountId: String((await account('110101'))._id), amount: 60, walletUsd: 60, day: today(),
  }, { session, req: { user: owner } }));
  const outcomes = await Promise.allSettled([refund(), refund()]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(Number((await mongoose.connection.collection('wallets').findOne({ user: customer._id, currency: 'USD' })).balance)).toBeCloseTo(before + 60, 2);
  await expectConsistent('concurrent supplier refunds');
});

test('13. an old dinar payment saved without a rate: the accountant writes the rate, the line is posted again, the migration overpayment undone', async () => {
  const { setPaymentRate } = require('../services/paymentRate');
  const operations = require('../services/posting/operations');
  const { postEntry } = require('../services/ledger');
  const OrderPaymentHistory = require('../../models/orderPaymentHistory');
  // The dinars were worth 8.23 a dollar that day, as the migration valued them
  await CurrencyRate.create([{ currency: 'LYD', day: today(), rate: 8.23 }]);
  await deposit(880, 'LYD', { rate: 8.23 });
  await expectConsistent('dinars at 8.23');
  const order = await purchase(96);
  // As old screens saved it: a wallet line and a payment, no rate, not linked
  const createdAt = new Date();
  const statement = await UserStatement.create({ user: customer._id, createdBy: owner._id, calculationType: '-', paymentType: 'wallet', actionType: 'wallet', amount: 880, currency: 'LYD', total: 0, description: 'تم خصم 880LYD من المحفظة', note: `Order Id (${order.orderId}) => سداد فاتورة`, createdAt });
  await mongoose.connection.collection('wallets').updateOne({ user: customer._id, currency: 'LYD' }, { $inc: { balance: -880 } });
  const payment = await OrderPaymentHistory.create({ order: order._id, customer: customer._id, createdBy: owner._id, paymentType: 'wallet', receivedAmount: 880, currency: 'LYD', rate: 0, category: 'invoice', createdAt });
  // Posted as the historical replay did
  await tx((session) => operations.postStatement(statement._id, { session, isHistorical: true, target: { orderId: order._id, category: 'invoice' } }));
  await tx((session) => require('../services/claims/sync').syncOrder(order._id, { session }));
  // What the migration did with it: the dinars at the wallet's average paid 106.93$, the 10.93$ over called other revenue
  const key = `PUR:${order._id}`;
  const open = await usd('121000', { arKey: key });
  expect(open).toBeLessThan(0);
  await tx(async (session) => postEntry({
    eventType: 'MIGRATION_ADJUST', eventKey: `OVERPAID:MIG-TEST:${key}:${customer._id}`, date: today(), description: 'دفع زائد', isHistorical: true,
    lines: [{ accountId: (await account('121000'))._id, debit: -open, partnerId: customer._id, orderId: order._id, arKey: key }, { accountId: (await account('410600'))._id, credit: -open, office: 'tripoli' }],
  }, { session }));
  // A clerk may not; the accountant may
  const clerk = { _id: new mongoose.Types.ObjectId(), roles: { isEmployee: true } };
  await expect(setPaymentRate(String(payment._id), 9.1667, clerk)).rejects.toMatchObject({ statusCode: 403 });
  const accountant = { _id: new mongoose.Types.ObjectId(), roles: { isAccountant: true } };
  await setPaymentRate(String(payment._id), 880 / 96, accountant);
  await expectConsistent('rate written');
  expect((await OrderPaymentHistory.findById(payment._id).lean()).rate).toBeCloseTo(9.166667, 5);
  expect((await UserStatement.findById(statement._id).lean()).rate).toBeCloseTo(9.166667, 5);
  // Paid exactly; nothing left as other revenue; the gap is an exchange difference
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect(await usd('410600', { arKey: key })).toBe(0);
  expect(await JournalEntry.countDocuments({ eventKey: `OVERPAID:MIG-TEST:${key}:${customer._id}`, status: 'reversed' })).toBe(1);
  // The revenue never left its month: no recognition was taken back and given again
  expect(await JournalEntry.countDocuments({ eventType: 'RECOGNITION', 'lines.arKey': key })).toBe(1);
  // Corrected to 9: the 1.78$ the dinars pay beyond the invoice is exchange profit too (decision 119)
  await setPaymentRate(String(payment._id), 9, accountant);
  await expectConsistent('rate 9');
  expect(await usd('121000', { arKey: key })).toBe(0);
  await setPaymentRate(String(payment._id), 880 / 96, accountant);
  await expectConsistent('rate corrected');
  expect(await usd('121000', { arKey: key })).toBe(0);
  expect(await JournalEntry.countDocuments({ eventType: 'RECOGNITION', 'lines.arKey': key })).toBe(1);
  // A rate the payment was made with is not changed here
  const made = await OrderPaymentHistory.create({ order: order._id, customer: customer._id, createdBy: owner._id, paymentType: 'wallet', receivedAmount: 10, currency: 'LYD', rate: 9.5, category: 'invoice' });
  await expect(setPaymentRate(String(made._id), 9, accountant)).rejects.toThrow('للدفعة سعر مسجل');
  await OrderPaymentHistory.deleteOne({ _id: made._id });
});


test('14. any payment beyond the invoice is profit: dinars as exchange profit, dollars as other revenue', async () => {
  const fx = () => usd('710100');
  await deposit(2000, 'LYD');
  await deposit(200, 'USD');
  // 100$ invoice paid with 1,100 LYD at 10.5: they count 104.76$, the 4.76$ over is profit
  const order = await purchase(100);
  const before = await fx();
  await pay(order, 1100, 'LYD', 10.5);
  await expectConsistent('dinars over the invoice');
  expect(await usd('121000', { arKey: 'PUR:' + order._id })).toBe(0);
  expect(before - (await fx())).toBeGreaterThanOrEqual(476);
  // Dinars on an invoice already paid: all of it is profit too
  await pay(order, 105, 'LYD', 10.5);
  await expectConsistent('dinars on a paid invoice');
  expect(await usd('121000', { arKey: 'PUR:' + order._id })).toBe(0);
  // Dollars over the invoice: other revenue, labelled
  const other = await purchase(50);
  const otherRevenue = await usd('410600');
  await pay(other, 60, 'USD');
  await expectConsistent('dollars over the invoice');
  expect(await usd('121000', { arKey: 'PUR:' + other._id })).toBe(0);
  expect(otherRevenue - (await usd('410600'))).toBe(1000);
  // Above 5$ in dollars it is also listed for the accountant to confirm; 3$ is not
  const small = await purchase(20);
  await pay(small, 23, 'USD');
  await expectConsistent('3$ over');
  const { CHECKS } = require('../services/reports/exceptions');
  const listed = (await CHECKS.overpaidProfit()).items.map((item) => item.label);
  expect(listed.some((label) => label.startsWith(other.orderId))).toBe(true);
  expect(listed.some((label) => label.startsWith(small.orderId))).toBe(false);
  expect(listed.some((label) => label.startsWith(order.orderId))).toBe(false);
});

test('15. "received" is never ticked by hand: creating or editing an order keeps it, only delivery sets it', async () => {
  const order = (await call(orders.createOrder, {
    ...as(owner),
    body: {
      customerId: 'C100', fullName: 'X', fromWhere: 'china', toWhere: 'tripoli', method: 'air', isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
      paymentList: JSON.stringify([{ arrived: true, arrivedLibya: true, received: true, deliveredPackages: { weight: 2, measureUnit: 'KG', exiosPrice: 10, trackingNumber: `RCV${Date.now()}`, shipmentMethod: 'air' } }]),
    },
  })).body;
  let full = await Order.findById(order._id).lean();
  expect(full.paymentList[0].status.received).toBe(false);
  // Ticked in the order form: ignored
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: full.paymentList.map((p) => ({ ...p, status: { ...p.status, received: true } })) } });
  full = await Order.findById(order._id).lean();
  expect(full.paymentList[0].status.received).toBe(false);
  // Delivered with its payment: received, and an edit cannot untick it
  await deposit(20, 'USD');
  await call(orders.markPackagesAsDelivered, { ...as(owner), params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(full.paymentList[0]._id), orderId: full.orderId }], payment: { amountUSD: 20 } } });
  full = await Order.findById(order._id).lean();
  expect(full.paymentList[0].status.received).toBe(true);
  await call(orders.updateOrder, { ...as(owner), params: { id: String(order._id) }, body: { paymentList: full.paymentList.map((p) => ({ ...p, status: { ...p.status, received: false } })) } });
  expect((await Order.findById(order._id).lean()).paymentList[0].status.received).toBe(true);
  await expectConsistent('delivered');
});

test('16. custody and loans apart, each in its own currency: given, spent by the employee, returned, a loan taken from the salary, no exchange difference', async () => {
  const { createTransfer } = require('../services/posting/treasury');
  const { createSalary } = require('../services/posting/people');
  const staff = require('../services/staffOperations');
  const custody = require('../services/custody');
  const clerkId = (await users().insertOne({ username: 'clerk-c', firstName: 'Clerk', lastName: 'C', phone: 910000077, customerId: 'STF7', office: 'tripoli', roles: { isEmployee: true } })).insertedId;
  const clerk = await users().findOne({ _id: clerkId });
  const box = await account('110101');
  const dinarBox = await account('110102');
  const custodyUsd = await account('140100');
  const custodyLyd = await account('140110');
  const loanUsd = await account('140300');
  const loanLyd = await account('140310');
  const move = (from, to, amount) => tx((session) => createTransfer({ day: today(), employeeId: String(clerkId), fromAccountId: from._id, toAccountId: to._id, fromAmount: amount, toAmount: amount }, { session, req: { user: owner } }));
  // Dinars bought at 9.5, whatever the day's rate is
  await tx((session) => createTransfer({ day: today(), fromAccountId: box._id, toAccountId: dinarBox._id, fromAmount: 200, toAmount: 1900 }, { session, req: { user: owner } }));
  const fxBefore = await usd('710100');

  // 300$ and 950 LYD custody, a 100$ and a 475 LYD loan
  await move(box, custodyUsd, 300);
  await move(dinarBox, custodyLyd, 950);
  await move(box, loanUsd, 100);
  await move(dinarBox, loanLyd, 475);
  // Dinars into the dollar custody, or a fee: refused
  await expect(move(dinarBox, custodyUsd, 100)).rejects.toThrow('بنفس عملتها');
  expect((await staff.officeExpenseOptions(clerk)).custody).toEqual({ USD: 300, LYD: 950 });

  // The employee pays from custody: 50$ and 190 LYD, each from its own custody
  const type = await docs.ExpenseType.findOne({ isActive: true }).lean();
  await staff.createOfficeExpense({ expenseTypeId: String(type._id), amount: 50, currency: 'USD', payFrom: 'custody', note: 'وقود' }, [], { user: clerk });
  const dinarExpense = await staff.createOfficeExpense({ expenseTypeId: String(type._id), amount: 190, currency: 'LYD', payFrom: 'custody', note: 'ضيافة' }, [], { user: clerk });
  // valued at what the dinar custody cost (9.5), not the day's rate
  expect(dinarExpense.totalUsd).toBe(2000);
  await expectConsistent('custody spent');
  const mine = await custody.mine(clerk);
  expect(mine.custody.balance).toEqual({ USD: 250, LYD: 760 });
  expect(mine.custody.movements.filter((m) => m.kind === 'spent')).toHaveLength(2);
  expect(mine.custody.movements.some((m) => m.kind === 'given' && m.currency === 'LYD' && m.amount === 950)).toBe(true);
  expect(mine.loan.balance).toEqual({ USD: 100, LYD: 475 });
  // More than the custody holds, or a currency with no custody: refused
  await expect(staff.createOfficeExpense({ expenseTypeId: String(type._id), amount: 1000, currency: 'LYD', payFrom: 'custody' }, [], { user: clerk })).rejects.toThrow('لا تكفي');
  await expect(move(custodyLyd, dinarBox, 800)).rejects.toThrow('أكبر مما على الموظف');

  // The rest of the dinar custody comes back in dinars: zero in dinars and in dollars
  await move(custodyLyd, dinarBox, 760);
  // Loans come back from salaries in their own currency; custody is not touched by them
  await tx((session) => createSalary({ employeeId: String(clerkId), month: today().slice(0, 7), day: today(), office: 'tripoli', paidFromAccountId: box._id, grossAmount: 500, advanceDeduction: 100 }, { session, req: { user: owner } }));
  await expect(tx((session) => createSalary({ employeeId: String(clerkId), month: today().slice(0, 7), day: today(), office: 'tripoli', paidFromAccountId: dinarBox._id, grossAmount: 3000, advanceDeduction: 500 }, { session, req: { user: owner } }))).rejects.toThrow('الخصم أكبر');
  await tx((session) => createSalary({ employeeId: String(clerkId), month: today().slice(0, 7), day: today(), office: 'tripoli', paidFromAccountId: dinarBox._id, grossAmount: 475, advanceDeduction: 475, rate: 9.5 }, { session, req: { user: owner } }));
  const after = await custody.mine(clerk);
  expect(after.loan.balance).toEqual({ USD: 0, LYD: 0 });
  expect(after.custody.balance).toEqual({ USD: 250, LYD: 0 });
  expect(await usd('140110')).toBe(0);
  expect(await usd('140310')).toBe(0);
  // Given, spent and settled in dinars: not a cent of exchange difference
  expect(await usd('710100')).toBe(fxBefore);

  // The overview for the accountant and the admin, not for the employee
  const overview = await custody.summary({ _id: owner._id, roles: { isAccountant: true } });
  expect(overview.results.find((r) => String(r._id) === String(clerkId))).toMatchObject({ custody: { USD: 250, LYD: 0 }, loan: { USD: 0, LYD: 0 } });
  await expect(custody.summary(clerk)).rejects.toMatchObject({ statusCode: 403 });
  await expectConsistent('custody and loan');
});

test('17. supplier bills say paid, partly paid or unpaid, and can be filtered by it', async () => {
  const documents = require('../controllers/documents');
  const payables = require('../services/posting/payables');
  const vendor = await docs.Vendor.create({ name: 'مورد الحالة', type: 'supplier' });
  const rent = await account('530200');
  const bill = (amount, paid) => tx(async (session) => payables.createBill({
    vendorId: vendor._id, day: today(), currency: 'USD', ...(paid && { paidImmediatelyFrom: (await account('110101'))._id }),
    lines: [{ description: 'x', amount, target: 'expense', accountId: rent._id, office: 'tripoli' }],
  }, { session, req: { user: owner } }));
  const paid = await bill(40, true);
  const unpaid = await bill(60, false);
  const partial = await bill(80, false);
  const box = await account('110101');
  await tx((session) => payables.createPayment({ vendorId: vendor._id, day: today(), fromAccountId: box._id, amount: 30, allocations: [{ billId: partial._id, amountUsd: 3000 }] }, { session, req: { user: owner } }));
  const list = async (query) => (await call(documents.listBills, { ...as(owner), query: { vendorId: String(vendor._id), ...query } })).body.results;
  const all = await list({});
  const statusOf = (doc) => all.find((b) => String(b._id) === String(doc._id))?.paymentStatus;
  expect(statusOf(paid)).toBe('paid');
  expect(statusOf(unpaid)).toBe('unpaid');
  expect(statusOf(partial)).toBe('partial');
  expect(all.find((b) => String(b._id) === String(partial._id)).open).toBe(5000);
  expect((await list({ payment: 'unpaid' })).map((b) => String(b._id))).toEqual([String(unpaid._id)]);
  expect((await list({ payment: 'paid' })).map((b) => String(b._id))).toEqual([String(paid._id)]);
});

test('18. a bill in Kuwaiti dinars paid from the lira bank: the cost becomes what was really paid', async () => {
  const payables = require('../services/posting/payables');
  const { cancelDocument } = require('../services/cancel');
  await CurrencyRate.create([{ currency: 'KWD', day: today(), rate: 0.31 }, { currency: 'TRY', day: today(), rate: 49.9 }]);
  const lira = await account('110204');
  // Lira in the bank at 49.88
  const dollars = await account('110101');
  await tx((session) => require('../services/posting/treasury').createTransfer({ day: today(), fromAccountId: dollars._id, toAccountId: lira._id, fromAmount: 400, toAmount: 19952 }, { session, req: { user: owner } }));
  const order = await purchase(586);
  const vendor = await docs.Vendor.create({ name: 'موقع كويتي', type: 'supplier' });
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: today(), currency: 'KWD', lines: [{ description: 'موقع كويتي', amount: 93, target: 'order', orderId: order._id }],
  }, { session, req: { user: owner } }));
  expect(bill.totalUsd).toBe(30000);
  const fxBefore = await usd('710100');
  const payment = await tx((session) => payables.createPayment({
    vendorId: vendor._id, day: today(), fromAccountId: lira._id, amount: 15021.36, rate: 49.88, differenceTo: 'cost', allocations: [{ billId: bill._id, amountUsd: 30000 }],
  }, { session, req: { user: owner } }));
  // 15,021.36 / 49.88 = 301.15$: the bill is closed, nothing left as an advance, the order costs 301.15
  expect(payment.costDifferenceUsd).toBe(115);
  expect(payment.advanceUsd).toBe(0);
  expect(await usd('130200', { orderId: order._id })).toBe(30115);
  expect(await usd('210200', { apKey: `BILL:${bill._id}` })).toBe(0);
  // The bank's lira were bought at the same rate: no exchange difference
  expect(await usd('710100')).toBe(fxBefore);
  await expectConsistent('paid in lira');
  // Cancelled: the cost goes back to the bill's 300$
  await tx((session) => cancelDocument('AccountingSupplierPayment', payment._id, { session, req: { user: owner }, reason: 'اختبار' }));
  expect(await usd('130200', { orderId: order._id })).toBe(30000);
  await expectConsistent('payment cancelled');
});

test('19. the same on an order already sold and paid: the difference reaches cost of sales, and its cancellation takes it back', async () => {
  const payables = require('../services/posting/payables');
  const { cancelDocument } = require('../services/cancel');
  for (const [currency, rate] of [['KWD', 0.31], ['TRY', 49.9]]) await CurrencyRate.updateOne({ currency, day: today() }, { $set: { rate } }, { upsert: true });
  const lira = await account('110204');
  const dollars = await account('110101');
  await tx((session) => require('../services/posting/treasury').createTransfer({ day: today(), fromAccountId: dollars._id, toAccountId: lira._id, fromAmount: 400, toAmount: 19952 }, { session, req: { user: owner } }));
  const order = await purchase(586);
  const vendor = await docs.Vendor.create({ name: 'موقع كويتي 2', type: 'supplier' });
  const bill = await tx((session) => payables.createBill({
    vendorId: vendor._id, day: today(), currency: 'KWD', lines: [{ description: 'موقع كويتي', amount: 93, target: 'order', orderId: order._id }],
  }, { session, req: { user: owner } }));
  // The customer pays the whole invoice: sale and cost recognised
  await deposit(586, 'USD');
  await pay(order, 586);
  await processQueue();
  expect(await usd('510400', { orderId: order._id })).toBe(30000);
  const recognisedBefore = await usd('410300', { orderId: order._id });

  const payment = await tx((session) => payables.createPayment({
    vendorId: vendor._id, day: today(), fromAccountId: lira._id, amount: 15021.36, rate: 49.88, differenceTo: 'cost', allocations: [{ billId: bill._id, amountUsd: 30000 }],
  }, { session, req: { user: owner } }));
  expect(payment.costDifferenceUsd).toBe(115);
  expect(await usd('510400', { orderId: order._id })).toBe(30115);
  expect(await usd('130200', { orderId: order._id })).toBe(0);
  await expectConsistent('paid after the sale');

  await tx((session) => cancelDocument('AccountingSupplierPayment', payment._id, { session, req: { user: owner }, reason: 'اختبار' }));
  // Back to the bill's 300$, nothing left in progress, the bill open again, the sale untouched
  expect(await usd('510400', { orderId: order._id })).toBe(30000);
  expect(await usd('130200', { orderId: order._id })).toBe(0);
  expect(await usd('210200', { apKey: `BILL:${bill._id}` })).toBe(-30000);
  expect(await usd('410300', { orderId: order._id })).toBe(recognisedBefore);
  await expectConsistent('cancelled after the sale');

  // Paid again the same way: 301.15 once more
  await tx((session) => payables.createPayment({
    vendorId: vendor._id, day: today(), fromAccountId: lira._id, amount: 15021.36, rate: 49.88, differenceTo: 'cost', allocations: [{ billId: bill._id, amountUsd: 30000 }],
  }, { session, req: { user: owner } }));
  expect(await usd('510400', { orderId: order._id })).toBe(30115);
  await expectConsistent('paid again');
});
