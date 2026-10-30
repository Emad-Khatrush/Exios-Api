const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');
const { getBalance } = require('../services/carrying');
const { AccountingSettings, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');
const { syncOrder } = require('../services/claims/sync');
const operations = require('../services/posting/operations');
const payables = require('../services/posting/payables');
const { orderSummary } = require('../services/reports/summaries');
const Order = require('../../models/order');
const Statement = require('../../models/userStatement');

beforeAll(startDb);
afterAll(stopDb);
const tx = fn => runInTransaction(fn);
const req = { user: { _id: oid() } };
let user, order, vendor;
const balance = async code => (await getBalance((await account(code))._id)).usd;
const sync = options => tx(session => syncOrder(order, { session, ...options }));
async function status(value) {
  await Order.updateOne({ _id: order }, { $set: { orderStatus: value } });
  await sync();
}
async function cost(amount) {
  return tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-10-28', currency: 'USD',
    lines: [{ target: 'order', orderId: order, amount, description: 'Goods purchased' }] }, { session, req }));
}
async function pay(amount) {
  for (const calculationType of ['+', '-']) {
    const statement = await Statement.create({ user, createdBy: req.user._id, description: 'Customer payment',
      total: 0, paymentType: 'wallet', createdAt: new Date('2026-10-28'), amount, currency: 'USD',
      calculationType, actionType: calculationType === '+' ? 'cash' : 'wallet', office: 'tripoli' });
    await tx(session => operations.postStatement(statement._id, { session,
      ...(calculationType === '-' && { target: { orderId: order, category: 'invoice' } }) }));
  }
}
beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  user = (await mongoose.connection.collection('users').insertOne({ firstName: 'Purchase customer', customerId: 'T1' })).insertedId;
  order = (await Order.collection.insertOne({ orderId: 'PUR-TEST', user, placedAt: 'tripoli', isPayment: true,
    isShipment: false, totalInvoice: 500, orderStatus: 0, paymentList: [], createdAt: new Date('2026-10-28') })).insertedId;
  vendor = await Vendor.create({ name: 'Supplier', type: 'supplier' });
});

test('500 invoice, 400 cost, 450 collected: full cost/revenue at purchase, 50 receivable, later payment adds no profit', async () => {
  await cost(400);
  await pay(450);
  expect(await balance('410300')).toBe(0);
  expect(await balance('510400')).toBe(0);
  expect(await balance('130200')).toBe(40000);
  await status(1);
  expect(await balance('410300')).toBe(-50000);
  expect(await balance('510400')).toBe(40000);
  expect(await balance('130200')).toBe(0);
  expect(await balance('220300')).toBe(0);
  const summary = await orderSummary(order);
  expect(summary.totals).toMatchObject({ billed: 50000, paid: 45000, open: 5000, recognized: 50000, cost: 40000 });
  await pay(50);
  expect(await balance('410300')).toBe(-50000);
  expect(await balance('510400')).toBe(40000);
  const count = await JournalEntry.countDocuments();
  await sync();
  expect(await JournalEntry.countDocuments()).toBe(count);
});

test('full payment or invoice confirmation alone does not complete the purchase service', async () => {
  await cost(400);
  await Order.updateOne({ _id: order }, { $set: { invoiceConfirmed: true } });
  await pay(500);
  expect(await balance('410300')).toBe(0);
  expect(await balance('510400')).toBe(0);
  await status(1);
  expect(await balance('410300')).toBe(-50000);
  expect(await balance('510400')).toBe(40000);
});

test('unpaid completed purchase recognises full cost, late costs adjust profit, undo/cancel unwinds recognition only', async () => {
  await status(2);
  await cost(400);
  expect(await balance('410300')).toBe(-50000);
  expect(await balance('510400')).toBe(40000);
  await cost(30);
  expect(await balance('510400')).toBe(43000);
  await status(0);
  expect(await balance('410300')).toBe(0);
  expect(await balance('130200')).toBe(43000);
  await status(1);
  await Order.updateOne({ _id: order }, { $set: { isCanceled: true } });
  await sync();
  expect(await balance('410300')).toBe(0);
  expect(await balance('510400')).toBe(0);
  expect(await balance('130200')).toBe(43000); // Supplier obligation is not erased by customer cancellation.
});

test('completed zero-price purchase still expenses its real cost', async () => {
  await Order.updateOne({ _id: order }, { $set: { totalInvoice: 0, orderStatus: 1 } });
  await cost(40);
  expect(await balance('410300')).toBe(0);
  expect(await balance('510400')).toBe(4000);
  expect(await balance('130200')).toBe(0);
  expect((await orderSummary(order)).totals).toMatchObject({ recognized: 0, cost: 4000, profit: -4000 });
});

test('historical replay retains payment-based recognition', async () => {
  await cost(400);
  await pay(450);
  await Order.updateOne({ _id: order }, { $set: { orderStatus: 1 } });
  await sync({ isHistorical: true });
  expect(await balance('410300')).toBe(-45000);
  expect(await balance('510400')).toBe(36000);
  expect(await balance('130200')).toBe(4000);
  const oldEntries = await JournalEntry.find().select('_id day lines').lean();
  await sync();
  expect(await balance('410300')).toBe(-50000);
  expect(await balance('510400')).toBe(40000);
  expect(await balance('130200')).toBe(0);
  for (const entry of oldEntries) {
    const saved = await JournalEntry.findById(entry._id).select('_id day lines').lean();
    expect(saved).toEqual(entry); // Forward adjustment, never rewrite original journals.
  }
});

test('Alipay remittance keeps its existing recognition policy', async () => {
  await Order.updateOne({ _id: order }, { $set: { isRemittance: true, orderStatus: 1 } });
  await cost(400);
  await pay(450);
  const summary = await orderSummary(order);
  expect(summary.totals.recognized).toBe(45000);
  expect(summary.totals.cost).toBe(36000);
});
