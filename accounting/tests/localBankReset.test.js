const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction: tx } = require('../services/transaction');
const { JournalEntry } = require('../models');
const { BankStatementLine, SupplierBill, SupplierPayment } = require('../models/documents');
const { getBalance } = require('../services/carrying');
const bank = require('../services/posting/bank');
const reset = require('../services/posting/localBankReset');
const req = { hostname: 'localhost', socket: { remoteAddress: '127.0.0.1' }, user: { _id: oid(), roles: { isAdmin: true } } };
let source, expense;
const row = (extra = {}) => ({ day: '2026-09-20', description: 'Local rent trial', reference: 'LOCAL-1', amount: -100, ...extra });
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); source = await account('110201'); expense = await account('530200'); });
async function body(extra = {}) {
  const lines = await BankStatementLine.find({ accountId: source._id });
  const input = { accountId: source._id, lineIds: lines.map(l => l._id), ...extra };
  const preview = await reset.preview(input, { req });
  return { ...input, fingerprint: preview.fingerprint, confirm: true, reason: 'Retry the same statement from the beginning' };
}
test('local database and loopback request are required even when a client spoofs localhost', async () => {
  expect(reset.available(req)).toBe(true);
  expect(reset.available({ ...req, hostname: 'exios-admin-qa.web.app' })).toBe(false);
  expect(reset.available({ ...req, socket: { remoteAddress: '203.0.113.7' } })).toBe(false);
  const previous = process.env.EXIOS_QA; process.env.EXIOS_QA = '1';
  expect(reset.available(req)).toBe(false);
  if (previous === undefined) delete process.env.EXIOS_QA; else process.env.EXIOS_QA = previous;
  const connection = require('mongoose').connection;
  const spy = jest.spyOn(connection, 'getClient').mockReturnValue({ options: { hosts: [{ host: 'cloud.invalid' }] } });
  try { expect(reset.available(req)).toBe(false); } finally { spy.mockRestore(); }
});
test('posted trial expenses are reversed and rows deleted; the same statement posts once after reimport', async () => {
  const rows = [row({ counterAccountId: expense._id, office: 'tripoli' })];
  await bank.importStatement(source._id, rows, { req });
  expect((await getBalance(source._id)).usd).toBe(-10000);
  const input = await body();
  const result = await tx(session => reset.reset(input, { session, req }));
  expect(result.deleted).toBe(1); expect(await BankStatementLine.countDocuments()).toBe(0);
  expect((await getBalance(source._id)).usd).toBe(0); expect((await getBalance(expense._id)).usd).toBe(0);
  expect(await SupplierBill.countDocuments({ status: 'canceled' })).toBe(1);
  expect(await SupplierPayment.countDocuments({ status: 'canceled' })).toBe(1);
  expect((await bank.importStatement(source._id, rows, { req })).posted).toBe(1);
  expect((await getBalance(source._id)).usd).toBe(-10000);
});
test('an independently entered payment is retained and available for matching the new import', async () => {
  const entry = await post({ eventType: 'MANUAL', eventKey: 'local:original', date: row().day,
    lines: [{ accountId: expense._id, debit: 10000, office: 'tripoli' }, { accountId: source._id, credit: 10000 }] });
  await bank.importStatement(source._id, [row()], { req }); const input = await body();
  await tx(session => reset.reset(input, { session, req }));
  expect((await JournalEntry.findById(entry._id)).status).toBe('posted');
  expect(await JournalEntry.countDocuments()).toBe(1);
  expect((await bank.importStatement(source._id, [row()], { req })).matched).toBe(1);
});
test('stale preview or missing confirmation cannot delete', async () => {
  await bank.importStatement(source._id, [row()], { req }); const input = await body();
  await expect(tx(session => reset.reset({ ...input, confirm: false }, { session, req }))).rejects.toThrow('أكد');
  await BankStatementLine.updateOne({}, { $set: { description: 'Changed after preview' } });
  await expect(tx(session => reset.reset(input, { session, req }))).rejects.toThrow('تغيرت');
  expect(await BankStatementLine.countDocuments()).toBe(1);
});
test('a cancellation failure rolls back every reversal and preserves every selected row', async () => {
  await bank.importStatement(source._id, [row({ counterAccountId: expense._id, office: 'tripoli' }),
    row({ reference: 'LOCAL-2', amount: -101, counterAccountId: expense._id, office: 'tripoli' })], { req });
  const input = await body(), count = await JournalEntry.countDocuments();
  const original = bank.cancelLineEntry; let n = 0;
  const spy = jest.spyOn(bank, 'cancelLineEntry').mockImplementation((...args) => ++n === 2 ? Promise.reject(new Error('dependent operation blocks cancel')) : original(...args));
  try { await expect(tx(session => reset.reset(input, { session, req }))).rejects.toThrow('dependent operation'); } finally { spy.mockRestore(); }
  expect(await BankStatementLine.countDocuments()).toBe(2); expect(await JournalEntry.countDocuments()).toBe(count);
  expect((await getBalance(source._id)).usd).toBe(-20100);
});
test('copies and remembered fingerprint aliases are removed so the source file can be tried again', async () => {
  await bank.importStatement(source._id, [row()], { req }); const original = await BankStatementLine.findOne();
  await bank.importStatement(source._id, [row({ description: 'PDF converted version' })], { req });
  const copy = await BankStatementLine.findOne({ duplicateReviewPending: true });
  await tx(session => require('../services/posting/bankEvidence').resolve(copy._id, { action: 'same', existingLineId: original._id }, { session, req }));
  const input = await body({ lineIds: [original._id] });
  await tx(session => reset.reset(input, { session, req }));
  expect(await BankStatementLine.countDocuments()).toBe(0);
  expect((await bank.importStatement(source._id, [row({ description: 'PDF converted version' })], { req })).count).toBe(1);
});
test('choosing one member releases the full match group but deletes only the selected row', async () => {
  const entry = await post({ eventType: 'MANUAL', eventKey: 'local:group', date: row().day,
    lines: [{ accountId: expense._id, debit: 10000, office: 'tripoli' }, { accountId: source._id, credit: 10000 }] });
  await bank.importStatement(source._id, [row({ amount: -60 }), row({ amount: -40, reference: 'PART2' })], { req });
  const lines = await BankStatementLine.find(); const group = require('../services/posting/bankGroups');
  const input = { lineIds: lines.map(l => l._id), entryIds: [entry._id] }; const preview = await group.preview(input);
  await tx(session => group.match({ ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'One actual payment represented by two rows' }, { session, req }));
  const resetBody = await body({ lineIds: [lines[0]._id] }); await tx(session => reset.reset(resetBody, { session, req }));
  expect(await BankStatementLine.countDocuments()).toBe(1);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched'); expect((await JournalEntry.findById(entry._id)).status).toBe('posted');
});
