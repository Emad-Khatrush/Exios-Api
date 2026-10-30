const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction: tx } = require('../services/transaction');
const { JournalEntry, CurrencyRate } = require('../models');
const { BankStatementLine, SupplierBill, SupplierPayment, Vendor } = require('../models/documents');
const { getBalance } = require('../services/carrying');
const bank = require('../services/posting/bank');
const payables = require('../services/posting/payables');
const duplicates = require('../services/costDuplicates');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let source, expense, vendor;
const day = '2026-09-20';
const row = (extra = {}) => ({ day, amount: -100, description: 'Office rent', reference: 'RENT-SEP', ...extra });
const input = (extra = {}) => ({ vendorId: vendor._id, day, currency: 'USD', isQuickExpense: true,
  paidImmediatelyFrom: source._id,
  lines: [{ description: 'Office rent', target: 'expense', accountId: expense._id, office: 'tripoli', amount: 100 }], ...extra });
const bill = extra => tx(session => payables.createBill(input(extra), { session, req }));
const importRow = extra => bank.importStatement(source._id, [row(extra)], { req });
const auto = () => tx(session => bank.autoMatch(source._id, { session, req }));
const onlyLine = () => BankStatementLine.findOne({ accountId: source._id });
async function expectOnce() {
  expect((await getBalance(source._id)).usd).toBe(-10000);
  expect((await getBalance(expense._id)).usd).toBe(10000);
  expect(await SupplierBill.countDocuments({ status: 'posted' })).toBe(1);
  expect(await SupplierPayment.countDocuments({ status: 'posted' })).toBe(1);
}
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  source = await account('110201'); expense = await account('530200');
  vendor = await Vendor.findOne({ seedKey: 'cash_expenses' });
});

test('expense first, statement second: links payment without a second cost or cash outflow', async () => {
  const original = await bill();
  expect((await importRow()).matched).toBe(1);
  expect((await onlyLine()).matchedEntryIds.map(String)).toEqual([String((await SupplierPayment.findById(original.paymentId)).entryId)]);
  await expectOnce();
});
test('statement first (unposted), expense second: automatic-match action links the later expense', async () => {
  expect((await importRow()).matched).toBe(0);
  await bill();
  expect((await onlyLine()).lineStatus).toBe('unmatched');
  expect((await auto()).matched).toBe(1);
  expect((await auto()).matched).toBe(0);
  await expectOnce();
});
test('reimport after late expense also reruns matching for already imported rows', async () => {
  await importRow(); await bill();
  expect((await importRow()).matched).toBe(1);
  await expectOnce();
});
test('posted statement first, quick expense second: exposes existing cost even with a different vendor', async () => {
  expect((await importRow({ counterAccountId: expense._id, office: 'tripoli', vendorName: 'Actual landlord' })).posted).toBe(1);
  await expect(bill()).rejects.toThrow('تكلفة محتملة');
  await expectOnce();
});
test('same quick expense twice is reviewed; an explicitly independent transaction may proceed', async () => {
  await bill();
  await expect(bill()).rejects.toThrow('تكلفة محتملة');
  const preview = await duplicates.preview(input());
  expect(preview.results).toHaveLength(1);
  await bill({ duplicateDecision: 'independent', duplicateReason: 'Separate rental payment supported by another receipt', duplicateFingerprint: preview.fingerprint });
  expect((await getBalance(source._id)).usd).toBe(-20000);
});
test('quick expenses with another amount, expense account, office or cash account remain distinct', async () => {
  await bill();
  const otherAccount = await account('530800'), otherCash = await account('110202');
  for (const patch of [
    { lines: [{ ...input().lines[0], amount: 101 }] },
    { lines: [{ ...input().lines[0], accountId: otherAccount._id }] },
    { lines: [{ ...input().lines[0], office: 'benghazi' }] },
    { paidImmediatelyFrom: otherCash._id },
  ]) expect((await duplicates.preview(input(patch))).results).toHaveLength(0);
});
test.each([-4, 4])('date outside the automatic window (%s days) requires manual matching', async delta => {
  await bill({ day: `2026-09-${20 + delta}` }); await importRow();
  expect((await onlyLine()).lineStatus).toBe('unmatched');
  const payment = await SupplierPayment.findOne();
  const line = await onlyLine();
  await tx(session => bank.manualMatch(line._id, [payment.entryId], { session, req }));
  await expectOnce();
});
test('different amounts and opposite signs are not matched', async () => {
  await bill(); await importRow({ amount: -99 }); await importRow({ amount: 100, reference: 'INCOMING' });
  expect(await BankStatementLine.countDocuments({ lineStatus: 'matched' })).toBe(0);
});
test('an expense paid from another bank is not matched', async () => {
  await bill({ paidImmediatelyFrom: (await account('110202'))._id }); await importRow();
  expect((await onlyLine()).lineStatus).toBe('unmatched');
});
test('two plausible ledger movements require a choice', async () => {
  await bill(); await bill({ paidImmediatelyFrom: source._id, lines: [{ ...input().lines[0], office: 'benghazi' }] });
  await importRow(); expect((await onlyLine()).lineStatus).toBe('unmatched');
});
test('two statement lines cannot compete for one payment', async () => {
  await bill();
  const result = await bank.importStatement(source._id, [row(), row({ reference: 'OTHER-RENT' })], { req });
  expect(result.matched).toBe(0);
  const lines = await BankStatementLine.find(); const payment = await SupplierPayment.findOne();
  await tx(session => bank.manualMatch(lines[0]._id, [payment.entryId], { session, req }));
  await expect(tx(session => bank.manualMatch(lines[1]._id, [payment.entryId], { session, req }))).rejects.toThrow();
  await expectOnce();
});
test('repeating an imported and posted file neither duplicates bills nor payments', async () => {
  const values = { counterAccountId: expense._id, office: 'tripoli' };
  await importRow(values); const again = await importRow(values);
  expect(again.count).toBe(0); expect(again.posted).toBe(0); await expectOnce();
});
test('concurrent imports retain one statement row', async () => {
  await Promise.allSettled([importRow(), importRow()]);
  expect(await BankStatementLine.countDocuments()).toBe(1);
});
test('simultaneous approval clicks create one expense and one payment', async () => {
  await importRow(); const line = await onlyLine();
  const results = await Promise.allSettled([1, 2].map(() => tx(session => bank.createEntryForLine(line._id,
    { counterAccountId: expense._id, office: 'tripoli' }, { session, req }))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); await expectOnce();
});
test('canceling a matched payment returns the statement to review and a replacement can match', async () => {
  const original = await bill(); await importRow();
  await tx(session => require('../services/cancel').cancelDocument('AccountingSupplierPayment', original.paymentId, { session, req, reason: 'Wrong bank payment' }));
  expect((await onlyLine()).lineStatus).toBe('unmatched');
  expect((await getBalance(source._id)).usd).toBe(0);
  await tx(session => payables.createPayment({ vendorId: vendor._id, day, fromAccountId: source._id, amount: 100,
    allocations: [{ billId: original._id, amountUsd: 10000 }] }, { session, req }));
  expect((await auto()).matched).toBe(1); await expectOnce();
});
test('one statement total can match three existing ledger payments', async () => {
  const entries = [];
  for (const [i, amount] of [2000, 3000, 5000].entries()) entries.push(await post({ eventType: 'MANUAL', eventKey: `group:${i}`, date: day,
    lines: [{ accountId: expense._id, debit: amount, office: 'tripoli' }, { accountId: source._id, credit: amount }] }));
  await importRow();
  const line = await onlyLine();
  await tx(session => bank.manualMatch(line._id, entries.map(e => e._id), { session, req }));
  expect((await onlyLine()).matchedEntryIds).toHaveLength(3);
  expect(await JournalEntry.countDocuments()).toBe(3);
  expect((await getBalance(source._id)).usd).toBe(-10000);
});
test('one ledger payment cannot be incorrectly linked in full to only part of its statement amount', async () => {
  const original = await bill(); const payment = await SupplierPayment.findById(original.paymentId);
  await importRow({ amount: -60 });
  const line = await onlyLine();
  await expect(tx(session => bank.manualMatch(line._id, [payment.entryId], { session, req }))).rejects.toThrow('لا يساوي');
});
test('a missing foreign exchange rate leaves an unposted row and no partial cost', async () => {
  const foreign = await account('110204');
  const result = await bank.importStatement(foreign._id, [row({ counterAccountId: expense._id, office: 'tripoli' })], { req });
  expect(result.posted).toBe(0); expect(result.notPosted).toHaveLength(1);
  expect(await SupplierBill.countDocuments()).toBe(0); expect(await JournalEntry.countDocuments()).toBe(0);
});
test('foreign matching uses native money regardless of a later different daily rate', async () => {
  source = await account('110204');
  await CurrencyRate.create({ day, currency: 'TRY', rate: 40 });
  await bill({ currency: 'TRY' });
  await CurrencyRate.create({ day: '2026-09-21', currency: 'TRY', rate: 50 });
  expect((await importRow({ day: '2026-09-21' })).matched).toBe(1);
  expect((await getBalance(source._id)).foreign).toBe(-10000);
  expect((await getBalance(expense._id)).usd).toBe(250);
});
test('ignored rows survive reimport without being posted', async () => {
  await importRow({ ignore: true }); await importRow({ counterAccountId: expense._id, office: 'tripoli' });
  expect((await onlyLine()).lineStatus).toBe('ignored'); expect(await JournalEntry.countDocuments()).toBe(0);
});

test('canceling a transfer releases both banks and preserves its history', async () => {
  const target = await account('110202');
  const transfer = await tx(session => require('../services/posting/treasury').createTransfer({ day,
    fromAccountId: source._id, fromAmount: 100, toAccountId: target._id, toAmount: 100 }, { session, req }));
  await importRow();
  await bank.importStatement(target._id, [row({ amount: 100, description: 'Transfer received' })], { req });
  expect(await BankStatementLine.countDocuments({ lineStatus: 'matched' })).toBe(2);
  await tx(session => require('../services/cancel').cancelDocument('AccountingTreasuryTransfer', transfer._id, { session, req, reason: 'Incorrect transfer' }));
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(2);
  expect((await getBalance(source._id)).usd).toBe(0);
  expect((await getBalance(target._id)).usd).toBe(0);
  expect((await onlyLine()).historyEntryIds.length).toBeGreaterThan(0);
});
test('canceling a matched manual entry reopens the statement without a stale match', async () => {
  const entry = await post({ eventType: 'MANUAL', eventKey: 'manual:cancel-match', date: day,
    lines: [{ accountId: expense._id, debit: 10000, office: 'tripoli' }, { accountId: source._id, credit: 10000 }] });
  await importRow(); expect((await onlyLine()).lineStatus).toBe('matched');
  await tx(session => require('../services/manualEntry').cancelManualEntry(entry._id, { session, req, reason: 'Incorrect manual expense' }));
  expect((await onlyLine()).lineStatus).toBe('unmatched');
  expect((await getBalance(source._id)).usd).toBe(0);
  expect((await auto()).matched).toBe(0);
});
test('canceling one payment in a grouped match releases the other reservations for a corrected group', async () => {
  const one = await bill({ lines: [{ ...input().lines[0], amount: 40 }] });
  const two = await bill({ lines: [{ ...input().lines[0], amount: 60 }] });
  await importRow(); const line = await onlyLine();
  const payments = await SupplierPayment.find({ _id: { $in: [one.paymentId, two.paymentId] } });
  await tx(session => bank.manualMatch(line._id, payments.map(p => p.entryId), { session, req }));
  await tx(session => require('../services/cancel').cancelDocument('AccountingSupplierPayment', one.paymentId,
    { session, req, reason: 'Correct partial payment' }));
  expect((await onlyLine()).lineStatus).toBe('unmatched');
  const remaining = payments.find(p => String(p._id) === String(two.paymentId));
  expect((await JournalEntry.findById(remaining.entryId)).bankMatchedAccounts).not.toContainEqual(source._id);
});
test('disabling matching engines does not disable duplicate protection or silently link a later payment', async () => {
  await bill();
  expect((await bank.importStatement(source._id, [row()], { req, matchingSettings: { engines: [] } })).matched).toBe(0);
  const line = await onlyLine();
  await expect(tx(session => bank.createEntryForLine(line._id, { counterAccountId: expense._id, office: 'tripoli' }, { session, req }))).rejects.toThrow('مسجلاً في الدفاتر');
  await expectOnce();
});
test('a stale or unexplained independent-expense decision is refused', async () => {
  await bill(); const preview = await duplicates.preview(input());
  for (const extra of [{ duplicateFingerprint: 'stale', duplicateReason: 'A different expense with supporting evidence' },
    { duplicateFingerprint: preview.fingerprint, duplicateReason: 'short' }]) {
    await expect(bill({ duplicateDecision: 'independent', ...extra })).rejects.toThrow('تكلفة محتملة');
  }
  await expectOnce();
});
test('simultaneous quick expenses with separate request keys cannot silently pay twice', async () => {
  const result = await Promise.allSettled([bill({ idempotencyKey: `quick:${oid()}` }), bill({ idempotencyKey: `quick:${oid()}` })]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); await expectOnce();
});
test('a posted statement expense in a different original currency still protects a quick expense paid in bank currency', async () => {
  source = await account('110204');
  await CurrencyRate.create({ day, currency: 'TRY', rate: 40 });
  expect((await importRow({ counterAccountId: expense._id, office: 'tripoli', originalCurrency: 'USD', originalAmount: 2.5 })).posted).toBe(1);
  await expect(bill({ currency: 'TRY' })).rejects.toThrow('تكلفة محتملة');
  expect((await getBalance(source._id)).foreign).toBe(-10000);
});
