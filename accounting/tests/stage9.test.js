jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { OWNER_ID, call, expectConsistent } = require('./e2eKit');
const { AccountingSettings, AccountingEvent, JournalEntry, AuditLog } = require('../models');
const { invalidateConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { cancelDocument } = require('../services/cancel');
const { closeMonth, closeYear } = require('../services/closing');
const { lockPeriod } = require('../services/periodLock');
const { postEntry } = require('../services/ledger');
const { emitAccountingEvent } = require('../services/events');
const docs = require('../models/documents');
const payables = require('../services/posting/payables');
const treasury = require('../services/posting/treasury');
const people = require('../services/posting/people');
const alipay = require('../services/posting/alipay');
const orders = require('../../controllers/orders');
const wallet = require('../../controllers/wallet');
const inventory = require('../../controllers/inventory');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Wallet = require('../../models/wallet');
const Payment = require('../../models/orderPaymentHistory');
const Statement = require('../../models/userStatement');
const { setPaymentRate } = require('../services/paymentRate');
const Activity = require('../../models/activities');

jest.setTimeout(120000);
let owner, customer;
const day = '2026-03-01';
const req = () => ({ user: owner });
const invoke = (handler, input = {}) => call(handler, { user: owner, ...input });
let baseline;
beforeAll(async () => {
  await startDb();
  await resetDb();
  baseline = [];
  for (const collection of await mongoose.connection.db.collections()) {
    const rows = await collection.find({}).toArray();
    if (rows.length) baseline.push({ name: collection.collectionName, rows });
  }
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb({ setup: false });
  for (const { name, rows } of baseline) await mongoose.connection.collection(name).insertMany(rows.map(row => ({ ...row })));
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
  invalidateConfig();
  owner = { _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'owner', phone: 910900001, customerId: 'OWN', firstName: 'Owner', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } };
  customer = { _id: oid(), username: 'customer', phone: 910900002, customerId: 'C900', firstName: 'Customer', roles: { isClient: true } };
  await mongoose.connection.collection('users').insertMany([owner, customer]);
});
afterEach(() => jest.restoreAllMocks());

const purchase = async () => (await invoke(orders.createOrder, { body: {
  customerId: customer.customerId, fullName: 'Test', fromWhere: 'china', toWhere: 'tripoli', method: 'air',
  isPayment: 'true', isShipment: 'false', placedAt: 'tripoli', items: JSON.stringify([{ description: 'Goods', unitPrice: 100, quantity: 1 }]), paymentList: '[]',
} })).body;
const shipment = async () => (await invoke(orders.createOrder, { body: {
  customerId: customer.customerId, fullName: 'Test', fromWhere: 'china', toWhere: 'tripoli', method: 'air',
  isPayment: 'false', isShipment: 'true', placedAt: 'tripoli', items: '[]',
  paymentList: JSON.stringify([{ arrived: true, arrivedLibya: true, received: false, deliveredPackages: { weight: 2, measureUnit: 'KG', exiosPrice: 10, trackingNumber: `T${oid()}`, shipmentMethod: 'air' } }]),
} })).body;
const cash = (order, extra = {}) => invoke(orders.addPaymentToOrder, { params: { id: String(order._id) }, body: {
  receivedAmount: 25, currency: 'USD', createdAt: new Date().toISOString(), paymentType: 'cash', customerId: String(customer._id), category: 'invoice', list: [], ...extra,
} });
const cancel = (order) => invoke(orders.cancelOrder, { params: { id: String(order._id) }, body: { cancelationReason: 'Test cancellation' } });
const trip = async () => (await invoke(inventory.createInventory, { body: { voyage: 'Test trip', inventoryType: 'inventoryGoods', inventoryPlace: 'tripoli', shippedCountry: 'CN', shippingType: 'air' } })).body;
const add = (order, query) => invoke(inventory.addOrdersToTheInventory, { query, body: [{ paymentList: { _id: String(order.paymentList[0]._id) } }] });

test.each([
  { receivedAmount: -1 }, { receivedAmount: 0 }, { receivedAmount: 0.001 }, { receivedAmount: 'NaN' },
  { paymentType: 'wallet' }, { customerId: String(oid()) }, { createdAt: 'bad-date' }, { currency: 'LYD', rate: Infinity },
])('direct cash payment rejects invalid input without financial writes: %j', async (extra) => {
  const order = await purchase();
  const count = await AccountingEvent.countDocuments();
  await expect(cash(order, extra)).rejects.toMatchObject({ statusCode: 400 });
  expect(await Payment.countDocuments()).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(count);
});

test('failed cash outbox rolls back the payment and can be retried', async () => {
  const order = await purchase();
  const count = await AccountingEvent.countDocuments();
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(cash(order)).rejects.toMatchObject({ statusCode: 500 });
  expect(await Payment.countDocuments()).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(count);
  jest.restoreAllMocks();
  await cash(order);
  await expectConsistent('cash retry');
});

test('failed order creation leaves neither an order nor an activity', async () => {
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(purchase()).rejects.toMatchObject({ statusCode: 500 });
  expect(await Order.countDocuments()).toBe(0);
  expect(await Activity.countDocuments()).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(0);
});

test('order deletion rolls back if its audit activity cannot be saved', async () => {
  const order = await purchase();
  jest.spyOn(Activity, 'create').mockRejectedValue(new Error('activity unavailable'));
  await expect(invoke(orders.deleteOrder, { params: { id: String(order._id) } })).rejects.toThrow('activity unavailable');
  expect(await Order.findById(order._id)).not.toBeNull();
});

test('payment and deletion cannot both commit against the same order', async () => {
  const order = await purchase();
  const results = await Promise.allSettled([cash(order), invoke(orders.deleteOrder, { params: { id: String(order._id) } })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  if (await Payment.exists({ order: order._id })) expect(await Order.findById(order._id)).not.toBeNull();
  else expect(await Order.findById(order._id)).toBeNull();
});

test('a supplier bill and order deletion cannot create an orphan cost', async () => {
  const order = await purchase();
  const vendor = await docs.Vendor.create({ name: 'Supplier' });
  const results = await Promise.allSettled([
    runInTransaction(session => payables.createBill({ vendorId: vendor._id, day, currency: 'USD', lines: [{ description: 'Goods', amount: 10, target: 'order', orderId: order._id }] }, { session, req: req() })),
    invoke(orders.deleteOrder, { params: { id: String(order._id) } }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  if (await docs.SupplierBill.exists({ 'lines.orderId': order._id })) expect(await Order.findById(order._id)).not.toBeNull();
  else expect(await Order.findById(order._id)).toBeNull();
});

test('cancellation failure rolls back the refund, payment deletion and order status', async () => {
  const order = await purchase();
  await cash(order);
  await expectConsistent('cash before cancel');
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(cancel(order)).rejects.toMatchObject({ statusCode: 500 });
  expect((await Order.findById(order._id)).isCanceled).toBe(false);
  expect(await Payment.countDocuments({ order: order._id })).toBe(1);
  expect(await Wallet.countDocuments({ user: customer._id })).toBe(0);
  expect(await Statement.countDocuments({ user: customer._id })).toBe(0);
  jest.restoreAllMocks();
  await cancel(order);
  await expectConsistent('cancellation retry');
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(25);
});

test('two simultaneous cancellations refund the payment once', async () => {
  const order = await purchase();
  await cash(order);
  await Promise.all([cancel(order), cancel(order)]);
  expect(await Wallet.countDocuments({ user: customer._id, currency: 'USD' })).toBe(1);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(25);
  expect(await Payment.countDocuments({ order: order._id })).toBe(0);
  expect(await Statement.countDocuments({ user: customer._id, calculationType: '+' })).toBe(1);
  await expectConsistent('concurrent cancellation');
});

test('an unsupported euro wallet refund refuses cancellation before changing any payment', async () => {
  const order = await purchase();
  await cash(order, { currency: 'EURO', receivedAmount: 45, rate: 0.9 });
  const count = await AccountingEvent.countDocuments();
  await expect(cancel(order)).rejects.toMatchObject({ statusCode: 400 });
  expect((await Order.findById(order._id)).isCanceled).toBe(false);
  expect(await Payment.countDocuments({ order: order._id })).toBe(1);
  expect(await Wallet.countDocuments({ user: customer._id })).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(count);
});

test('refunds on two different orders create one first wallet and keep both running totals', async () => {
  const a = await purchase(), b = await purchase();
  await cash(a); await cash(b);
  await Promise.all([cancel(a), cancel(b)]);
  expect(await Wallet.countDocuments({ user: customer._id, currency: 'USD' })).toBe(1);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(50);
  const lines = await Statement.find({ user: customer._id }).sort({ createdAt: 1, _id: 1 });
  expect(lines.map(s => s.total)).toEqual([25, 50]);
  await expectConsistent('two first-wallet refunds');
});

test('an invoice change and its history roll back if posting cannot be queued', async () => {
  const order = await purchase();
  await Order.updateOne({ _id: order._id }, { $set: { requestedEditDetails: { items: [{ description: 'Changed', unitPrice: 150, quantity: 1 }] } } });
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(invoke(orders.confirmItemsChanges, { params: { id: String(order._id) }, body: { status: 'accepted' } })).rejects.toMatchObject({ statusCode: 500 });
  const saved = await Order.findById(order._id);
  expect(saved.totalInvoice).toBe(100);
  expect(saved.requestedEditDetails.items[0].unitPrice).toBe(150);
  expect(saved.editedAmounts).toHaveLength(0);
});

test('simultaneous invoice approvals accept the saved proposal once and ignore client tampering', async () => {
  const order = await purchase();
  await Order.updateOne({ _id: order._id }, { $set: { requestedEditDetails: { items: [{ description: 'Changed', unitPrice: 150, quantity: 1 }] } } });
  const input = { params: { id: String(order._id) }, body: { status: 'accepted', requestedEditDetails: { items: [{ unitPrice: 1, quantity: 1 }] } } };
  const result = await Promise.allSettled([invoke(orders.confirmItemsChanges, input), invoke(orders.confirmItemsChanges, input)]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await Order.findById(order._id)).totalInvoice).toBe(150);
  expect((await Order.findById(order._id)).editedAmounts).toHaveLength(1);
  await expectConsistent('single approval of saved invoice');
});

test('order and package edits roll back when their outbox write fails', async () => {
  const order = await shipment();
  const saved = await Order.findById(order._id).lean();
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(invoke(orders.updateOrder, { params: { id: String(order._id) }, body: { paymentList: [{ ...saved.paymentList[0], deliveredPackages: { ...saved.paymentList[0].deliveredPackages, exiosPrice: 20 } }] } })).rejects.toMatchObject({ statusCode: 500 });
  expect((await Order.findById(order._id).lean()).paymentList).toEqual(saved.paymentList);
});

test('bulk arrival cannot mark packages delivered without a delivery operation', async () => {
  const order = await shipment();
  await expect(invoke(orders.updateStatusOfOrder, { body: { statusType: 'received', value: true, data: [{ orderId: order.orderId }] } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Order.findById(order._id)).paymentList[0].status.received).toBe(false);
  expect(await Payment.countDocuments()).toBe(0);
});

test('different orders delivered simultaneously from the same wallet both succeed when funded', async () => {
  const a = await shipment(), b = await shipment();
  await invoke(wallet.addBalanceToWallet, { params: { id: String(customer._id) }, body: { amount: 50, currency: 'USD', actionType: 'cash', office: 'tripoli', createdAt: new Date().toISOString(), description: 'Funding', note: 'Test' } });
  const deliver = order => invoke(orders.markPackagesAsDelivered, { params: { id: String(customer._id) }, body: { selectedPackages: [{ id: String(order.paymentList[0]._id), orderId: order.orderId }], payment: { amountUSD: 20, amountLYD: 0, rate: 0 } } });
  await Promise.all([deliver(a), deliver(b)]);
  expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(10);
  expect(await Payment.countDocuments({ customer: customer._id })).toBe(2);
  expect((await Order.findById(a._id)).paymentList[0].status.received).toBe(true);
  expect((await Order.findById(b._id)).paymentList[0].status.received).toBe(true);
  await expectConsistent('simultaneous different-order deliveries');
});

test.each([{ isCanceled: true }, { isDeleted: true }, { user: String(oid()) }, { totalInvoice: 1 }, { receivedUSD: 100 }, { $set: { isCanceled: true } }])('the general order editor refuses financial state bypass: %j', async body => {
  const order = await purchase();
  await expect(invoke(orders.updateOrder, { params: { id: String(order._id) }, body })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Order.findById(order._id)).totalInvoice).toBe(100);
  expect((await Order.findById(order._id)).isCanceled).toBe(false);
  expect(await Payment.countDocuments()).toBe(0);
});

test('the server calculates the editable invoice total from its items', async () => {
  const order = await purchase();
  await invoke(orders.updateOrder, { params: { id: String(order._id) }, body: { items: [{ description: 'Goods', unitPrice: 12.5, quantity: 3 }], totalInvoice: 1 } });
  expect((await Order.findById(order._id)).totalInvoice).toBe(37.5);
  await expectConsistent('server invoice total');
});

test('confirmed invoice items cannot bypass the approval route through the general editor', async () => {
  const order = await purchase();
  await Order.updateOne({ _id: order._id }, { $set: { invoiceConfirmed: true } });
  await expect(invoke(orders.updateOrder, { params: { id: String(order._id) }, body: { items: [{ description: 'Goods', unitPrice: 1, quantity: 1 }], totalInvoice: 1 } })).rejects.toMatchObject({ statusCode: 400 });
  expect((await Order.findById(order._id)).totalInvoice).toBe(100);
});

test('parallel additions of the same package keep one trip member', async () => {
  const order = await shipment(), target = await trip();
  await Promise.all([add(order, { id: String(target._id) }), add(order, { id: String(target._id) })]);
  expect((await Inventory.findById(target._id)).orders).toHaveLength(1);
  await expectConsistent('trip package deduplication');
});

test('parallel first warehouse creation uses one warehouse', async () => {
  const a = await shipment(), b = await shipment();
  await Promise.all([add(a, { office: 'tripoli' }), add(b, { office: 'tripoli' })]);
  expect(await Inventory.countDocuments({ inventoryType: 'warehouseInventory', inventoryPlace: 'tripoli' })).toBe(1);
  expect((await Inventory.findOne({ inventoryType: 'warehouseInventory' })).orders).toHaveLength(2);
});

test('failed trip membership and update events leave both the trip and order links unchanged', async () => {
  const order = await shipment(), target = await trip();
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(add(order, { id: String(target._id) })).rejects.toMatchObject({ statusCode: 500 });
  expect((await Inventory.findById(target._id)).orders).toHaveLength(0);
  await expect(invoke(inventory.updateInventory, { query: { id: String(target._id) }, body: { voyage: 'Wrong change' } })).rejects.toMatchObject({ statusCode: 500 });
  expect((await Inventory.findById(target._id)).voyage).toBe('Test trip');
  jest.restoreAllMocks();
  await add(order, { id: String(target._id) });
  const saved = await Order.findById(order._id).lean();
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(invoke(inventory.removeOrdersFromInventory, { query: { id: String(target._id) }, body: [String(order.paymentList[0]._id)] })).rejects.toMatchObject({ statusCode: 500 });
  expect((await Inventory.findById(target._id)).orders).toHaveLength(1);
  expect((await Order.findById(order._id).lean()).paymentList).toEqual(saved.paymentList);
});

test('competing internal shipments move the package once and reject the stale move', async () => {
  const order = await shipment();
  await add(order, { office: 'tripoli' });
  const input = { params: { office: 'tripoli' }, body: { paymentListIds: [String(order.paymentList[0]._id)], voyage: 'Domestic', destination: 'benghazi' } };
  const results = await Promise.allSettled([invoke(inventory.createInternalShipping, input), invoke(inventory.createInternalShipping, input)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.statusCode).toBe(409);
  expect(await Inventory.countDocuments({ voyage: 'Domestic' })).toBe(1);
  expect((await Inventory.findOne({ inventoryType: 'warehouseInventory' })).orders).toHaveLength(0);
  await expectConsistent('single internal shipment');
});

test('internal shipment failure restores the warehouse and removes the attempted shipment', async () => {
  const order = await shipment();
  await add(order, { office: 'tripoli' });
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(invoke(inventory.createInternalShipping, { params: { office: 'tripoli' }, body: { paymentListIds: [String(order.paymentList[0]._id)], voyage: 'Failed domestic', destination: 'benghazi' } })).rejects.toMatchObject({ statusCode: 500 });
  expect(await Inventory.countDocuments({ voyage: 'Failed domestic' })).toBe(0);
  expect((await Inventory.findOne({ inventoryType: 'warehouseInventory' })).orders).toHaveLength(1);
});

test('a trip bill and trip deletion cannot create an orphan cost', async () => {
  const target = await trip();
  const vendor = await docs.Vendor.create({ name: 'Carrier', type: 'carrier' });
  const results = await Promise.allSettled([
    runInTransaction(session => payables.createBill({ vendorId: vendor._id, day, currency: 'USD', lines: [{ description: 'Freight', amount: 10, target: 'trip', tripId: target._id }] }, { session, req: req() })),
    invoke(inventory.deleteInventory, { params: { id: String(target._id) } }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  if (await docs.SupplierBill.exists({ 'lines.tripId': target._id })) expect(await Inventory.findById(target._id)).not.toBeNull();
  else expect(await Inventory.findById(target._id)).toBeNull();
});

test('trip deletion rolls back when its accounting event fails', async () => {
  const target = await trip();
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(invoke(inventory.deleteInventory, { params: { id: String(target._id) } })).rejects.toMatchObject({ statusCode: 500 });
  expect(await Inventory.findById(target._id)).not.toBeNull();
});

test('payment rate correction rolls back both records when the event fails', async () => {
  const order = await purchase();
  const statementId = oid(), paymentId = oid();
  await Statement.collection.insertOne({ _id: statementId, user: customer._id, currency: 'LYD', amount: 100, calculationType: '-', rate: 0 });
  await Payment.collection.insertOne({ _id: paymentId, order: order._id, customer: customer._id, statementId, createdBy: owner._id, currency: 'LYD', receivedAmount: 100, paymentType: 'wallet', rate: 0, createdAt: new Date() });
  jest.spyOn(AccountingEvent, 'create').mockRejectedValue(new Error('outbox unavailable'));
  await expect(setPaymentRate(String(paymentId), 10, owner)).rejects.toThrow('outbox unavailable');
  expect((await Payment.findById(paymentId)).rate).toBe(0);
  expect((await Statement.findById(statementId)).rate).toBe(0);
});

const cases = [
  ['equity', 'AccountingEquityTransaction', people.createEquity, async () => ({ type: 'capital_in', partyName: 'Partner', day, accountId: (await account('110101'))._id, amount: 100 })],
  ['transfer', 'AccountingTreasuryTransfer', treasury.createTransfer, async () => ({ day, fromAccountId: (await account('110101'))._id, fromAmount: 100, toAccountId: (await account('110201'))._id, toAmount: 100 })],
  ['supplier bill', 'AccountingSupplierBill', payables.createBill, async () => ({ vendorId: (await docs.Vendor.create({ name: 'Supplier' }))._id, day, currency: 'USD', lines: [{ description: 'Expense', amount: 100, target: 'expense', accountId: (await account('530800'))._id, office: 'tripoli' }] })],
  ['supplier payment', 'AccountingSupplierPayment', payables.createPayment, async () => ({ vendorId: (await docs.Vendor.create({ name: 'Supplier' }))._id, day, fromAccountId: (await account('110101'))._id, amount: 100 })],
  ['salary', 'AccountingSalaryPayment', people.createSalary, async () => ({ employeeId: owner._id, month: '2026-03', day, office: 'tripoli', grossAmount: 100, paidFromAccountId: (await account('110101'))._id })],
  ['yuan purchase', 'AccountingYuanPurchase', alipay.createYuanPurchase, async () => ({ vendorId: (await docs.Vendor.create({ name: 'Broker', type: 'service' }))._id, day, fromAccountId: (await account('110101'))._id, amount: 100, toAccountId: (await account('110301'))._id, cnyReceived: 700 })],
];
async function fund() {
  await runInTransaction(async session => people.createEquity({ type: 'capital_in', partyName: 'Opening partner', day: '2026-01-01', accountId: (await account('110101'))._id, amount: 1000 }, { session, req: req() }));
}
test.each(cases)('%s: parallel same-key requests and a lost-response retry return one posted document', async (name, model, create, build) => {
  await fund();
  const input = { ...await build(), idempotencyKey: `stage9:${name}` };
  const submit = () => runInTransaction(session => create(input, { session, req: req() }));
  const results = await Promise.all([submit(), submit()]);
  const retry = await submit();
  expect(String(results[0]._id)).toBe(String(results[1]._id));
  expect(String(retry._id)).toBe(String(results[0]._id));
  expect(await mongoose.model(model).countDocuments({ idempotencyKey: input.idempotencyKey })).toBe(1);
  expect(await JournalEntry.countDocuments({ 'source.model': model, 'source.id': retry._id })).toBe(1);
  await expectConsistent(`${name} idempotency`);
});

test.each(cases)('%s: an audit failure after posting rolls back document, journal and numbering; retry succeeds', async (name, model, create, build) => {
  await fund();
  const input = { ...await build(), idempotencyKey: `stage9:failure:${name}` };
  const before = await JournalEntry.countDocuments();
  jest.spyOn(AuditLog, 'create').mockRejectedValue(new Error('audit unavailable'));
  await expect(runInTransaction(session => create(input, { session, req: req() }))).rejects.toThrow('audit unavailable');
  expect(await mongoose.model(model).countDocuments({ idempotencyKey: input.idempotencyKey })).toBe(0);
  expect(await JournalEntry.countDocuments()).toBe(before);
  jest.restoreAllMocks();
  const saved = await runInTransaction(session => create(input, { session, req: req() }));
  expect(saved.status).toBe('posted');
  expect(await JournalEntry.countDocuments()).toBe(before + 1);
  await expectConsistent(`${name} failed posting retry`);
});

test.each(cases)('%s: simultaneous cancellation creates one reversal', async (name, model, create, build) => {
  await fund();
  const saved = await runInTransaction(async session => create(await build(), { session, req: req() }));
  const results = await Promise.allSettled([1, 2].map(() => runInTransaction(session => cancelDocument(model, saved._id, { session, req: req(), reason: 'Test duplicate cancellation' }))));
  expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  expect((await mongoose.model(model).findById(saved._id)).status).toBe('canceled');
  expect(await JournalEntry.countDocuments({ reversalOf: saved.entryId })).toBe(1);
  await expectConsistent(`${name} cancellation`);
});

test('a cached old lock date cannot authorize a new journal in a newly closed period', async () => {
  await fund();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-03-31' } });
  await expect(runInTransaction(async session => postEntry({ eventType: 'MANUAL', eventKey: 'STALE-CACHE', date: day, lines: [{ accountId: (await account('110101'))._id, debit: 100 }, { accountId: (await account('310000'))._id, credit: 100 }] }, { session, onLocked: 'reject' }))).rejects.toMatchObject({ statusCode: 400 });
  expect(await JournalEntry.countDocuments({ eventKey: 'STALE-CACHE' })).toBe(0);
});

test('competing closes cannot move the lock boundary backwards', async () => {
  const results = await Promise.allSettled(['2025-01', '2025-02'].map(month => runInTransaction(session => closeMonth(month, { session, req: req() }))));
  expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  expect((await AccountingSettings.findOne({ key: 'main' })).lockDate).toBe('2025-02-28');
});

test('an uncommitted outbox operation prevents a concurrent close once it commits', async () => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const operation = runInTransaction(async session => {
    await lockPeriod(session);
    entered(); await proceed;
    await emitAccountingEvent('order', oid(), {}, owner, { session });
  });
  await ready;
  const closing = runInTransaction(session => closeMonth('2025-01', { session, req: req() }));
  // Attach the rejection handler before letting the operation commit.
  const result = closing.then(value => ({ value }), error => ({ error }));
  release(); await operation;
  expect((await result).error.statusCode).toBe(400);
  expect((await AccountingSettings.findOne({ key: 'main' })).lockDate).toBeNull();
});

test('year closing refuses unresolved operational events without creating a closing entry', async () => {
  await AccountingEvent.create({ type: 'order', refId: oid() });
  await expect(runInTransaction(session => closeYear('2025', { session, req: req() }))).rejects.toMatchObject({ statusCode: 400 });
  expect(await JournalEntry.countDocuments({ eventType: 'YEAR_CLOSE' })).toBe(0);
});
