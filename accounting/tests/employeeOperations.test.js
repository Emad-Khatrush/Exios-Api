const { startDb, stopDb, resetDb, oid } = require('./helpers');
const mongoose = require('mongoose');
const User = require('../../models/user');
const Statement = require('../../models/userStatement');
const Payment = require('../../models/orderPaymentHistory');
const { SupplierBill } = require('../models/documents');
const { AuditLog, JournalEntry } = require('../models');
const Review = require('../models/operationReview');
const operations = require('../services/employeeOperations');
const { today, addDays } = require('../services/dates');
const { runInTransaction } = require('../services/transaction');
let actor, client, statement;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb({ setup: false });
  actor = (await User.collection.insertOne({ firstName: 'Staff', lastName: 'One', phone: 10001, username: 'staff-test', customerId: 'STAFF1', office: 'tripoli', roles: { isEmployee: true }, password: 'must-not-leak' })).insertedId;
  client = (await User.collection.insertOne({ firstName: 'Client', lastName: 'One', phone: 10002, username: 'client-test', customerId: 'TEST1', password: 'private' })).insertedId;
  statement = await Statement.create({ user: client, createdBy: actor, amount: 100, currency: 'USD', total: 100,
    calculationType: '+', paymentType: 'wallet', actionType: 'cash', description: 'Deposit', office: 'tripoli', createdAt: new Date() });
});
const req = () => ({ user: { _id: actor } });
const mark = (row, state = 'reviewed', note = '') => runInTransaction(session => operations.review({ state, note, items: [{ key: row.key, fingerprint: row.fingerprint }] }, req(), session));

test('original wallet payment appears once and derives purpose from the linked payment, including non-posted records', async () => {
  await Statement.updateOne({ _id: statement._id }, { calculationType: '-', actionType: 'wallet', total: 0 });
  await Payment.create({ customer: client, order: oid(), createdBy: actor, receivedAmount: 100, currency: 'USD', category: 'invoice', paymentType: 'wallet', statementId: statement._id });
  const data = await operations.list();
  expect(data.total).toBe(1); expect(data.results[0].kind).toBe('purchase_payment');
  expect(data.results[0].entries).toHaveLength(0);
  expect(data.results[0]).toMatchObject({ actorName: 'Staff One', partnerName: 'Client One', customerCode: 'TEST1', reviewState: 'pending' });
  expect(JSON.stringify(data)).not.toContain('must-not-leak'); expect(JSON.stringify(data)).not.toContain('private');
});

test('backdated entries are reviewed on the day entered, with filters, exact totals and stable pagination', async () => {
  await Statement.collection.updateOne({ _id: statement._id }, { $set: { createdAt: new Date(addDays(today(), -10)) } });
  const data = await operations.list({ office: 'tripoli', employee: String(actor), kind: 'deposit' });
  expect(data.total).toBe(1); expect(data.results[0].operationDay).toBe(addDays(today(), -10));
  expect((await operations.list({ office: 'turkey' })).total).toBe(0);
  expect((await operations.list({ employee: String(client) })).total).toBe(0);
  expect(data.currencies[0]).toMatchObject({ _id: { currency: 'USD', kind: 'deposit' }, amount: 100 });
  const rows = Array.from({ length: 35 }, (_, i) => ({ ...statement.toObject(), _id: oid(), amount: i + 1 }));
  await Statement.collection.insertMany(rows);
  const first = await operations.list(), second = await operations.list({ page: 2 });
  expect(first.total).toBe(36); expect(first.results).toHaveLength(30); expect(second.results).toHaveLength(6);
  expect(new Set([...first.results, ...second.results].map(r => r.key)).size).toBe(36);
});

test('reviews save the actor and note, stale snapshots are refused, and changes reopen review without changing financial data', async () => {
  const row = (await operations.list()).results[0];
  await mark(row);
  expect((await operations.list({ state: 'reviewed' })).total).toBe(1);
  expect((await Review.findOne()).reviewedBy.toString()).toBe(String(actor));
  expect(await AuditLog.countDocuments({ action: 'operations.review' })).toBe(1);
  expect(await JournalEntry.countDocuments()).toBe(0);
  await Statement.updateOne({ _id: statement._id }, { amount: 90 });
  expect((await operations.list({ state: 'pending' })).total).toBe(1);
  await expect(mark(row)).rejects.toMatchObject({ statusCode: 409 });
  const current = (await operations.list()).results[0];
  await mark(current, 'issue', 'Missing receipt');
  expect((await operations.list({ state: 'issue' })).results[0].review.note).toBe('Missing receipt');
  expect((await Statement.findById(statement._id)).amount).toBe(90);
});

test('draft supplier bills and archived wallet edits are included; validation rejects invalid periods and selections', async () => {
  await SupplierBill.collection.insertOne({ vendorId: oid(), number: 'TEST-BILL', status: 'draft', currency: 'LYD', total: 200, lines: [], office: 'benghazi', createdBy: actor, createdAt: new Date(), updatedAt: new Date() });
  await Statement.updateOne({ _id: statement._id }, { $push: { editHistory: { editedBy: actor, editedAt: new Date(), before: { amount: 110 } } } });
  const data = await operations.list();
  expect(data.results.some(r => r.kind === 'supplier_bill' && r.status === 'draft' && r.amount === 200)).toBe(true);
  expect(data.results.some(r => r.kind === 'change' && r.actorId.toString() === String(actor))).toBe(true);
  await expect(operations.list({ from: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
  await expect(operations.list({ to: addDays(today(), 1) })).rejects.toMatchObject({ statusCode: 400 });
  await expect(runInTransaction(session => operations.review({ state: 'reviewed', note: '', items: [] }, req(), session))).rejects.toMatchObject({ statusCode: 400 });
});

test('linked refund credits appear once, cancellation stays visible and canceled amounts are excluded from totals', async () => {
  const { CustomerRefund } = require('../models/documents');
  await Statement.updateOne({ _id: statement._id }, { actionType: 'refund' });
  await CustomerRefund.collection.insertOne({ partnerId: client, userStatementId: statement._id, number: 'REF1', currency: 'USD', amount: 100, createdBy: actor, status: 'posted', createdAt: new Date(), updatedAt: new Date() });
  const data = await operations.list();
  expect(data.total).toBe(1); expect(data.results[0].kind).toBe('refund');
  expect(data.currencies[0].amount).toBe(100);
  await CustomerRefund.updateOne({ number: 'REF1' }, { status: 'canceled' });
  const canceled = await operations.list();
  expect(canceled.results[0].status).toBe('canceled'); expect(canceled.currencies).toEqual([]);
});

test('batch review is atomic when any selected operation changed; malformed input never writes a review', async () => {
  const data = await operations.list(); const row = data.results[0];
  const input = { state: 'reviewed', note: '', items: [{ key: row.key, fingerprint: row.fingerprint }, { key: `UserStatement:${oid()}`, fingerprint: 'stale' }] };
  await expect(runInTransaction(session => operations.review(input, req(), session))).rejects.toMatchObject({ statusCode: 409 });
  expect(await Review.countDocuments()).toBe(0);
  for (const items of [[null], [row, row], new Array(101).fill(row)]) {
    await expect(runInTransaction(session => operations.review({ ...input, items }, req(), session))).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(mark(row, 'issue', '')).rejects.toMatchObject({ statusCode: 400 });
  expect(await Review.countDocuments()).toBe(0);
});

test('deleted orders retain their canceling employee and can be reviewed despite the normal soft-delete query hook', async () => {
  const Order = require('../../models/order');
  await Order.collection.insertOne({ orderId: 'TEST-ORDER', user: client, madeBy: actor, totalInvoice: 125, isDeleted: true, deletedAt: new Date(), deletedBy: actor, createdAt: new Date(), updatedAt: new Date() });
  const rows = (await operations.list()).results.filter(r => r.sourceModel === 'Order');
  expect(rows).toHaveLength(2);
  expect(rows.some(r => r.kind === 'change' && String(r.actorId) === String(actor))).toBe(true);
  await mark(rows.find(r => r.kind === 'change'));
  expect((await operations.list({ state: 'reviewed' })).total).toBe(1);
});

test('shipping orders appear before delivery without inventing an invoice amount, and use their recorded office', async () => {
  const Order = require('../../models/order');
  await Order.collection.insertOne({ orderId: 'SHIP-TEST', user: client, madeBy: actor, isShipment: true, isPayment: false, totalInvoice: 0, placedAt: 'benghazi', createdAt: new Date(), updatedAt: new Date() });
  const data = await operations.list({ kind: 'shipping_order', office: 'benghazi' });
  expect(data.total).toBe(1); expect(data.results[0].amount).toBe(null); expect(data.results[0].office).toBe('benghazi');
  expect(data.currencies).toHaveLength(0);
});

test('HTTP endpoints require accounting access and read-only accountants cannot approve operations', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json()); app.use('/accounting', require('..').routes); app.use(require('../../middleware/error'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = (method, path, token) => request(server)[method]('/accounting/daily-work/operations' + path).set('Connection', 'close').set('Authorization', `Bearer ${token}`);
  try {
    const token = jwt.sign({ id: actor }, process.env.JWT_SECRET);
    expect((await call('get', '', token)).status).toBe(403);
    await User.updateOne({ _id: actor }, { 'roles.isAccountant': true });
    const { AccountingMember } = require('../models');
    await AccountingMember.create({ userId: actor, permissions: ['reports'] });
    expect((await call('get', '', token)).status).toBe(200);
    expect((await call('post', '/review', token).send({ state: 'reviewed', note: '', items: [] })).status).toBe(403);
    await AccountingMember.updateOne({ userId: actor }, { permissions: ['reports', 'treasury'] });
    const row = (await operations.list()).results[0];
    expect((await call('post', '/review', token).send({ state: 'reviewed', note: '', items: [{ key: row.key, fingerprint: row.fingerprint }] })).status).toBe(200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
