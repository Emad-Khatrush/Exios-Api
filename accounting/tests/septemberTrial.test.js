const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { MigrationRun, JournalEntry } = require('../models');
const { invalidateConfig, getConfig } = require('../services/config');
const { getBalance } = require('../services/carrying');
const { reverseEntry } = require('../services/ledger');
const { runInTransaction } = require('../services/transaction');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  const cash = await account('110102');
  await MigrationRun.create({ runId: 'SEPTEMBER-TRIAL', status: 'committed', cutoff: new Date('2026-10-05T12:00:00Z'),
    countAt: new Date('2026-10-05T12:00:00Z'), config: { countDay: '2026-09-14', openingCounts: [{ accountId: cash._id, amount: 0 }] } });
  invalidateConfig();
});

async function deposit(date, key) {
  return post({ eventType: 'DEPOSIT', eventKey: key, date,
    lines: [{ accountId: (await account('110102'))._id, debit: 10000, currency: 'LYD', amountCurrency: 90000, rate: 9, office: 'tripoli' },
      { accountId: (await account('220200'))._id, credit: 10000, currency: 'LYD', amountCurrency: -90000, partnerId: oid() }] });
}

test('September 14 stays in opening; September 15 moves the cash account exactly once', async () => {
  const old = await deposit('2026-09-14', 'OLD');
  expect(old.lines.some(l => l.accountCode === '390000')).toBe(true);
  expect(old.lines.some(l => l.accountCode === '110102')).toBe(false);
  const current = await deposit('2026-09-15', 'NEW');
  const again = await deposit('2026-09-15', 'NEW');
  expect(String(again._id)).toBe(String(current._id));
  expect(await getBalance((await account('110102'))._id)).toMatchObject({ usd: 10000, foreign: 90000 });
  expect(await JournalEntry.countDocuments()).toBe(2);
  for (const e of [old, current]) expect(e.lines.reduce((sum, l) => sum + l.debit - l.credit, 0)).toBe(0);
  await runInTransaction(session => reverseEntry(current._id, { session, reason: 'trial cancellation', eventKey: 'CANCEL:NEW' }));
  expect(await getBalance((await account('110102'))._id)).toMatchObject({ usd: 0, foreign: 0 });
});

test('the boundary follows Libya midnight rather than UTC midnight', async () => {
  const count = (await getConfig()).count;
  expect(count.endOfDay).toBe(true);
  const before = await deposit(new Date('2026-09-14T21:59:59Z'), 'BEFORE');
  const after = await deposit(new Date('2026-09-14T22:00:00Z'), 'AFTER');
  expect(before.lines.some(l => l.accountCode === '110102')).toBe(false);
  expect(after.day).toBe('2026-09-15');
  expect(after.lines.some(l => l.accountCode === '110102')).toBe(true);
});

test('August 31 opening allows the first, middle and last days of September to move cash', async () => {
  await MigrationRun.updateOne({ runId: 'SEPTEMBER-TRIAL' }, { $set: { 'config.countDay': '2026-08-31' } });
  invalidateConfig();
  const before = await deposit('2026-08-31', 'AUGUST');
  expect(before.lines.some(l => l.accountCode === '110102')).toBe(false);
  for (const day of ['2026-09-01', '2026-09-15', '2026-09-30']) {
    const current = await deposit(day, `SEPTEMBER:${day}`);
    expect(current.lines.some(l => l.accountCode === '110102')).toBe(true);
    expect(String((await deposit(day, `SEPTEMBER:${day}`))._id)).toBe(String(current._id));
  }
  expect(await getBalance((await account('110102'))._id)).toMatchObject({ usd: 30000, foreign: 270000 });
});
