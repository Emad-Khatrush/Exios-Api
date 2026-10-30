const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { CurrencyRate, AccountingSettings, JournalEntry } = require('../models');
const { BankStatementLine } = require('../models/documents');
const { getRate } = require('../services/rates');
const { invalidateConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);
test('nearest bank quote considers both sides, prefers same day and breaks ties with the earlier quote', async () => {
  await CurrencyRate.deleteMany({ currency: 'TRY' });
  await CurrencyRate.create([{ currency: 'TRY', day: '2026-09-01', rate: 45 }, { currency: 'TRY', day: '2026-09-28', rate: 50 }]);
  expect(await getRate('TRY', '2026-09-27', { nearest: true })).toMatchObject({ rate: 50, source: 'next', day: '2026-09-28' });
  expect(await getRate('TRY', '2026-09-28', { nearest: true })).toMatchObject({ rate: 50, source: 'daily' });
  await CurrencyRate.create({ currency: 'TRY', day: '2026-09-26', rate: 49 });
  expect(await getRate('TRY', '2026-09-27', { nearest: true })).toMatchObject({ rate: 49, source: 'previous' });
  expect(await getRate('TRY', '2026-09-27', { nearest: true, docRate: 51 })).toMatchObject({ rate: 51, source: 'document' });
});
test('PAYMOB pending refund posts using the nearest future quote and records and locks it', async () => {
  await CurrencyRate.deleteMany({ currency: 'TRY' });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { rateFallbackNext: false } });
  invalidateConfig();
  const quote = await CurrencyRate.create({ currency: 'TRY', day: '2026-09-28', rate: 50 });
  const source = await account('110204');
  const line = await BankStatementLine.create({ accountId: source._id, day: '2026-09-27', description: 'PAYMOB AL GHUBRA OMN (101.27 Rial Omani)',
    amount: 1300000, originalAmount: 101.27, originalCurrency: 'OMR' });
  const req = { user: { _id: oid(), roles: { isAdmin: true } } };
  await runInTransaction(session => require('../services/posting/bank').createEntryForLine(line._id, { pendingRefund: true }, { session, req }));
  const saved = await BankStatementLine.findById(line._id).lean();
  expect(saved.lineStatus).toBe('created_entry');
  expect(saved.valuationUsd).toBe(260);
  const entry = await JournalEntry.findById(saved.entryId).lean();
  expect(entry.fallbacks.join(' ')).toContain('2026-09-28');
  expect((await CurrencyRate.findById(quote._id)).isUsed).toBe(true);
  expect(entry.lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
  await expect(runInTransaction(session => require('../services/posting/bank').createEntryForLine(line._id, { pendingRefund: true }, { session, req }))).rejects.toThrow();
});
test('no saved quote remains an explicit error, and unrelated strict rate policy remains unchanged', async () => {
  await CurrencyRate.deleteMany({ currency: 'TRY' });
  await expect(getRate('TRY', '2026-09-27', { nearest: true })).rejects.toThrow('أي سعر صرف مسجل');
  await CurrencyRate.create({ currency: 'TRY', day: '2026-09-28', rate: 50 });
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { rateFallbackNext: false } });
  invalidateConfig();
  await expect(getRate('TRY', '2026-09-27')).rejects.toThrow('سعر صرف');
});
