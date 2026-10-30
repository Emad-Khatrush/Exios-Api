// Synthetic volume in an isolated replica set; timings describe this machine only.
const { performance } = require('perf_hooks');
const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { AccountingSettings, AccountingEvent, JournalEntry } = require('../models');
const { invalidateConfig } = require('../services/config');
const { accountTotals } = require('../services/balances');
const { incomeStatement, balanceSheet, cashFlow } = require('../services/reports/statements');
const { runChecks } = require('../services/reports/exceptions');
const { HANDLERS, processQueue } = require('../services/events');
const { postEntry } = require('../services/ledger');

jest.setTimeout(180000);
beforeAll(startDb);
afterAll(stopDb);
afterEach(() => { delete HANDLERS.stage9Volume; });

test('10,000 journals and 10,100 events: reports agree and queue batches preserve the remaining work', async () => {
  await resetDb();
  const cash = await account('110101'), capital = await account('310000');
  const input = { eventType: 'MANUAL', date: '2026-03-01', description: 'Synthetic capital receipt', lines: [{ accountId: cash._id, debit: 100 }, { accountId: capital._id, credit: 100 }] };
  const sample = (await post({ ...input, eventKey: 'VOLUME:TEMPLATE' })).toObject();
  await JournalEntry.deleteMany({});
  await JournalEntry.collection.insertMany(Array.from({ length: 10000 }, (_, i) => ({ ...sample, _id: oid(), eventKey: `VOLUME:${i}`, number: `VOLUME/${i}` })));
  await AccountingEvent.collection.insertMany(Array.from({ length: 10100 }, (_, i) => ({ _id: oid(), type: 'stage9Volume', refId: oid(), status: i < 10000 ? 'done' : 'pending', attempts: 0, createdAt: new Date(2026, 2, 1, 0, 0, i) })));
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  const timings = {};
  async function measure(name, fn) {
    const start = performance.now();
    const result = await fn();
    timings[name] = Math.round(performance.now() - start);
    return result;
  }
  const totals = await measure('accountTotalsMs', () => accountTotals());
  expect(totals.get(String(cash._id)).closingUsd).toBe(1000000);
  expect(totals.get(String(capital._id)).closingUsd).toBe(-1000000);
  const income = await measure('incomeStatementMs', () => incomeStatement({ from: '2026-01-01', to: '2026-12-31' }));
  expect(income.summary.netProfit.total).toBe(0);
  const sheet = await measure('balanceSheetMs', () => balanceSheet({ asOf: '2026-12-31' }));
  expect(sheet.balanced).toBe(true);
  await measure('cashFlowMs', () => cashFlow({ from: '2026-01-01', to: '2026-12-31' }));
  const checks = await measure('reconciliationMs', () => runChecks({ only: ['balanced', 'wallets', 'cashBoxes', 'unrecognized', 'roles'] }));
  expect(checks.errorCount).toBe(0);
  HANDLERS.stage9Volume = async (id, payload, { session }) => {
    const entry = await postEntry({ ...input, eventKey: `VOLUME:QUEUE:${id}` }, { session });
    return { entryId: entry._id };
  };
  const first = await measure('queue25Ms', () => processQueue({ limit: 25 }));
  expect(first).toEqual({ processed: 25, done: 25 });
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(75);
  expect(await JournalEntry.countDocuments()).toBe(10025);
  await measure('queueRemaining75Ms', () => processQueue({ limit: 75 }));
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(0);
  expect(await JournalEntry.countDocuments()).toBe(10100);
  expect((await accountTotals()).get(String(cash._id)).closingUsd).toBe(1010000);
  console.log('STAGE9_VOLUME_TIMINGS', JSON.stringify(timings));
});

test('20 simultaneous independent journals remain balanced under the closing gate', async () => {
  await resetDb();
  const cash = await account('110101'), capital = await account('310000');
  const start = performance.now();
  await Promise.all(Array.from({ length: 20 }, (_, i) => post({
    eventType: 'MANUAL', eventKey: `VOLUME:CONCURRENT:${i}`, date: '2026-03-01', description: 'Parallel capital receipt',
    lines: [{ accountId: cash._id, debit: 100 }, { accountId: capital._id, credit: 100 }],
  })));
  expect(await JournalEntry.countDocuments()).toBe(20);
  expect(new Set((await JournalEntry.find({}).select('number').lean()).map(entry => entry.number)).size).toBe(20);
  expect((await accountTotals()).get(String(cash._id)).closingUsd).toBe(2000);
  console.log('STAGE9_CONCURRENT_20_MS', Math.round(performance.now() - start));
});
