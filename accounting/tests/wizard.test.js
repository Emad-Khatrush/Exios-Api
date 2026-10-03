const { startDb, stopDb, resetDb } = require('./helpers');
const { AccountingSettings, CurrencyRate, Currency, MigrationRun } = require('../models');
const { invalidateConfig } = require('../services/config');
const { today } = require('../services/dates');
const { wizardStatus, markStep } = require('../services/wizard');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const step = (status, key) => status.steps.find((s) => s.key === key);

test('a fresh setup starts at the first step, and each step follows the data', async () => {
  let status = await wizardStatus();
  expect(status.completed).toBe(false);
  expect(status.current).toBe('offices');
  expect(step(status, 'offices').detail.offices).toBeGreaterThan(0);

  status = await markStep('offices', 'done');
  expect(status.current).toBe('todayRates');

  const currencies = await Currency.find({ isActive: true, isBase: { $ne: true } }).lean();
  await CurrencyRate.create(currencies.map((c) => ({ currency: c.code, day: today(), rate: 5 })));
  status = await wizardStatus();
  expect(step(status, 'todayRates').done).toBe(true);
  expect(status.current).toBe('historicalRates');

  await markStep('historicalRates', 'skipped');
  status = await markStep('tripCosts', 'skipped');
  expect(step(status, 'tripCosts').skipped).toBe(true);
  expect(status.current).toBe('counts');

  // a dry run with the counts in review: counts and dry run done, commit waits
  await MigrationRun.create({ runId: 'r1', status: 'review', cutoff: new Date(), config: { openingCounts: [{ accountId: 'x', amount: 10 }] } });
  status = await wizardStatus();
  expect(step(status, 'counts').done).toBe(true);
  expect(step(status, 'dryRun').done).toBe(true);
  expect(status.current).toBe('commit');

  await MigrationRun.updateOne({ runId: 'r1' }, { $set: { status: 'committed' } });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { migrationDate: today(), liveEnabled: true } });
  invalidateConfig();
  status = await wizardStatus();
  expect(status.completed).toBe(true);
  expect((await AccountingSettings.findOne({ key: 'main' }).lean()).wizard.completedAt).toBeTruthy();

  // the next morning, before its rates are entered: still complete (the dashboard warns instead)
  await CurrencyRate.deleteMany({ day: today() });
  status = await wizardStatus();
  expect(step(status, 'todayRates').done).toBe(false);
  expect(status.completed).toBe(true);
});

test('only known steps and values can be marked, and a mark can be taken back', async () => {
  await expect(markStep('commit', 'done')).rejects.toThrow('خطوة غير معروفة');
  await expect(markStep('offices', 'skipped')).rejects.toThrow('قيمة غير صالحة');
  await markStep('offices', 'done');
  const status = await markStep('offices', null);
  expect(status.current).toBe('offices');
});
