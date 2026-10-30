const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { reverseEntry } = require('../services/ledger');
const { JournalEntry } = require('../models');
const { BankStatementLine, Vendor } = require('../models/documents');
const { HistoricalCashBatch: Batch, HistoricalCashMutex: Mutex } = require('../models/historicalCash');
const cash = require('../services/historicalCash');
const sources = require('../services/historicalCashSources');
const payables = require('../services/posting/payables');
const tx = fn => runInTransaction(fn), req = { user: { _id: oid() } };
const q = { from: '2026-01-01', to: '2026-03-31' };
let bank, expense, seq = 0;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); bank = await account('110101'); expense = await account('530200'); await Mutex.create({ key: 'main' }); });
const out = async (amount = 10000) => post({ eventType: 'SALARY', eventKey: `SOURCE:${++seq}`, date: '2026-01-05', description: 'Office cost',
  lines: [{ accountId: expense._id, debit: amount, office: 'tripoli' }, { accountId: bank._id, credit: amount, office: 'tripoli' }] });
async function bankLine(entry, amount, acct = bank) {
  const { insertedId } = await BankStatementLine.collection.insertOne({ accountId: acct._id, day: '2026-01-05', amount, description: 'Bank source', reference: `B${++seq}`,
    fingerprint: `BANKSOURCE-${seq}`, entryId: entry?._id, lineStatus: entry ? 'matched' : 'unmatched' });
  return insertedId;
}
async function review(row, extra = {}) {
  return tx(session => sources.review({ query: q, key: row.key, fingerprint: row.fingerprint, category: row.category,
    state: 'reviewed', note: 'Reviewed against the original source', ...extra }, { session, req }));
}
async function manual(amount = 100) {
  const data = { requestKey: `MANUAL-SOURCE-KEY-${++seq}`, office: 'tripoli', accountId: String(bank._id), ...q, opening: amount, closing: 0,
    rows: [{ day: '2026-01-05', description: 'Old office cost', direction: 'out', category: 'operating', amount }] };
  const check = await cash.preview(data);
  const result = await tx(session => cash.save({ ...data, fingerprint: check.fingerprint }, null, { session, req }));
  return cash.detail(result._id);
}
const totalOut = report => report.groups.reduce((s, g) => s + g.outgoing, 0);

test('normal paid operations appear without copying them; source changes reopen review and cancellation removes their cash effect', async () => {
  const entry = await out();
  let report = await cash.list(q);
  expect(report.sources.rows).toHaveLength(1); expect(totalOut(report)).toBe(10000);
  expect(await Batch.countDocuments()).toBe(0);
  const before = await JournalEntry.countDocuments();
  await review(report.sources.rows[0]);
  expect(totalOut(await cash.list({ ...q, status: 'approved' }))).toBe(10000);
  expect(await JournalEntry.countDocuments()).toBe(before);
  await JournalEntry.updateOne({ _id: entry._id }, { $set: { description: 'Revised original description' } });
  report = await cash.list(q); expect(report.sources.rows[0]).toMatchObject({ state: 'pending', changedSinceReview: true });
  expect(totalOut(await cash.list({ ...q, status: 'approved' }))).toBe(0);
  await tx(session => reverseEntry(entry._id, { session, user: req.user, reason: 'Cancel original source' }));
  expect(totalOut(await cash.list(q))).toBe(0);
});

test('one ledger payment matched by two bank lines is counted once; unmatched bank cash is also visible', async () => {
  const entry = await out(); await bankLine(entry, -4000); await bankLine(entry, -6000);
  let report = await cash.list(q);
  expect(report.sources.rows.filter(r => r.cash)).toHaveLength(2); expect(totalOut(report)).toBe(10000);
  expect(report.sources.rows.every(r => r.sourceModel === 'BankStatementLine')).toBe(true);
  await bankLine(null, 2500);
  report = await cash.list(q); expect(report.groups.reduce((s, g) => s + g.incoming, 0)).toBe(2500);
});

test('matching one side of an interoffice transfer does not suppress the other cash account leg', async () => {
  const other = await account('110103');
  const entry = await post({ eventType: 'TRANSFER', eventKey: 'TRANSFER:SOURCE', date: '2026-01-05', description: 'Tripoli to Benghazi',
    lines: [{ accountId: bank._id, credit: 4000, office: 'tripoli' }, { accountId: other._id, debit: 4000, office: 'benghazi' }] });
  await bankLine(entry, -4000);
  const report = await cash.list(q);
  expect(report.sources.rows.filter(r => r.cash)).toHaveLength(2);
  expect(report.groups.reduce((s, g) => s + g.net, 0)).toBe(0);
  expect(report.groups.every(g => g.category === 'transfer')).toBe(true);
});

test('links manual and normal versions once; changes/cancellation invalidate the copy instead of doubling final totals', async () => {
  const entry = await out(), batch = await manual();
  let report = await cash.list(q), row = report.sources.rows[0];
  expect(row.candidates).toHaveLength(1);
  await expect(review(row)).rejects.toThrow();
  await review(row, { state: 'linked', batchId: String(batch._id), rowId: String(batch.rows[0]._id) });
  expect(totalOut(await cash.list(q))).toBe(10000);
  await tx(session => cash.changeStatus(batch._id, { action: 'approve', revision: batch.revision, reason: 'Verified original statement' }, { session, req }));
  expect(totalOut(await cash.list({ ...q, status: 'approved' }))).toBe(10000);
  await JournalEntry.updateOne({ _id: entry._id }, { $set: { description: 'Original changed after review' } });
  expect(totalOut(await cash.list(q))).toBe(10000);
  expect(totalOut(await cash.list({ ...q, status: 'approved' }))).toBe(0);
  row = (await cash.list(q)).sources.rows[0];
  await review(row, { state: 'linked', batchId: String(batch._id), rowId: String(batch.rows[0]._id) });
  await tx(session => reverseEntry(entry._id, { session, user: req.user, reason: 'Cancel original' }));
  report = await cash.list(q);
  expect(totalOut(report)).toBe(0); expect(report.sources.rows.some(r => r.orphanLink)).toBe(true);
});

test('manual row IDs survive edits; changing a linked amount never adds both versions into combined totals', async () => {
  await out(); let batch = await manual();
  const row = (await cash.list(q)).sources.rows[0];
  await review(row, { state: 'linked', batchId: String(batch._id), rowId: String(batch.rows[0]._id) });
  const data = { ...cash.rowInput(batch), opening: 120, revision: batch.revision, rows: batch.rows.map(r => ({ ...r, amount: 120 })) };
  const preview = await cash.preview(data, null, { excludeId: batch._id });
  await tx(session => cash.save({ ...data, fingerprint: preview.fingerprint }, null, { session, req, batchId: batch._id }));
  const changed = await cash.detail(batch._id);
  expect(String(changed.rows[0]._id)).toBe(String(batch.rows[0]._id));
  expect(totalOut(await cash.list(q))).toBe(10000);
});

test('unpaid cost documents appear for review without becoming cash payments', async () => {
  const vendor = await Vendor.create({ name: 'Unpaid supplier', type: 'supplier' });
  await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-01-05', currency: 'USD',
    lines: [{ target: 'expense', accountId: expense._id, amount: 100, description: 'Accrued office cost', office: 'tripoli' }] }, { session, req }));
  const report = await cash.list(q);
  expect(report.sources.rows.some(r => r.sourceModel === 'SupplierBill' && !r.cash && !r.contributes)).toBe(true);
  expect(totalOut(report)).toBe(0);
});

test('incomplete bank matches stay flagged and do not duplicate the ledger cash amount', async () => {
  const entry = await out(); await bankLine(entry, -4000);
  const report = await cash.list(q);
  expect(totalOut(report)).toBe(10000);
  expect(report.sources.rows.every(r => r.warning)).toBe(true);
  await expect(review(report.sources.rows.find(r => r.cash && r.contributes))).rejects.toThrow();
  const batch = await manual(40);
  const bankRow = (await cash.list(q)).sources.rows.find(r => r.sourceModel === 'BankStatementLine');
  await expect(review(bankRow, { state: 'linked', batchId: String(batch._id), rowId: String(batch.rows[0]._id) })).rejects.toThrow();
});

test('a linked ledger record can hand over to its later matched bank source without trapping or duplicating the link', async () => {
  const entry = await out(), batch = await manual();
  let row = (await cash.list(q)).sources.rows[0];
  const linked = { state: 'linked', batchId: String(batch._id), rowId: String(batch.rows[0]._id) };
  await review(row, linked);
  await bankLine(entry, -10000);
  let report = await cash.list(q);
  row = report.sources.rows.find(r => r.sourceModel === 'BankStatementLine');
  expect(totalOut(report)).toBe(10000);
  await review(row, linked);
  report = await cash.list(q);
  expect(totalOut(report)).toBe(10000);
  expect(report.sources.rows.some(r => r.orphanLink)).toBe(false);
  expect(report.sources.rows[0].state).toBe('linked');
});

test('foreign bank matching compares native minor units, never adds dollar valuation to the native cash total', async () => {
  bank = await account('110102');
  const entry = await post({ eventType: 'SALARY', eventKey: 'LYD:SOURCE', date: '2026-01-05', description: 'LYD office expense',
    lines: [{ accountId: expense._id, debit: 10000, office: 'tripoli' }, { accountId: bank._id, credit: 10000, currency: 'LYD', amountCurrency: -900000, rate: 9, office: 'tripoli' }] });
  await bankLine(entry, -900000);
  const report = await cash.list(q);
  expect(report.groups).toHaveLength(1);
  expect(report.groups[0]).toMatchObject({ currency: 'LYD', decimals: 3, outgoing: 900000 });
  expect(report.sources.rows).toHaveLength(1);
});
