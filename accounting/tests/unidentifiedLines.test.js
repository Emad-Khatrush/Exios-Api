// Bank lines nobody can explain yet ("لا أعرف بعد"): parked on a clearing account so the bank is
// right and nothing reaches profit, then the owner's final decision after the waiting period.
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { BankStatementLine } = require('../models/documents');
const unidentified = require('../services/posting/unidentified');
const bank = require('../services/posting/bank');
const { today } = require('../services/dates');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const usdOf = async (code) => (await getBalance((await account(code))._id)).usd;

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'TRY', day: '2026-01-01', rate: 30 }]);
});

const lineOn = async (code, amount, extra = {}) => BankStatementLine.create({
  accountId: (await account(code))._id, day: '2026-09-10', description: 'UNKNOWN MERCHANT 4411', amount, ...extra,
});

test('money out nobody can explain waits on unidentified payments, then the owner decides', async () => {
  const line = await lineOn('110202', -30000);
  const parked = await tx((session) => unidentified.park(line._id, { hint: 'purchase', note: 'سألت المورد' }, { session, req }));
  expect(parked.lineStatus).toBe('created_entry');
  expect(await usdOf('110202')).toBe(-30000);
  expect(await usdOf('129100')).toBe(30000);
  expect(await usdOf('510900')).toBe(0);

  const listed = await unidentified.list();
  expect(listed.results).toHaveLength(1);
  expect(listed.results[0]).toMatchObject({ state: 'open', direction: 'out', hint: 'purchase', note: 'سألت المورد', overdue: false });
  expect(listed.summary).toMatchObject({ openOut: 30000, openIn: 0, count: 1 });

  await expect(tx((session) => unidentified.decide(line._id, { kind: 'unallocated_purchase' }, { session, req }))).rejects.toThrow('سبب القرار مطلوب');
  await expect(tx((session) => unidentified.decide(line._id, { kind: 'unclaimed_revenue', reason: 'x' }, { session, req }))).rejects.toThrow('اختر التصنيف');

  const decided = await tx((session) => unidentified.decide(line._id, { kind: 'unallocated_purchase', reason: 'بحثنا 90 يوماً' }, { session, req }));
  expect(decided.unidentified.status).toBe('decided');
  expect(await usdOf('129100')).toBe(0);
  expect(await usdOf('510900')).toBe(30000);
  // Dated on the decision day, not the bank line's day
  expect(decided.unidentified.decision.day).toBe(today());
  expect(await JournalEntry.exists({ _id: decided.unidentified.decision.entryId, eventType: 'UNIDENTIFIED_DECISION' })).toBeTruthy();
  expect((await unidentified.list({ state: 'decided' })).results).toHaveLength(1);
  await expect(tx((session) => unidentified.decide(line._id, { kind: 'unknown_expense', reason: 'مرة ثانية' }, { session, req }))).rejects.toThrow('ليست قيد التحديد');
});

test('money in from someone unknown is a liability until the owner turns it into revenue', async () => {
  const line = await lineOn('110202', 15000, { description: 'EFT GELEN HAVALE' });
  await expect(tx((session) => unidentified.park(line._id, { hint: 'purchase' }, { session, req }))).rejects.toThrow('حركة واردة');
  await tx((session) => unidentified.park(line._id, { hint: 'customer' }, { session, req }));
  expect(await usdOf('110202')).toBe(15000);
  expect(await usdOf('219200')).toBe(-15000);
  expect(await usdOf('411000')).toBe(0);
  expect((await unidentified.list()).results[0].dueDay).toBe(require('../services/dates').addDays(today(), 365));

  await tx((session) => unidentified.decide(line._id, { kind: 'unclaimed_revenue', reason: 'مرت سنة ولم يطالب به أحد' }, { session, req }));
  expect(await usdOf('219200')).toBe(0);
  expect(await usdOf('411000')).toBe(-15000);
});

test('an unknown supplier refund keeps the pending refunds account; deciding it lowers unallocated cost', async () => {
  const line = await lineOn('110202', 6234, { description: '1688.com refund' });
  await tx((session) => unidentified.park(line._id, { hint: 'refund' }, { session, req }));
  expect(await usdOf('219100')).toBe(-6234);
  const parked = await BankStatementLine.findById(line._id).lean();
  expect(parked.pendingRefund).toBe(true);
  expect(parked.unidentified).toMatchObject({ status: 'open', hint: 'refund' });

  await tx((session) => unidentified.decide(line._id, { kind: 'purchase_cost_reduction', reason: 'لم نجد الطلبية' }, { session, req }));
  expect(await usdOf('219100')).toBe(0);
  expect(await usdOf('510900')).toBe(-6234);
  expect((await BankStatementLine.findById(line._id).lean()).pendingRefund).toBe(false);
});

test('a lira card line is valued at its rate, and cancelling undoes the parking and the decision', async () => {
  const line = await lineOn('110204', -30000);
  await tx((session) => unidentified.park(line._id, { hint: 'unknown' }, { session, req }));
  expect(await usdOf('129100')).toBe(1000);
  const otherBank = await account('110202');
  await expect(tx((session) => unidentified.decide(line._id, { kind: 'account', accountId: otherBank._id, reason: 'x' }, { session, req }))).rejects.toThrow('حساب نقدي');
  await tx((session) => unidentified.decide(line._id, { kind: 'unknown_expense', reason: 'لا مستند' }, { session, req }));
  expect(await usdOf('531800')).toBe(1000);

  await tx((session) => bank.cancelLineEntry(line._id, { session, req, reason: 'عرفنا الطلبية' }));
  expect(await usdOf('531800')).toBe(0);
  expect(await usdOf('129100')).toBe(0);
  expect(await usdOf('110204')).toBe(0);
  const back = await BankStatementLine.findById(line._id).lean();
  expect(back.lineStatus).toBe('unmatched');
  expect(back.unidentified).toBeUndefined();
  expect((await unidentified.list()).results).toHaveLength(0);
});

test('a card line that prints its dollars is parked at those dollars; the gap to the lira average is exchange', async () => {
  const line = await lineOn('110204', -30000, { settlementUsd: 10.5 });
  await tx((session) => unidentified.park(line._id, { hint: 'purchase' }, { session, req }));
  expect(await usdOf('129100')).toBe(1050);
  expect(await usdOf('110204')).toBe(-1000);
  expect(await usdOf('710100')).toBe(-50);
  expect((await unidentified.list()).results[0].usd).toBe(10.5);
});

test('a line past its waiting period is flagged overdue', async () => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { unidentifiedOutDays: 0 } });
  const line = await lineOn('110202', -500);
  await tx((session) => unidentified.park(line._id, {}, { session, req }));
  const { results, summary } = await unidentified.list();
  expect(results[0]).toMatchObject({ hint: 'unknown', overdue: true });
  expect(summary.overdue).toBe(1);
  const { results: checks } = await require('../services/reports/exceptions').runChecks({ only: ['unidentifiedOverdue'] });
  expect(checks[0]).toMatchObject({ key: 'unidentifiedOverdue', severity: 'warn', count: 1 });
});
