const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction: tx } = require('../services/transaction');
const { JournalEntry } = require('../models');
const { BankStatementLine, Vendor, SupplierBill } = require('../models/documents');
const bank = require('../services/posting/bank');
const groups = require('../services/posting/bankGroups');
const evidence = require('../services/posting/bankEvidence');
const review = require('../services/posting/bankReviewTools');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let source, expense;
const day = '2026-09-20';
const row = (extra = {}) => ({ day, amount: -100, reference: 'BANK-001', description: 'Rent', ...extra });
const importRows = rows => bank.importStatement(source._id, rows, { req });
const entry = (amount = 10000, extra = {}) => post({ eventType: 'MANUAL', eventKey: `improve:${oid()}`, date: day,
  lines: [{ accountId: expense._id, debit: amount, office: 'tripoli' }, { accountId: source._id, credit: amount }], ...extra });
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); source = await account('110201'); expense = await account('530200'); });
test('description changes with the same reference are retained for review and cannot post twice', async () => {
  await importRows([row({ counterAccountId: expense._id, office: 'tripoli' })]);
  const changed = row({ description: 'Rent from converted PDF', counterAccountId: expense._id, office: 'tripoli' });
  expect((await bank.classifyRows(source._id, [changed]))[0].status).toBe('possibleImported');
  const result = await importRows([changed]); expect(result.posted).toBe(0); expect(result.notPosted).toHaveLength(1);
  const line = await BankStatementLine.findOne({ duplicateReviewPending: true });
  const existingEntry = await JournalEntry.findOne();
  await expect(tx(session => bank.manualMatch(line._id, [existingEntry._id], { session, req }))).rejects.toThrow();
  expect(await SupplierBill.countDocuments()).toBe(1);
});
test('same-operation review merges fingerprints, preserves evidence, and future exports do not reimport', async () => {
  await importRows([row()]); const original = await BankStatementLine.findOne();
  await importRows([row({ description: 'Translated rent description' })]);
  const pending = await BankStatementLine.findOne({ duplicateReviewPending: true });
  await tx(session => evidence.resolve(pending._id, { action: 'same', existingLineId: original._id }, { session, req }));
  expect((await BankStatementLine.findById(pending._id)).lineStatus).toBe('ignored');
  expect((await importRows([row({ description: 'Translated rent description' })])).count).toBe(0);
  await expect(tx(session => bank.setIgnored(pending._id, false, { session, req }))).rejects.toThrow('نسخة');
  expect(await JournalEntry.countDocuments()).toBe(0);
});
test('shared bank references may represent independent transactions after review', async () => {
  await importRows([row()]); await importRows([row({ description: 'Another rent payment' })]);
  const line = await BankStatementLine.findOne({ duplicateReviewPending: true });
  await expect(tx(session => evidence.resolve(line._id, { action: 'independent', reason: 'short' }, { session, req }))).rejects.toThrow();
  await tx(session => evidence.resolve(line._id, { action: 'independent', reason: 'Separate receipt for a second office rent' }, { session, req }));
  expect((await BankStatementLine.findById(line._id)).duplicateReviewPending).toBe(false);
});
test('different references or amounts are not merged by changed descriptions', async () => {
  await importRows([row()]);
  const rows = [row({ reference: 'BANK-002', description: 'Other text' }), row({ amount: -101, description: 'Other amount' })];
  expect((await bank.classifyRows(source._id, rows)).every(r => r.status !== 'possibleImported')).toBe(true);
});
test('changed descriptions sharing one reference inside the same file are held for review', async () => {
  const rows = [row(), row({ description: 'Converted duplicate row' })];
  expect((await bank.classifyRows(source._id, rows))[1].status).toBe('possibleImported');
  await importRows(rows);
  expect(await BankStatementLine.countDocuments({ duplicateReviewPending: true })).toBe(1);
  const pending = await BankStatementLine.findOne({ duplicateReviewPending: true });
  const original = await BankStatementLine.findOne({ duplicateReviewPending: { $ne: true } });
  await tx(session => evidence.resolve(pending._id, { action: 'same', existingLineId: original._id }, { session, req }));
  expect((await BankStatementLine.findById(pending._id)).lineStatus).toBe('ignored');
});
test('several pending variants display distinct original candidates without duplicate rows', async () => {
  for (const description of ['Original rent', 'PDF rent', 'Translated rent']) await importRows([row({ description })]);
  const hints = await bank.suggestions(source._id);
  for (const hint of Object.values(hints).filter(h => h.source === 'statement_repeat')) {
    const ids = hint.statementDuplicates.map(l => String(l._id));
    expect(new Set(ids).size).toBe(ids.length);
  }
});
test('strong-only automatic matching leaves amount/date similarities for review', async () => {
  await entry(); await importRows([row()]);
  const line = await BankStatementLine.findOne();
  await tx(session => bank.setIgnored(line._id, false, { session, req }));
  expect((await tx(session => bank.autoMatch(source._id, { session, req, matchingSettings: { strongLedgerOnly: true } }))).matched).toBe(0);
  const hints = await bank.suggestions(source._id, { matchingSettings: { strongLedgerOnly: true } });
  const hint = Object.values(hints)[0]; expect(hint.matchQuality.level).toBe('review'); expect(hint.exactMatch).toBeUndefined();
});
test('a trusted explicit journal reference permits strong automatic matching', async () => {
  const posted = await entry();
  await JournalEntry.updateOne({ _id: posted._id }, { $set: { bankSourceAccountId: source._id, bankSourceReference: 'BANK-001' } });
  const result = await bank.importStatement(source._id, [row()], { req, matchingSettings: { strongLedgerOnly: true } });
  expect(result.matched).toBe(1);
});
test('a known conflicting reference cannot be automatically or manually matched', async () => {
  const posted = await entry(); await JournalEntry.updateOne({ _id: posted._id }, { $set: { bankSourceAccountId: source._id, bankSourceReference: 'DIFFERENT' } });
  expect((await importRows([row()])).matched).toBe(0);
  const line = await BankStatementLine.findOne();
  await expect(tx(session => bank.manualMatch(line._id, [posted._id], { session, req }))).rejects.toThrow('مرجع');
});
async function groupFixture(amounts = [-60, -40], ledger = [10000]) {
  const entries = []; for (const amount of ledger) entries.push(await entry(amount));
  await bank.importStatement(source._id, amounts.map((amount, i) => row({ amount, reference: `GROUP-${i}` })), { req, matchingSettings: { engines: [] } });
  const lines = await BankStatementLine.find();
  return { lineIds: lines.map(l => l._id), entryIds: entries.map(e => e._id) };
}
test('one payment matches two bank lines with no new journal and can be fully unmatched from either line', async () => {
  const input = await groupFixture(); const preview = await groups.preview(input);
  expect(preview.difference).toBe(0);
  await tx(session => groups.match({ ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'One bank transfer split over two lines' }, { session, req }));
  expect(await JournalEntry.countDocuments()).toBe(1); expect(await BankStatementLine.countDocuments({ lineStatus: 'matched' })).toBe(2);
  expect((await review.integrity(source._id)).results).toEqual([]);
  await tx(session => bank.setIgnored(input.lineIds[0], false, { session, req }));
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(2);
  expect((await bank.unmatchedMovements(source._id)).length).toBe(1);
});
test('several entries and several lines can form one group', async () => {
  const input = await groupFixture([-60, -40], [2000, 3000, 5000]); const preview = await groups.preview(input);
  await tx(session => groups.match({ ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'Three actual payments shown in two bank lines' }, { session, req }));
  expect((await review.integrity(source._id)).results).toHaveLength(0);
  expect(await JournalEntry.countDocuments()).toBe(3);
});
test('a difference, unreviewed decision, or stale preview cannot be approved', async () => {
  const input = await groupFixture([-60, -39]); const preview = await groups.preview(input);
  await expect(tx(session => groups.match({ ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'Difference must be recorded separately' }, { session, req }))).rejects.toThrow('غير متساو');
  await expect(tx(session => groups.match({ ...input, fingerprint: 'stale', confirmReviewed: true, reason: 'Reviewed group of actual bank payments' }, { session, req }))).rejects.toThrow('تغيرت');
  await expect(tx(session => groups.match({ ...input, fingerprint: preview.fingerprint }, { session, req }))).rejects.toThrow('راجع');
});
test('opposite signs, other accounts and repeated selection IDs cannot be grouped', async () => {
  const input = await groupFixture([-60, 40]); await expect(groups.preview(input)).rejects.toThrow('الوارد');
  await expect(groups.preview({ ...input, lineIds: [input.lineIds[0], input.lineIds[0]] })).rejects.toThrow('مختلف');
  const other = await account('110202'); await BankStatementLine.updateOne({ _id: input.lineIds[1] }, { $set: { accountId: other._id } });
  await expect(groups.preview(input)).rejects.toThrow('نفس الحساب');
});
test('Alipay and supplier refunds cannot bypass their original matching flow through generic groups', async () => {
  const input = await groupFixture();
  await BankStatementLine.updateOne({ _id: input.lineIds[0] }, { $set: { sourceProvider: 'alipay' } });
  await expect(groups.preview(input)).rejects.toThrow('مسارها الأصلي');
  await BankStatementLine.updateOne({ _id: input.lineIds[0] }, { $unset: { sourceProvider: 1 }, $set: { movementKind: 'purchase_refund' } });
  await expect(groups.preview(input)).rejects.toThrow('مسارها الأصلي');
});
test('concurrent group approval claims the journal once', async () => {
  const input = await groupFixture(); const preview = await groups.preview(input);
  const body = { ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'Same bank group reviewed before approval' };
  const result = await Promise.allSettled([1, 2].map(() => tx(session => groups.match(body, { session, req }))));
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await JournalEntry.countDocuments()).toBe(1);
});
test('canceling a journal in a group reopens all lines and releases the surviving reservations', async () => {
  const input = await groupFixture([-60, -40], [6000, 4000]); const preview = await groups.preview(input);
  await tx(session => groups.match({ ...input, fingerprint: preview.fingerprint, confirmReviewed: true, reason: 'Two payments over two bank rows' }, { session, req }));
  await tx(session => require('../services/manualEntry').cancelManualEntry(input.entryIds[0], { session, req, reason: 'Wrong payment' }));
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(2);
  expect((await bank.unmatchedMovements(source._id)).length).toBe(1);
});
test('integrity review detects a historical stale link and releases it without extra financial journals', async () => {
  const posted = await entry(); await importRows([row()]);
  await JournalEntry.updateOne({ _id: posted._id }, { $set: { status: 'reversed' } });
  const check = await review.integrity(source._id); expect(check.results[0].canRelease).toBe(true);
  await tx(session => review.releaseInvalid({ accountId: source._id, lineId: check.results[0].lineId, fingerprint: check.results[0].fingerprint, reason: 'Old match references an already cancelled entry' }, { session, req }));
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched'); expect(await JournalEntry.countDocuments()).toBe(1);
});
test('an amount discrepancy in a live journal is displayed but not silently reversed', async () => {
  const posted = await entry(); await importRows([row()]);
  await BankStatementLine.updateOne({}, { $set: { amount: -9900 } });
  const check = await review.integrity(source._id); expect(check.results[0].canRelease).toBe(false);
  await expect(tx(session => review.releaseInvalid({ accountId: source._id, lineId: check.results[0].lineId, fingerprint: check.results[0].fingerprint, reason: 'Investigate different bank amount' }, { session, req }))).rejects.toThrow();
  expect((await JournalEntry.findById(posted._id)).status).toBe('posted');
});
test('quick expenses find manual or legacy expense costs from the same source account', async () => {
  await entry(); const vendor = await Vendor.findOne({ seedKey: 'cash_expenses' });
  const input = { vendorId: vendor._id, day, currency: 'USD', paidImmediatelyFrom: source._id, isQuickExpense: true,
    lines: [{ target: 'expense', description: 'Rent', amount: 100, accountId: expense._id, office: 'tripoli' }] };
  const preview = await require('../services/costDuplicates').preview(input); expect(preview.results[0].entryId).toBeTruthy();
  await expect(tx(session => require('../services/posting/payables').createBill(input, { session, req }))).rejects.toThrow('تكلفة محتملة');
});
test('late expense suggestion lists the unposted statement and does not post or match while reading', async () => {
  await importRows([row()]); const vendor = await Vendor.findOne({ seedKey: 'cash_expenses' });
  const bill = await tx(session => require('../services/posting/payables').createBill({ vendorId: vendor._id, day, currency: 'USD', paidImmediatelyFrom: source._id,
    lines: [{ target: 'expense', description: 'Rent', amount: 100, accountId: expense._id, office: 'tripoli' }] }, { session, req }));
  const count = await JournalEntry.countDocuments(); const hint = await review.lateExpense(bill._id);
  expect(hint.results).toHaveLength(1); expect(await JournalEntry.countDocuments()).toBe(count);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched');
});
