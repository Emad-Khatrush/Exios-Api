// Phase B of the V6 decisions: partner current accounts (Aswaq) classified to trips, orders and
// debts; receipts from suppliers; third-party funders; claim write-offs; year closing.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { SupplierBill } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const bank = require('../services/posting/bank');
const { refreshTripPackages } = require('../services/tripLinks');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const Balance = require('../../models/balance');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const admin = { _id: oid(), roles: { isAdmin: true } };
const req = { user: admin };
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;
const setSettings = async (values) => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: values });
  invalidateConfig();
};

beforeEach(async () => {
  await resetDb();
  await setSettings({ liveEnabled: true });
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 9 }]);
});

let customerSeq = 0;
const newCustomer = async () => {
  customerSeq++;
  return (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: String(customerSeq), customerId: `B${customerSeq}` })).insertedId;
};

async function newOrder({ user, isPayment = false, totalInvoice = 0, packages = [] }) {
  const paymentList = packages.map((p) => ({
    _id: oid(),
    status: { arrived: true, received: !!p.received },
    deliveredPackages: { trackingNumber: `TRK${Math.random().toString(36).slice(2, 7)}`, weight: { total: p.weight, measureUnit: 'KG' }, exiosPrice: p.price, shipmentMethod: 'air' },
  }));
  const { insertedId } = await Order.collection.insertOne({
    orderId: `B${Date.now()}${Math.random().toString(36).slice(2, 6)}`, user, placedAt: 'tripoli', isPayment, isShipment: !isPayment,
    totalInvoice, unsureOrder: false, isCanceled: false, shipment: { method: 'air' }, paymentList, createdAt: new Date('2026-01-02'),
  });
  return { _id: insertedId, packageIds: paymentList.map((p) => p._id) };
}

const newTrip = async (packageIds) => {
  const { insertedId } = await Inventory.collection.insertOne({
    voyage: 'AIR-B', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', status: 'processing',
    orders: packageIds.map((id) => ({ paymentList: { _id: id } })), createdAt: new Date(),
  });
  await refreshTripPackages(insertedId);
  return insertedId;
};

const importLine = async (accountCode, row) => {
  const acct = await account(accountCode);
  await tx((session) => bank.importLines(acct._id, [row], { session, req }));
  const { BankStatementLine } = require('../models/documents');
  return BankStatementLine.findOne({ accountId: acct._id, description: row.description }).lean();
};

test('B4: an Aswaq statement line goes to a trip, an order or a customer debt', async () => {
  const customer = await newCustomer();
  const order = await newOrder({ user: customer, isPayment: true, totalInvoice: 300 });
  const shipment = await newOrder({ user: customer, packages: [{ weight: 10, price: 10 }] });
  const trip = await newTrip(shipment.packageIds);
  await tx((session) => syncOrder(order._id, { session }));

  // Aswaq paid 80$ of shipping on the trip, 250$ for the purchase, 40$ of customs for the customer
  const tripLine = await importLine('260100', { day: '2026-02-01', description: 'Aswaq shipping UAE', amount: -80 });
  await tx((session) => bank.createEntryForLine(tripLine._id, { target: 'trip', tripId: trip, confirmNotDuplicate: true }, { session, req }));
  const orderLine = await importLine('260100', { day: '2026-02-02', description: 'Aswaq purchase KSA', amount: -250 });
  await tx((session) => bank.createEntryForLine(orderLine._id, { target: 'order', orderId: order._id, confirmNotDuplicate: true }, { session, req }));
  const debtLine = await importLine('260100', { day: '2026-02-03', description: 'Customs paid for customer', amount: -40 });
  await tx((session) => bank.createEntryForLine(debtLine._id, { target: 'debt', partnerId: customer, confirmNotDuplicate: true }, { session, req }));

  // We owe Aswaq 370$; the trip, the order and the customer carry their share
  expect(await balanceOf('260100')).toBe(-37000);
  expect(await balanceOf('130100', { tripId: trip })).toBe(8000);
  expect(await balanceOf('130200', { orderId: order._id })).toBe(25000);
  const debt = await Balance.findOne({ owner: customer }).lean();
  expect(debt).toMatchObject({ amount: 40, currency: 'USD', debtType: 'general', source: { kind: 'partner' } });
  expect(await balanceOf('121000', { partnerId: customer })).toBe(44000); // 300 purchase + 100 shipping + 40 debt
  expect(await JournalEntry.exists({ eventKey: `GENERAL_DEBT:${debt._id}`, 'lines.arKey': `GEN:${debt._id}` })).toBeTruthy();
  expect(await SupplierBill.countDocuments({ status: 'posted' })).toBe(2);

  // Undoing the debt line takes the debt away again
  await tx((session) => bank.cancelLineEntry(debtLine._id, { session, req, reason: 'خطأ' }));
  expect(await Balance.countDocuments({ owner: customer })).toBe(0);
  expect(await balanceOf('260100')).toBe(-33000);
});
