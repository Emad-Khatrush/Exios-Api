process.env.JWT_SECRET = process.env.JWT_SECRET || 'historical-cash-test-secret';
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const cash = require('../services/historicalCash');
const { HistoricalCashBatch: Batch, HistoricalCashMutex: Mutex } = require('../models/historicalCash');
const { JournalEntry, AccountingMember, AuditLog } = require('../models');
const { BankStatementLine } = require('../models/documents');
const Wallet = require('../../models/wallet');
const Statement = require('../../models/userStatement');
const User = require('../../models/user');
const errorHandler = require('../../middleware/error');
const { routes } = require('..');
const tx = fn => runInTransaction(fn);
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let bank, seq = 0;
const input = extra => ({ requestKey: `HISTORY-REQUEST-${++seq}`, title: 'Tripoli Jan 2026', office: 'tripoli', accountId: String(bank._id),
  from: '2026-01-01', to: '2026-03-31', opening: 50, closing: 125,
  rows: [
    { day: '2026-01-05', description: 'Customer deposit', amount: 100, direction: 'in', category: 'customer_receipt', reference: 'REC-1' },
    { day: '2026-01-06', description: 'Office expense', amount: 25, direction: 'out', category: 'operating', reference: 'EXP-1' },
  ], ...extra });
async function save(data, file) {
  const preview = await cash.preview(data, file);
  const result = await tx(session => cash.save({ ...data, fingerprint: preview.fingerprint }, file, { session, req }));
  return cash.detail(result._id);
}
const review = (batch, action = 'approve') => tx(session => cash.changeStatus(batch._id, { action, revision: batch.revision, reason: 'Checked against original source' }, { session, req }));
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); bank = await account('110101'); await Mutex.create({ key: 'main' }); });

test('Excel source is retained; saving, approval, reopening and voiding never change wallets, ledger or bank lines', async () => {
  const wallet = await Wallet.collection.insertOne({ user: req.user._id, currency: 'USD', balance: 321 });
  const before = [await JournalEntry.countDocuments(), await Statement.countDocuments(), await BankStatementLine.countDocuments()];
  const file = { originalname: 'original.xlsx', size: 8, buffer: Buffer.from('original') };
  let batch = await save(input(), file);
  expect(batch).toMatchObject({ status: 'draft', reconciliation: 0, inflow: 10000, outflow: 2500 });
  expect(batch.sourceFile.data).toBeUndefined();
  expect(Buffer.from((await cash.source(batch._id)).data).toString()).toBe('original');
  await review(batch);
  batch = await cash.detail(batch._id); expect(batch.status).toBe('approved');
  await expect(tx(session => cash.save({ ...cash.rowInput(batch), revision: batch.revision }, null, { session, req, batchId: batch._id }))).rejects.toThrow();
  await review(batch, 'reopen'); batch = await cash.detail(batch._id);
  await review(batch, 'void');
  expect((await cash.list()).count).toBe(0);
  expect(await Wallet.findById(wallet.insertedId).lean()).toMatchObject({ balance: 321 });
  expect([await JournalEntry.countDocuments(), await Statement.countDocuments(), await BankStatementLine.countDocuments()]).toEqual(before);
  expect(await AuditLog.countDocuments({ model: 'AccountingHistoricalCashBatch' })).toBe(4);
});

test('validates real dates, directions, precision, offices and bounds; unknown or unbalanced drafts cannot be approved', async () => {
  const invalid = input({ rows: [{ day: '2026-02-30', description: 'Invalid date', amount: 1, direction: 'in' }, { day: '2026-04-01', description: 'Outside', amount: 1, direction: 'in' }, { day: '2026-01-02', description: 'Wrong sign', amount: -2, direction: 'in' }, { day: '2026-01-02', description: 'Wrong category', amount: 3, direction: 'in', category: 'operating' }] });
  expect((await cash.preview(invalid)).errors).toBe(4);
  invalid.rows.push(null, { day: '2026-01-02', description: 'Invalid category', amount: 1, direction: 'in', category: '__proto__' });
  expect((await cash.preview(invalid)).errors).toBe(6);
  await expect(cash.preview(input({ office: 'turkey' }))).rejects.toThrow();
  let batch = await save(input({ closing: 126 })); await expect(review(batch)).rejects.toThrow();
  batch = await save(input({ rows: [{ day: '2026-02-01', description: 'Unknown movement', amount: 1, direction: 'in', category: 'unknown' }], closing: 51 }));
  await expect(review(batch)).rejects.toThrow();
  bank = await account('110102');
  expect((await cash.preview(input({ opening: 0, closing: 1.125, rows: [{ day: '2026-01-01', description: 'LYD precision', amount: 1.125, direction: 'in' }] }))).rows[0].amountMinor).toBe(1125);
  expect((await cash.preview(input({ rows: [{ day: '2026-01-01', description: 'Too precise', amount: 1.1251, direction: 'in' }] }))).errors).toBe(1);
  bank = await account('250100');
  await expect(cash.preview(input({ office: 'turkey' }))).rejects.toThrow();
  expect((await cash.options()).accounts.some(a => String(a._id) === String(bank._id))).toBe(false);
});

test('cross-file duplicate warnings cannot be bypassed without a documented independent decision; idempotent retry does not duplicate', async () => {
  const data = input(); const check = await cash.preview(data);
  const first = await tx(session => cash.save({ ...data, fingerprint: check.fingerprint }, null, { session, req }));
  const replay = await tx(session => cash.save({ ...data, fingerprint: check.fingerprint }, null, { session, req }));
  expect(String(first._id)).toBe(String(replay._id)); expect(replay.replayed).toBe(true);
  const duplicate = input(); const preview = await cash.preview(duplicate); expect(preview.errors).toBe(2);
  const renamed = input(); renamed.rows[0].description = 'Different bank narrative with the same receipt reference';
  expect((await cash.preview(renamed)).rows[0].duplicate).toBeTruthy();
  await expect(tx(session => cash.save({ ...duplicate, fingerprint: preview.fingerprint }, null, { session, req }))).rejects.toThrow();
  duplicate.rows = duplicate.rows.map(row => ({ ...row, duplicateReason: 'Separate verified payment on the same date' }));
  await save(duplicate);
  expect(await Batch.countDocuments()).toBe(2);
  const within = input({ rows: [data.rows[0], data.rows[0]] }); expect((await cash.preview(within)).errors).toBe(2);
});

test('wallet-only review can be approved without treasury balances; preserves reference balances and never changes the ledger or current wallets', async () => {
  const data = input({ scope: 'wallets', opening: '', closing: '', rows: [
    { day: '2026-01-05', description: 'Old wallet deposit', amount: 100, direction: 'in', category: 'customer_receipt', reference: 'PARTIAL-1' },
    { day: '2026-01-06', description: 'Old cash withdrawal', amount: 20, direction: 'out', category: 'customer_refund', reference: 'PARTIAL-2' },
  ] });
  const wallet = await Wallet.collection.insertOne({ user: req.user._id, currency: 'USD', balance: 321 });
  let batch = await save(data);
  expect(batch).toMatchObject({ scope: 'wallets', reconciliation: null, openingMinor: null, closingMinor: null });
  await review(batch);
  expect((await cash.detail(batch._id)).status).toBe('approved');
  const groups = (await cash.list({ status: 'approved', mode: 'manual' })).groups;
  expect(groups.reduce((s,g) => s + g.incoming - g.outgoing, 0)).toBe(8000);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect((await Wallet.findById(wallet.insertedId).lean()).balance).toBe(321);
  await review(await cash.detail(batch._id), 'reopen');
  batch = await cash.detail(batch._id);
  const edited = { ...cash.rowInput(batch), scope: 'wallets', opening: 1389, closing: 2114, revision: batch.revision };
  const check = await cash.preview(edited, null, { excludeId: batch._id });
  await tx(session => cash.save({ ...edited, fingerprint: check.fingerprint }, null, { session, req, batchId: batch._id }));
  batch = await cash.detail(batch._id);
  expect(batch).toMatchObject({ openingMinor: 138900, closingMinor: 211400, reconciliation: null });
  await review(batch);
});

test('wallet-only scope cannot bypass classification, duplicates or full-statement reconciliation', async () => {
  await expect(cash.preview(input({ scope: 'anything' }))).rejects.toThrow();
  expect((await cash.preview(input({ scope: 'wallets' }))).errors).toBe(1); // Office expense is not a wallet movement.
  const unknown = await save(input({ scope: 'wallets', rows: [{ day: '2026-01-08', description: 'Needs classification', amount: 20, direction: 'in', category: 'unknown' }] }));
  await expect(review(unknown)).rejects.toThrow();
  const original = await save(input({ scope: 'wallets', opening: '', closing: '', rows: [input().rows[0]] }));
  expect((await cash.preview(input({ rows: [input().rows[0]] }))).errors).toBe(1);
  await review(original);
  const legacy = await save(input({ opening: '', closing: '', rows: [{ day: '2026-02-01', description: 'Full statement', amount: 10, direction: 'in', category: 'customer_receipt' }] }));
  await Batch.updateOne({ _id: legacy._id }, { $unset: { scope: '' } });
  await expect(review(await cash.detail(legacy._id))).rejects.toThrow();
  // Client cannot bypass full-statement validation by supplying scope to the approval action.
  await expect(tx(session => cash.changeStatus(legacy._id, { action: 'approve', scope: 'wallets', revision: legacy.revision, reason: 'Attempt to bypass full reconciliation' }, { session, req }))).rejects.toThrow();
});

test('stale preview/revision is rejected, and editing a draft preserves its source and rechecks its totals', async () => {
  const data = input(), old = await cash.preview(data);
  await save(data);
  await expect(tx(session => cash.save({ ...data, requestKey: 'NEW-REQUEST-KEY-0001', fingerprint: old.fingerprint }, null, { session, req }))).rejects.toThrow();
  const batch = await Batch.findOne().lean();
  const edit = { ...cash.rowInput(batch), title: 'Edited', batchId: String(batch._id), revision: batch.revision, opening: 10, closing: 85 };
  const check = await cash.preview(edit, null, { excludeId: batch._id });
  await tx(session => cash.save({ ...edit, fingerprint: check.fingerprint }, null, { session, req, batchId: batch._id }));
  expect((await cash.detail(batch._id)).revision).toBe(2);
  await expect(tx(session => cash.save({ ...edit, fingerprint: check.fingerprint }, null, { session, req, batchId: batch._id }))).rejects.toThrow();
});

test('internal transfers require two opposite legs and changes cannot invalidate an approved counterpart', async () => {
  const first = await save(input({ opening: 100, closing: 60, rows: [{ day: '2026-01-05', description: 'To Benghazi', amount: 40, direction: 'out', category: 'transfer', transferRef: 'TR-2026-1' }] }));
  await expect(review(first)).rejects.toThrow();
  bank = await account('110103');
  const second = await save(input({ office: 'benghazi', opening: 0, closing: 40, rows: [{ day: '2026-01-05', description: 'From Tripoli', amount: 40, direction: 'in', category: 'transfer', transferRef: 'TR-2026-1' }] }));
  expect((await cash.detail(first._id)).transferProblems).toEqual([]);
  await review(first);
  await expect(review(second, 'void')).rejects.toThrow();
  await review(second);
  const report = await cash.list({ status: 'approved' });
  expect(report.groups.reduce((s, r) => s + r.net, 0)).toBe(0);
});

test('monthly aggregation uses row dates, filters and separate native currencies; voided batches are excluded', async () => {
  const usd = await save(input()); await review(usd);
  bank = await account('110102');
  await save(input({ opening: 0, closing: 9.25, rows: [{ day: '2026-02-01', description: 'LYD receipt', amount: 9.25, direction: 'in', category: 'customer_receipt' }] }));
  let report = await cash.list();
  expect(report.groups.find(r => r.month === '2026-01' && r.currency === 'USD').decimals).toBe(2);
  expect(report.groups.find(r => r.currency === 'LYD').incoming).toBe(9250);
  report = await cash.list({ from: '2026-02-01', to: '2026-02-28' }); expect(report.groups).toHaveLength(1);
  expect((await cash.list({ status: 'approved' })).count).toBe(1);
  expect((await cash.list({ currency: 'USD' })).groups.every(g => g.currency === 'USD')).toBe(true);
});

test('concurrent retries commit one batch and safely reject changing the saved payload under the same key', async () => {
  const data = input(), p = await cash.preview(data);
  const commit = () => tx(session => cash.save({ ...data, fingerprint: p.fingerprint }, null, { session, req }));
  const results = await Promise.all([commit(), commit()]);
  expect(String(results[0]._id)).toBe(String(results[1]._id));
  expect(await Batch.countDocuments()).toBe(1);
  await expect(tx(session => cash.save({ ...data, fingerprint: 'different-snapshot' }, null, { session, req }))).rejects.toThrow();
});

test('HTTP read/write/review/source permissions and multipart validation are enforced', async () => {
  const app = express(); app.use(express.json()); app.use('/api/accounting', routes); app.use(errorHandler);
  const make = async (name, permissions) => {
    const user = await User.create({ username: name, firstName: name, lastName: 'Tester', phone: 900000 + ++seq, password: 'x', customerId: `HC${seq}`, roles: { isAccountant: true } });
    await AccountingMember.create({ userId: user._id, enabled: true, permissions });
    return jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  };
  const reader = await make('historyreader', ['reports']);
  const writer = await make('historywriter', ['reports', 'treasury']);
  const url = '/api/accounting/historical-cash';
  expect((await request(app).get(url).set('Authorization', `Bearer ${reader}`)).status).toBe(200);
  expect((await request(app).post(`${url}/preview`).set('Authorization', `Bearer ${reader}`).send(input())).status).toBe(403);
  const data = input();
  const p = await request(app).post(`${url}/preview`).set('Authorization', `Bearer ${writer}`).field('payload', JSON.stringify(data)).attach('file', Buffer.from('source'), 'source.xlsx');
  expect(p.status).toBe(200); expect(p.body.errors).toBe(0);
  const saved = await request(app).post(url).set('Authorization', `Bearer ${writer}`).field('payload', JSON.stringify({ ...data, fingerprint: p.body.fingerprint })).attach('file', Buffer.from('source'), 'source.xlsx');
  expect(saved.status).toBe(201);
  expect((await request(app).get(`${url}/${saved.body._id}/source`).set('Authorization', `Bearer ${reader}`)).status).toBe(200);
  expect((await request(app).post(`${url}/${saved.body._id}/review`).set('Authorization', `Bearer ${writer}`).send({ action: 'approve', revision: 1, reason: 'Verified original source' })).status).toBe(403);
  expect((await request(app).post(`${url}/source-review`).set('Authorization', `Bearer ${writer}`).send({ key: 'invalid' })).status).toBe(403);
});
