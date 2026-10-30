const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { MigrationRun, JournalEntry, CurrencyRate, AccountingSettings } = require('../models');
const { Vendor, SupplierBill, BankStatementLine } = require('../models/documents');
const { invalidateConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { postEntry } = require('../services/ledger');
const service = require('../services/posting/purchaseReconciliation');
const review = require('../services/posting/bankPurchaseReview');
const payables = require('../services/posting/payables');
const bank = require('../services/posting/bank');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
let source, vendor;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  source = await account('110204');
  vendor = await Vendor.findOne({ name: 'Alibaba' }) || await Vendor.create({ name: 'Alibaba', type: 'supplier', bankAliases: ['alibaba.com'] });
  await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 50 });
  await MigrationRun.create({ runId: 'PURCHASE-OPENING', status: 'committed', cutoff: new Date('2026-10-05T12:00:00Z'),
    config: { countDay: '2026-08-31', openingCounts: [{ accountId: source._id, amount: 5000 }] } });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { cutoffAt: new Date('2026-10-05T12:00:00Z') } });
  invalidateConfig();
  const opening = await account('390000');
  await tx(session => postEntry({ eventType: 'OPENING_CASH', eventKey: 'REAL-OPENING', date: '2026-08-31',
    lines: [{ accountId: source._id, debit: 10000, currency: 'TRY', amountCurrency: 500000, office: 'turkey' },
      { accountId: opening._id, credit: 10000, office: 'turkey' }] }, { session }));
});

async function line(amount = 20, day = '2026-05-01', extra = {}) {
  return BankStatementLine.create({ accountId: source._id, day, description: 'Alibaba.com Luxembourg', amount: -Math.round(amount * 50 * 100),
    originalAmount: amount, originalCurrency: 'USD', ...extra });
}
async function recorded(amount = 20, day = '2026-05-01') {
  const cost = await account('510400');
  return tx(session => payables.createBill({ vendorId: vendor._id, day, currency: 'USD', isHistorical: true, paidBeforeCount: true,
    lines: [{ target: 'expense', accountId: cost._id, office: 'turkey', description: 'Old completed purchase', amount }] }, { session, req }));
}
const settle = ids => tx(session => service.settleHistorical({ accountId: source._id, lineIds: ids.map(String), office: 'turkey',
  reason: 'Reviewed historical completed purchases', confirmCompleted: true }, { session, req }));

test('historical settlement keeps original month, leaves opening cash untouched and is not reposted', async () => {
  const before = await getBalance(source._id);
  const old = await line();
  const preview = await service.historicalRows({ accountId: source._id });
  expect(preview.results[0].eligible).toBe(true);
  expect(await settle([old._id])).toMatchObject({ posted: 1, totalUsd: 2000, bankChanged: false });
  expect(await getBalance(source._id)).toEqual(before);
  const saved = await BankStatementLine.findById(old._id).lean();
  const entry = await JournalEntry.findById(saved.entryId).lean();
  expect(entry.day).toBe('2026-05-01');
  expect(entry.lines.some(l => String(l.accountId) === String(source._id))).toBe(false);
  expect(entry.lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(0);
  await expect(settle([old._id])).rejects.toThrow('غير متاحة');
});

test('existing paid historical bill blocks new cost; matching adds no journals or bank movement', async () => {
  const bill = await recorded(); const old = await line();
  expect((await service.historicalRows({ accountId: source._id })).results[0].eligible).toBe(false);
  await expect(settle([old._id])).rejects.toThrow('محتملة مسجلة');
  const entries = await JournalEntry.countDocuments(), balance = await getBalance(source._id);
  await tx(session => review.matchPurchase(old._id, { kind: 'bill', billId: bill._id }, { session, req }));
  expect(await JournalEntry.countDocuments()).toBe(entries);
  expect(await getBalance(source._id)).toEqual(balance);
  const rows = await service.list({ source: 'all', status: 'all' });
  expect(rows.results[0]).toMatchObject({ status: 'linked', matchedUsd: 2000, remainingUsd: 0 });
  await tx(session => bank.setIgnored(old._id, false, { session, req }));
  expect((await service.list({ source: 'all' })).results[0].status).toBe('unlinked');
});

test('a later historical invoice replaces the statement-only cost by reversal, not a second net cost', async () => {
  const old = await line(); await settle([old._id]); const bill = await recorded();
  expect((await service.statementCandidates({ billId: String(bill._id) })).results[0].historicalPurchase).toBe(true);
  await tx(session => review.matchPurchase(old._id, { kind: 'bill', billId: bill._id }, { session, req }));
  const cost = await account('510400');
  const entries = await JournalEntry.find().lean();
  const net = entries.flatMap(e => e.lines).filter(l => String(l.accountId) === String(cost._id)).reduce((s, l) => s + l.debit - l.credit, 0);
  expect(net).toBe(2000);
  expect((await BankStatementLine.findById(old._id)).historicalCovered).toBe(true);
});

test('September, refunds, unknown merchants and uncounted accounts cannot enter historical settlement', async () => {
  const current = await line(20, '2026-09-01');
  await expect(settle([current._id])).rejects.toThrow('بعد تاريخ الجرد');
  const incoming = await line(30, '2026-05-01', { amount: 150000 });
  await expect(settle([incoming._id])).rejects.toThrow('غير متاحة');
  const unknown = await line(40, '2026-05-01', { description: 'Unidentified transfer' });
  await expect(settle([unknown._id])).rejects.toThrow('غير معروفة');
  await expect(service.historicalRows({ accountId: String((await account('110102'))._id) })).rejects.toThrow('جرد افتتاحي');
});

test('closed historical periods are rejected instead of moving expense to September', async () => {
  const old = await line();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-08-31' } }); invalidateConfig();
  await expect(settle([old._id])).rejects.toThrow('الفترة مقفلة');
  expect((await BankStatementLine.findById(old._id)).lineStatus).toBe('unmatched');
});

test('all dates remain searchable and historical lists paginate beyond blocked first-page rows', async () => {
  await recorded(20);
  await BankStatementLine.insertMany(Array.from({ length: 51 }, (_, i) => ({ accountId: source._id, day: '2026-05-01', description: `Alibaba.com ${i}`, amount: -100000, originalAmount: 20, originalCurrency: 'USD' })));
  const last = await line(21, '2026-06-01');
  const next = await service.historicalRows({ accountId: source._id, page: 2 });
  expect(next.total).toBe(52); expect(next.results.some(r => String(r._id) === String(last._id) && r.eligible)).toBe(true);
  const bill = await recorded(21, '2026-04-01');
  expect((await service.statementCandidates({ billId: String(bill._id) })).results.some(r => String(r._id) === String(last._id))).toBe(true);
});

test('payment entry matches produce partial and full status without creating another invoice', async () => {
  const expense = await account('530800');
  const bill = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-09-01', currency: 'USD',
    lines: [{ target: 'expense', accountId: expense._id, office: 'turkey', description: 'Live purchase', amount: 100 }] }, { session, req }));
  const parts = [];
  for (const day of ['2026-09-02', '2026-09-03']) {
    const payment = await tx(session => payables.createPayment({ vendorId: vendor._id, fromAccountId: source._id, day, amount: 2500, rate: 50,
      allocations: [{ billId: bill._id, amountUsd: 5000 }] }, { session, req }));
    parts.push({ payment, line: await line(50, day) });
  }
  expect((await service.list({ source: 'all', period: 'current' })).summary.unlinked).toBe(1);
  await tx(session => bank.manualMatch(parts[0].line._id, [parts[0].payment.entryId], { session, req }));
  expect((await service.list({ source: 'all', status: 'all' })).results[0]).toMatchObject({ status: 'partial', matchedUsd: 5000, remainingUsd: 5000 });
  await tx(session => bank.manualMatch(parts[1].line._id, [parts[1].payment.entryId], { session, req }));
  expect((await service.list({ source: 'all', status: 'all' })).results[0]).toMatchObject({ status: 'linked', matchedUsd: 10000, remainingUsd: 0 });
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect((await service.list({ source: 'all', period: 'historical' })).total).toBe(0);
});
