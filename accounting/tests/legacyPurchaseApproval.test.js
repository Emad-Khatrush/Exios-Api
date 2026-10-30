const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const Order = require('../../models/order');
const { Vendor, SupplierBill, SupplierPayment } = require('../models/documents');
const { JournalEntry, AccountingSettings, CurrencyRate } = require('../models');
const { invalidateConfig } = require('../services/config');
const { today, addDays } = require('../services/dates');
const approval = require('../services/legacyPurchaseApproval');
const { createBill } = require('../services/posting/payables');
let orderId, itemId, vendor, req;
const request = row => ({ mode: 'create', fingerprint: row.fingerprint, vendorId: String(vendor._id), day: today(), requestKey: 'legacy_approval_request_123456', confirmNewCost: true });
const approve = input => runInTransaction(session => approval.approve(String(orderId), String(itemId), input, { session, req }));
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb(); orderId = oid(); itemId = oid(); req = { user: { _id: oid(), roles: { isAdmin: true } } };
  vendor = await Vendor.create({ name: '1688 Shop', type: 'supplier' });
  await Order.collection.insertOne({ _id: orderId, orderId: 'LINK-TEST', user: oid(), placedAt: 'tripoli', isPayment: true, totalInvoice: 200, createdAt: new Date(), purchaseItems: [{ _id: itemId, unitPrice: 100, currency: 'USD', description: '1688 purchase', date: today() }] });
});

test('adopts the original item as one bill and leaves the wallet and payment untouched by default', async () => {
  const row = (await approval.list(String(orderId))).results[0];
  const result = await approve(request(row));
  expect(result.bill.lines[0]).toMatchObject({ amount: 100, target: 'order' });
  expect(String(result.bill.lines[0].purchaseItemId)).toBe(String(itemId));
  expect(String(result.bill.lines[0].orderId)).toBe(String(orderId));
  expect(await SupplierPayment.countDocuments()).toBe(0);
  expect((await Order.findById(orderId)).purchaseItems[0].unitPrice).toBe(100);
  const current = (await approval.list(String(orderId))).results[0];
  expect(current.linkedBills).toHaveLength(1);
  await approve(request(row));
  expect(await SupplierBill.countDocuments({ 'lines.purchaseItemId': itemId })).toBe(1);
});

test('two simultaneous approvals with different request keys create only one cost', async () => {
  const row = (await approval.list(String(orderId))).results[0];
  const replies = await Promise.all([approve(request(row)), approve({ ...request(row), requestKey: 'legacy_approval_request_654321' })]);
  expect(replies.filter(r => r.replayed)).toHaveLength(1);
  expect(await SupplierBill.countDocuments()).toBe(1);
});

test('existing matching invoice attaches the item without creating or changing a journal entry', async () => {
  const bill = await runInTransaction(session => createBill({ vendorId: vendor._id, day: today(), currency: 'USD', isHistorical: true,
    idempotencyKey: 'existing_legacy_supplier_bill', lines: [{ target: 'order', orderId, amount: 100, description: 'Existing statement purchase' }] }, { session, req }));
  const row = (await approval.list(String(orderId))).results[0];
  expect(row.candidates).toHaveLength(1);
  const before = await JournalEntry.countDocuments();
  const result = await approve({ mode: 'link', fingerprint: row.fingerprint, billId: String(bill._id), lineId: String(bill.lines[0]._id) });
  expect(result.linkedExisting).toBe(true);
  expect(await SupplierBill.countDocuments()).toBe(1); expect(await JournalEntry.countDocuments()).toBe(before);
  expect(String((await SupplierBill.findById(bill._id)).lines[0].purchaseItemId)).toBe(String(itemId));
});

test('already migrated purchases open their original bill rather than being charged again', async () => {
  const bill = await runInTransaction(session => createBill({ vendorId: vendor._id, day: today(), currency: 'USD', isHistorical: true,
    idempotencyKey: `MIG:PURCH:${itemId}`, lines: [{ target: 'order', orderId, amount: 100, description: 'Migrated purchase' }] }, { session, req }));
  const row = (await approval.list(String(orderId))).results[0];
  expect(row.linkedBills).toHaveLength(1);
  expect(String((await approve(request(row))).bill._id)).toBe(String(bill._id));
  expect(await SupplierBill.countDocuments()).toBe(1);
});

test('stale items, closed periods and unconfirmed new payments cannot silently post', async () => {
  const row = (await approval.list(String(orderId))).results[0];
  await Order.updateOne({ _id: orderId }, { $set: { 'purchaseItems.0.unitPrice': 110 } });
  await expect(approve(request(row))).rejects.toMatchObject({ statusCode: 409 });
  const fresh = (await approval.list(String(orderId))).results[0];
  await expect(approve({ ...request(fresh), confirmNewCost: false })).rejects.toMatchObject({ statusCode: 400 });
  await expect(approve({ ...request(fresh), payFromAccountId: String((await account('110101'))._id) })).rejects.toMatchObject({ statusCode: 400 });
  await AccountingSettings.updateOne({ key: 'main' }, { lockDate: today() }); invalidateConfig();
  req.user.roles = { isAccountant: true };
  await expect(approve(request(fresh))).rejects.toMatchObject({ statusCode: 403 });
  expect(await SupplierBill.countDocuments()).toBe(0);
});

test('CNY amounts remain CNY, with valuation using the chosen approval-date rate', async () => {
  await Order.updateOne({ _id: orderId }, { $set: { 'purchaseItems.0.unitPrice': 798.8, 'purchaseItems.0.currency': 'CNY' } });
  await CurrencyRate.create({ currency: 'CNY', day: addDays(today(), -1), rate: 7 });
  const row = (await approval.list(String(orderId))).results[0];
  const result = await approve(request(row));
  expect(result.bill.currency).toBe('CNY'); expect(result.bill.total).toBe(798.8);
  expect(result.bill.totalUsd).toBe(11411);
});

test('an explicitly confirmed new payment is made once even when approval is retried', async () => {
  const cash = await account('110101'), equity = await account('390000');
  await post({ eventType: 'MANUAL', eventKey: 'LEGACY:CASH', date: today(), lines: [{ accountId: cash._id, debit: 20000 }, { accountId: equity._id, credit: 20000 }] });
  const row = (await approval.list(String(orderId))).results[0];
  const input = { ...request(row), payFromAccountId: String(cash._id), confirmNewPayment: true };
  await approve(input); await approve(input);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  const { getBalance } = require('../services/carrying');
  expect((await getBalance(cash._id)).usd).toBe(10000);
});

test('HTTP approval is limited to purchase permissions; read-only accountants may only inspect the links', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const express = require('express'), requestHttp = require('supertest'), jwt = require('jsonwebtoken');
  const User = require('../../models/user'), { AccountingMember } = require('../models');
  await User.collection.insertOne({ _id: req.user._id, username: 'legacy-approver', firstName: 'Approver', customerId: 'LEGACY-APPROVER', phone: 100001, roles: { isAccountant: true } });
  const member = await AccountingMember.create({ userId: req.user._id, permissions: ['reports'] });
  const app = express(); app.use(express.json()); app.use('/accounting', require('..').routes); app.use(require('../../middleware/error'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const token = jwt.sign({ id: req.user._id }, process.env.JWT_SECRET), base = `/accounting/orders/${orderId}/legacy-purchases`;
  const call = (method, path) => requestHttp(server)[method](path).set('Connection', 'close').set('Authorization', `Bearer ${token}`);
  try {
    const read = await call('get', base); expect(read.status).toBe(200);
    expect((await call('post', `${base}/${itemId}/approve`).send(request(read.body.results[0]))).status).toBe(403);
    await AccountingMember.updateOne({ _id: member._id }, { permissions: ['reports', 'purchases'] });
    expect((await call('post', `${base}/${itemId}/approve`).send(request(read.body.results[0]))).status).toBe(200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
