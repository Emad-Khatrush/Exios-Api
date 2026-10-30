const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { JournalEntry } = require('../models');
const { CashCount } = require('../models/documents');
const { CashTally, DailyClose } = require('../models/review');
const daily = require('../services/dailyWork');
const { addDays, today } = require('../services/dates');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
let cash, equity;
const day = () => addDays(today(), -3);
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  cash = await account('110101');
  equity = await account('390000');
  await post({ eventType: 'MANUAL', eventKey: 'DAILY:IN', date: day(), description: 'cash in',
    lines: [{ accountId: cash._id, debit: 50000, office: 'tripoli' }, { accountId: equity._id, credit: 50000 }] });
});
const box = (data) => data.offices.flatMap(o => o.boxes).find(b => String(b.accountId) === String(cash._id));

test('the day shows each cash box with its movement and expected balance', async () => {
  const data = await daily.today({ day: day() });
  expect(box(data)).toMatchObject({ opening: 0, in: 50000, out: 0, expected: 50000 });
  await expect(daily.today({ day: addDays(today(), 1) })).rejects.toThrow('لم يأتِ');
});

test('a count that matches closes the box; a difference goes to the backlog until explained', async () => {
  const matched = await tx(session => daily.saveTally({ day: day(), accountId: cash._id, counted: 500 }, { session, req }));
  expect(matched.status).toBe('matched');
  const short = await tx(session => daily.saveTally({ day: day(), accountId: cash._id, counted: 480 }, { session, req }));
  expect(short).toMatchObject({ status: 'difference', difference: -2000 });
  expect((await daily.backlog()).all.some(i => i.key === `tally:${short._id}`)).toBe(true);
  await expect(tx(session => daily.explainTally(short._id, { note: 'قصير' }, { session, req }))).rejects.toThrow('10');
  await tx(session => daily.explainTally(short._id, { note: 'مصروف ضيافة لم يُدخل بعد' }, { session, req }));
  expect((await daily.backlog()).all.some(i => i.key === `tally:${short._id}`)).toBe(false);
  expect(await JournalEntry.countDocuments({ eventType: 'CASHCOUNT' })).toBe(0);
  await expect(tx(session => daily.saveTally({ day: day(), accountId: cash._id, counted: 500 }, { session, req }))).rejects.toThrow('عُولج');
});

test('adopting a difference posts one cash count for exactly the difference', async () => {
  const short = await tx(session => daily.saveTally({ day: day(), accountId: cash._id, counted: 470 }, { session, req }));
  const { cashCountId } = await tx(session => daily.adoptTally(short._id, {}, { session, req }));
  const count = await CashCount.findById(cashCountId);
  expect(count.difference).toBe(-3000);
  expect((await CashTally.findById(short._id)).status).toBe('adopted');
  await expect(tx(session => daily.adoptTally(short._id, {}, { session, req }))).rejects.toThrow('فرق مفتوح');
});

test('a day closes several times as new versions; later entries on a closed day are reported', async () => {
  const first = await daily.closeDay({ day: day(), note: 'نصف اليوم' }, { req });
  const second = await daily.closeDay({ day: day() }, { req });
  expect([first.version, second.version]).toEqual([1, 2]);
  expect(await DailyClose.countDocuments({ day: day() })).toBe(2);
  await post({ eventType: 'MANUAL', eventKey: 'DAILY:LATE', date: day(), description: 'late entry',
    lines: [{ accountId: cash._id, debit: 1000, office: 'tripoli' }, { accountId: equity._id, credit: 1000 }] });
  const data = await daily.today({ day: today() });
  expect(data.changes.map(c => c.description)).toContain('late entry');
  expect(data.items.some(i => i.kind === 'backdated' && i.description.includes('late entry'))).toBe(true);
  const third = await daily.closeDay({ day: today() }, { req });
  const saved = await daily.getClose(third._id);
  expect(saved.report.changes.map(c => c.description)).toContain('late entry');
  expect((await daily.today({ day: today() })).changes).toHaveLength(0);
});

test('an issue raised on a day item stays in the backlog until resolved', async () => {
  await tx(session => daily.reviewItem({ key: 'today:receipt:x', day: day(), state: 'issue', note: 'لا يوجد إيصال', title: 'مصروف بدون إيصال' }, { session, req }));
  expect((await daily.backlog()).all.some(i => i.key === 'issue:today:receipt:x')).toBe(true);
  await tx(session => daily.reviewItem({ key: 'today:receipt:x', day: day(), state: 'ok' }, { session, req }));
  expect((await daily.backlog()).all.some(i => i.key === 'issue:today:receipt:x')).toBe(false);
  await expect(tx(session => daily.reviewItem({ key: 'other', day: day(), state: 'ok' }, { session, req }))).rejects.toThrow('غير معروف');
});
