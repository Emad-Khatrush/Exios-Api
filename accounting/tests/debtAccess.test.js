
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}) }));
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { AccountingSettings, AccountingEvent, JournalEntry } = require('../models');
const { invalidateConfig } = require('../services/config');
const Balance = require('../../models/balance');
const Activities = require('../../models/activities');
const errorHandler = require('../../middleware/error');
const app = express();
app.use(express.json());
app.use('/api', require('../../routes/balance'));
app.use(errorHandler);
jest.setTimeout(120000);
let users;
const api = (method, path, role = 'admin') => request(app)[method]('/api' + path)
  .set('Authorization', 'Bearer ' + jwt.sign({ id: users[role]._id }, process.env.JWT_SECRET));
const fixture = (extra = {}) => Balance.create({
  balanceType: 'debt', debtType: 'general', amount: 0, initialAmount: 10, currency: 'USD',
  status: 'waitingApproval', notes: 'settlement access test', createdOffice: 'tripoli',
  owner: users.client._id, createdBy: users.owner._id, createdAt: new Date('2026-06-01'),
  paymentHistory: [{ amount: 10, currency: 'USD', rate: 1, createdAt: new Date('2026-07-01') }], ...extra,
});
const lockAt = async day => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: day } });
  invalidateConfig();
};
beforeAll(async () => {
  await startDb(); await resetDb();
  users = {};
  const roles = { owner: { isAdmin: true }, admin: { isAdmin: true }, accountant: { isAccountant: true }, employee: { isEmployee: true }, client: { isClient: true } };
  let n = 0;
  for (const [role, flags] of Object.entries(roles)) {
    const _id = role === 'owner' ? new mongoose.Types.ObjectId('69deb74c4b5e921e7416ea11') : new mongoose.Types.ObjectId();
    users[role] = { _id, username: role, firstName: role, lastName: 'X', phone: 900001 + n, customerId: 'AUTH' + n++, roles: flags };
    await mongoose.connection.collection('users').insertOne(users[role]);
  }
});
afterAll(stopDb);
beforeEach(async () => {
  await Balance.deleteMany({}); await Activities.deleteMany({}); await AccountingEvent.deleteMany({});
  await AccountingSettings.updateOne({ key: 'main' }, { $unset: { lockDate: 1 } }); invalidateConfig();
});

test.each([
  ['open', 10, 'debt'], ['waitingApproval', 1, 'debt'], ['closed', 0, 'debt'],
  ['lost', 0, 'debt'], ['waitingApproval', 0, 'credit'], ['waitingApproval', -1, 'debt'],
])('approval rejects status %s amount %s type %s without changing the record', async (status, amount, balanceType) => {
  const debt = await fixture({ status, amount, balanceType });
  const before = await Balance.findById(debt._id).lean();
  expect((await api('put', '/balances/' + debt._id + '/confirmed').send({ amount: 0, status: 'waitingApproval' })).status).toBe(400);
  expect(await Balance.findById(debt._id).lean()).toEqual(before);
  expect(await Activities.countDocuments()).toBe(0);
});

test('missing debt returns 404 and invalid id returns 400', async () => {
  expect((await api('put', '/balances/' + new mongoose.Types.ObjectId() + '/confirmed').send({})).status).toBe(404);
  expect((await api('put', '/balances/invalid/confirmed').send({})).status).toBe(400);
});

test('approval closes a paid debt, records its actor and creates no financial entry', async () => {
  const debt = await fixture(); const entriesBefore = await JournalEntry.countDocuments();
  expect((await api('put', '/balances/' + debt._id + '/confirmed').send({})).status).toBe(200);
  expect((await Balance.findById(debt._id).lean()).status).toBe('closed');
  const audit = await Activities.findOne({ 'details.actionId': String(debt._id) }).lean();
  expect(String(audit.user)).toBe(String(users.admin._id));
  expect(audit.changedFields[0]).toMatchObject({ changedFrom: 'waitingApproval', changedTo: 'closed' });
  expect(await JournalEntry.countDocuments()).toBe(entriesBefore);
  expect(await AccountingEvent.countDocuments()).toBe(0);
});

test('two concurrent approvals commit one status change and one audit record', async () => {
  const debt = await fixture(); const url = '/balances/' + debt._id + '/confirmed';
  const results = await Promise.all([api('put', url).send({}), api('put', url).send({})]);
  expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  expect(await Activities.countDocuments({ 'details.actionId': String(debt._id) })).toBe(1);
});

test('failed approval audit rolls back status and retry succeeds', async () => {
  const debt = await fixture(); const url = '/balances/' + debt._id + '/confirmed';
  const spy = jest.spyOn(Activities, 'create').mockRejectedValue(new Error('approval audit unavailable'));
  try { expect((await api('put', url).send({})).status).toBe(500); } finally { spy.mockRestore(); }
  expect((await Balance.findById(debt._id).lean()).status).toBe('waitingApproval');
  expect(await Activities.countDocuments()).toBe(0);
  expect((await api('put', url).send({})).status).toBe(200);
});

test.each(['client', 'employee', 'accountant'])('%s cannot approve debts through the actual route', async role => {
  const debt = await fixture();
  expect((await api('put', '/balances/' + debt._id + '/confirmed', role).send({})).status).not.toBe(200);
  expect((await Balance.findById(debt._id).lean()).status).toBe('waitingApproval');
  expect(await Activities.countDocuments()).toBe(0);
});

test('an unauthenticated approval is refused', async () => {
  const debt = await fixture();
  expect((await request(app).put('/api/balances/' + debt._id + '/confirmed').send({})).status).not.toBe(200);
  expect((await Balance.findById(debt._id).lean()).status).toBe('waitingApproval');
});

test('closed-period settlement approval is refused for admin and allowed for owner', async () => {
  const debt = await fixture(); await lockAt('2026-07-31');
  const url = '/balances/' + debt._id + '/confirmed';
  expect((await api('put', url).send({})).status).toBe(403);
  expect((await Balance.findById(debt._id).lean()).status).toBe('waitingApproval');
  expect((await api('put', url, 'owner').send({})).status).toBe(200);
});

test('a debt created before closing can be approved when its final payment is in the open period', async () => {
  const debt = await fixture({ paymentHistory: [
    { amount: 5, currency: 'USD', rate: 1, createdAt: new Date('2026-08-01') },
    { amount: 5, currency: 'USD', rate: 1, createdAt: new Date('2026-07-01') },
  ] }); await lockAt('2026-07-31');
  expect((await api('put', '/balances/' + debt._id + '/confirmed').send({})).status).toBe(200);
});

test.each(['client', 'employee'])('%s cannot delete or manually close debts', async role => {
  const debt = await fixture({ status: 'open', amount: 10, paymentHistory: [] });
  expect((await api('delete', '/balances/' + debt._id, role)).status).not.toBe(200);
  expect((await api('put', '/balances/' + debt._id + '/close', role).send({ note: 'unauthorized' })).status).not.toBe(200);
  expect((await Balance.findById(debt._id).lean()).amount).toBe(10);
  expect(await AccountingEvent.countDocuments()).toBe(0);
});

test('accountant may manually close debts but cannot delete them', async () => {
  const debt = await fixture({ status: 'open', amount: 10, paymentHistory: [] });
  expect((await api('delete', '/balances/' + debt._id, 'accountant')).status).not.toBe(200);
  expect((await api('put', '/balances/' + debt._id + '/close', 'accountant').send({ note: 'authorized writeoff' })).status).toBe(200);
  expect((await Balance.findById(debt._id).lean()).manualClosure.writtenOffAmount).toBe(10);
});

test('admin cannot delete an old debt in a closed period; owner can', async () => {
  const debt = await fixture({ status: 'open', amount: 10, paymentHistory: [] }); await lockAt('2026-07-31');
  expect((await api('delete', '/balances/' + debt._id)).status).toBe(403);
  expect(await Balance.findById(debt._id).lean()).not.toBeNull();
  expect((await api('delete', '/balances/' + debt._id, 'owner')).status).toBe(200);
});

test('new debt and new writeoff cannot be recorded on a locked operation date by non-owner', async () => {
  const debt = await fixture({ status: 'open', amount: 10, paymentHistory: [] });
  await lockAt('2099-12-31');
  const createBody = { balanceType: 'debt', amount: 10, currency: 'USD', customerId: users.client.customerId, notes: 'locked creation', createdOffice: 'tripoli', debtType: 'general', sourceAccountId: String((await account('110121'))._id) };
  expect((await api('post', '/balances').send(createBody)).status).toBe(403);
  expect((await api('put', '/balances/' + debt._id + '/close', 'accountant').send({ note: 'locked writeoff' })).status).toBe(403);
  expect(await Balance.countDocuments()).toBe(1);
  expect((await Balance.findById(debt._id).lean()).amount).toBe(10);
  expect(await AccountingEvent.countDocuments()).toBe(0);
});


test.each(['0', ''])('browser multipart USD settlement accepts rate "%s" through authentication and upload middleware', async rate => {
  const Wallet = require('../../models/wallet');
  const UserStatement = require('../../models/userStatement');
  const debt = await fixture({ status: 'open', amount: 10, paymentHistory: [] });
  await Wallet.findOneAndUpdate({ user: users.client._id, currency: 'USD' }, { $set: { balance: 50 } }, { upsert: true });
  await UserStatement.deleteMany({ user: users.client._id });
  const response = await api('post', '/balances/' + debt._id + '/paymentHistory')
    .field('createdAt', new Date().toISOString())
    .field('amount', '10').field('currency', 'USD').field('rate', rate)
    .field('sameCurrency', 'true').field('debtType', 'general');
  expect({ status: response.status, message: response.body.message }).toEqual({ status: 200 });
  expect(response.body.amount).toBe(0);
  expect(response.body.status).toBe('waitingApproval');
  expect(response.body.paymentHistory[0].rate).toBe(0);
  expect((await Wallet.findOne({ user: users.client._id, currency: 'USD' }).lean()).balance).toBe(40);
  expect(await AccountingEvent.countDocuments({ type: 'statement' })).toBe(1);
});
