const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account } = require('./helpers');
const { MigrationRun, JournalEntry, AccountingSettings } = require('../models');
const { BankStatementLine, SupplierBill, SupplierPayment, SupplierReceipt } = require('../models/documents');
const { invalidateConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { postEntry } = require('../services/ledger');
const bank = require('../services/posting/bank');
const trial = require('../services/migration/bankTrial');
const migration = require('../services/migration');
let previousQa, bankAccount, expense;
const runId = 'MIG-BANK-TRIAL';
const scoped = fn => trial.requestScope(null, null, fn);
const rows = () => [{ day: '2026-09-05', description: 'Test service', reference: 'TRIAL1', amount: -50,
  counterAccountId: expense._id, office: 'turkey', vendorName: 'Trial supplier' }];
beforeAll(async () => { previousQa = process.env.EXIOS_QA; await startDb(); });
afterAll(async () => { if (previousQa === undefined) delete process.env.EXIOS_QA; else process.env.EXIOS_QA = previousQa; await stopDb(); });
beforeEach(async () => {
  process.env.EXIOS_QA = '1';
  await resetDb();
  bankAccount = await account('110202'); expense = await account('510400');
  await MigrationRun.create({ runId, status: 'review', cutoff: new Date('2026-10-09T00:00:00Z'),
    config: { countDay: '2026-08-31', openingCounts: [] } });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { migrationGuardDay: '2026-10-09' } });
  invalidateConfig();
});
test('QA activation leaves ordinary posting guarded and rejects production activation', async () => {
  process.env.EXIOS_QA = '0';
  await expect(trial.enable(runId)).rejects.toThrow('QA');
  process.env.EXIOS_QA = '1';
  await trial.enable(runId);
  await expect(runInTransaction(session => postEntry({ eventType: 'MANUAL', eventKey: 'ordinary', date: '2026-09-05',
    lines: [{ accountId: expense._id, debit: 100, office: 'turkey' }, { accountId: bankAccount._id, credit: 100, office: 'turkey' }] }, { session }))).rejects.toThrow('محجوزة');
});
test('import posts immediately; discard removes trial bill/payment and retains unmatched rows', async () => {
  await trial.enable(runId);
  const result = await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  expect(result.notPosted).toEqual([]);
  expect(result.posted).toBe(1);
  expect(await JournalEntry.countDocuments({ bankTrialRunId: runId })).toBeGreaterThan(0);
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect((await require('../services/odoo').pendingSummary()).count).toBe(0);
  await migration.discardRun(runId);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(0);
  expect(await SupplierPayment.countDocuments()).toBe(0);
  const line = await BankStatementLine.findOne().lean();
  expect(line.lineStatus).toBe('unmatched'); expect(line.entryId).toBeUndefined(); expect(line.billId).toBeUndefined();
  expect(await mongoose.connection.db.collection(trial.LOG).countDocuments()).toBe(0);
});

test('supplier refund credit/receipt and its matching are fully undone', async () => {
  await trial.enable(runId);
  await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  const bill = await SupplierBill.findOne();
  await scoped(() => bank.importStatement(bankAccount._id, [{ day: '2026-09-07', description: 'Trial supplier refund',
    reference: 'RF-TRIAL', amount: 10, originalAmount: 10, originalCurrency: 'USD', movementKind: 'purchase_refund' }], {}));
  const line = await BankStatementLine.findOne({ amount: 1000 });
  await scoped(() => runInTransaction(session => require('../services/posting/bankRefund').match(line._id,
    { kind: 'bill', billId: bill._id, confirmMerchant: true, walletUsd: 0 }, { session })));
  expect(await SupplierReceipt.countDocuments()).toBe(1);
  expect(await SupplierBill.countDocuments({ isCreditNote: true })).toBe(1);
  await migration.discardRun(runId);
  expect(await SupplierReceipt.countDocuments()).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(0);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(2);
});

test('reversal during trial is undone together with the original trial operation', async () => {
  await trial.enable(runId);
  await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  const line = await BankStatementLine.findOne();
  await scoped(() => runInTransaction(session => bank.cancelLineEntry(line._id, { session, reason: 'Trial correction' })));
  await migration.discardRun(runId);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(0);
  expect(await SupplierPayment.countDocuments()).toBe(0);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched');
});
test('failed bank transaction commits neither writes nor undo records', async () => {
  await trial.enable(runId);
  await expect(scoped(() => runInTransaction(async session => {
    await bank.importLines(bankAccount._id, [{ day: '2026-09-05', description: 'fail', amount: -9 }], { session });
    throw new Error('forced rollback');
  }))).rejects.toThrow('forced rollback');
  expect(await BankStatementLine.countDocuments()).toBe(0);
  expect(await mongoose.connection.db.collection(trial.LOG).countDocuments()).toBe(0);
});
test('rollback restores changes and deletes inserts in nested business collections', async () => {
  await trial.enable(runId);
  const User = require('../../models/user');
  const id = (await User.collection.insertOne({ firstName: 'Before', phone: 'trial-before', customerId: 'BT1' })).insertedId;
  await scoped(() => runInTransaction(async session => {
    await User.updateOne({ _id: id }, { $set: { firstName: 'During' } }, { session });
    await User.collection.insertOne({ firstName: 'Created', phone: 'trial-created', customerId: 'BT2' }, { session });
  }));
  await migration.discardRun(runId);
  expect((await User.findById(id)).firstName).toBe('Before');
  expect(await User.countDocuments({ firstName: 'Created' })).toBe(0);
});
test('external edits abort the entire discard without deleting other trial data', async () => {
  await trial.enable(runId);
  await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  const bill = await SupplierBill.findOne();
  await SupplierBill.updateOne({ _id: bill._id }, { $set: { description: 'Changed outside trial' } });
  const entries = await JournalEntry.countDocuments();
  await expect(migration.discardRun(runId)).rejects.toThrow('تغير مستند');
  expect(await JournalEntry.countDocuments()).toBe(entries);
  expect((await MigrationRun.findOne({ runId })).status).toBe('review');
  expect((await BankStatementLine.findOne()).lineStatus).toBe('created_entry');
});
test('matches to historical entries are removed on discard even before enabling the bank trial', async () => {
  await runInTransaction(session => postEntry({ eventType: 'MIG', eventKey: 'old', date: '2026-09-05', migrationRunId: runId,
    lines: [{ accountId: bankAccount._id, debit: 700, amountCurrency: 7, currency: 'USD', office: 'turkey' },
      { accountId: (expense)._id, credit: 700, office: 'turkey' }] }, { session }));
  await bank.importStatement(bankAccount._id, [{ day: '2026-09-05', description: 'old deposit', amount: 7 }], {});
  expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
  await migration.discardRun(runId);
  const line = await BankStatementLine.findOne();
  expect(line.lineStatus).toBe('unmatched'); expect(line.matchedEntryIds).toHaveLength(0);
});
test('approval retains bank trial results and clears undo images', async () => {
  await trial.enable(runId);
  await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  const count = await JournalEntry.countDocuments();
  await migration.commitRun(runId);
  expect(await JournalEntry.countDocuments()).toBeGreaterThanOrEqual(count);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('created_entry');
  expect((await MigrationRun.findOne({ runId })).bankTrialEnabled).toBe(false);
  expect(await mongoose.connection.db.collection(trial.LOG).countDocuments()).toBe(0);
});

test('repeated import never duplicates and retained rows can be posted in the next trial', async () => {
  await trial.enable(runId);
  await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  const count = await JournalEntry.countDocuments();
  const again = await scoped(() => bank.importStatement(bankAccount._id, rows(), {}));
  expect(again.count).toBe(0); expect(await JournalEntry.countDocuments()).toBe(count);
  await migration.discardRun(runId);
  const next = 'MIG-BANK-NEXT';
  await MigrationRun.create({ runId: next, status: 'review', cutoff: new Date('2026-10-09T00:00:00Z'), config: { countDay: '2026-08-31' } });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { migrationGuardDay: '2026-10-09' } });
  invalidateConfig();
  await trial.enable(next);
  const line = await BankStatementLine.findOne();
  await scoped(() => runInTransaction(session => bank.createEntryForLine(line._id, rows()[0], { session })));
  expect(await JournalEntry.countDocuments({ bankTrialRunId: next })).toBeGreaterThan(0);
  await migration.discardRun(next);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(1);
});
