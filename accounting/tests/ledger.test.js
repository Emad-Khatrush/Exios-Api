const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { JournalEntry, AccountingSettings } = require('../models');
const { runInTransaction } = require('../services/transaction');
const { reverseEntry } = require('../services/ledger');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => resetDb());

const cashDeposit = async ({ key = 'DEPOSIT:1', usd = 10000, lyd = 900000, date = '2026-03-01', partnerId = oid() } = {}) => {
  const cash = await account('110102');
  const wallet = await account('220200');
  return post({
    eventType: 'DEPOSIT',
    eventKey: key,
    date,
    description: 'إيداع',
    lines: [
      { accountId: cash._id, debit: usd, currency: 'LYD', amountCurrency: lyd, rate: 9, office: 'tripoli' },
      { accountId: wallet._id, credit: usd, currency: 'LYD', amountCurrency: -lyd, rate: 9, partnerId },
    ],
  });
};

describe('postEntry', () => {
  test('posts a balanced entry on the cash journal with its own numbering', async () => {
    const entry = await cashDeposit();
    expect(entry.number).toBe('CASH-TRP-LYD/2026/000001');
    expect(entry.day).toBe('2026-03-01');
    expect(entry.lines).toHaveLength(2);
    const second = await cashDeposit({ key: 'DEPOSIT:2' });
    expect(second.number).toBe('CASH-TRP-LYD/2026/000002');
  });

  test('the same eventKey never creates a second entry', async () => {
    const first = await cashDeposit();
    const again = await cashDeposit();
    expect(String(again._id)).toBe(String(first._id));
    expect(await JournalEntry.countDocuments()).toBe(1);
  });

  test('the same eventKey sent twice at the same moment gives one entry', async () => {
    const results = await Promise.allSettled([cashDeposit(), cashDeposit()]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await JournalEntry.countDocuments()).toBe(1);
  });

  test('an imbalance up to 5 cents goes to the rounding account', async () => {
    const ar = await account('121000');
    const revenue = await account('410600');
    const entry = await post({
      eventType: 'MANUAL', eventKey: 'MANUAL:r', date: '2026-03-01',
      lines: [
        { accountId: ar._id, debit: 1003, partnerId: oid() },
        { accountId: revenue._id, credit: 1000, office: 'tripoli' },
      ],
    });
    const rounding = entry.lines.find((line) => line.accountCode === '710200');
    expect(rounding.credit).toBe(3);
  });

  test('refuses a bigger imbalance, group accounts and missing dimensions', async () => {
    const ar = await account('121000');
    const revenue = await account('410600');
    const group = await account('41');
    await expect(post({
      eventType: 'MANUAL', eventKey: 'M:1', date: '2026-03-01',
      lines: [{ accountId: ar._id, debit: 1100, partnerId: oid() }, { accountId: revenue._id, credit: 1000, office: 'tripoli' }],
    })).rejects.toThrow('غير متوازن');
    await expect(post({
      eventType: 'MANUAL', eventKey: 'M:2', date: '2026-03-01',
      lines: [{ accountId: ar._id, debit: 1000, partnerId: oid() }, { accountId: group._id, credit: 1000 }],
    })).rejects.toThrow('مجموعة');
    await expect(post({
      eventType: 'MANUAL', eventKey: 'M:3', date: '2026-03-01',
      lines: [{ accountId: ar._id, debit: 1000 }, { accountId: revenue._id, credit: 1000, office: 'tripoli' }],
    })).rejects.toThrow('partner');
    expect(await JournalEntry.countDocuments()).toBe(0);
  });

  test('a foreign-currency account needs its currency amount with the right sign', async () => {
    const cash = await account('110102');
    const revenue = await account('410600');
    await expect(post({
      eventType: 'MANUAL', eventKey: 'M:4', date: '2026-03-01',
      lines: [{ accountId: cash._id, debit: 1000, currency: 'LYD', office: 'tripoli' }, { accountId: revenue._id, credit: 1000, office: 'tripoli' }],
    })).rejects.toThrow('بالعملة');
    await expect(post({
      eventType: 'MANUAL', eventKey: 'M:5', date: '2026-03-01',
      lines: [{ accountId: cash._id, debit: 1000, currency: 'LYD', amountCurrency: -90000, office: 'tripoli' }, { accountId: revenue._id, credit: 1000, office: 'tripoli' }],
    })).rejects.toThrow('إشارة');
  });

  test('uses the Libya day of an instant', async () => {
    const entry = await cashDeposit({ date: new Date('2026-01-31T23:30:00Z') });
    expect(entry.day).toBe('2026-02-01');
  });

  test('a locked date moves to the first open day, or is refused when asked', async () => {
    await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-03-31' } });
    invalidateConfig();
    const entry = await cashDeposit({ date: '2026-03-10' });
    expect(entry.day).toBe('2026-04-01');
    expect(entry.notes[0]).toMatch('مقفلة');

    const ar = await account('121000');
    const revenue = await account('410600');
    const { postEntry } = require('../services/ledger');
    await expect(runInTransaction((session) => postEntry({
      eventType: 'MANUAL', eventKey: 'M:lock', date: '2026-03-10',
      lines: [{ accountId: ar._id, debit: 100, partnerId: oid() }, { accountId: revenue._id, credit: 100, office: 'tripoli' }],
    }, { session, onLocked: 'reject' }))).rejects.toThrow('مقفلة');
  });
});

describe('reverseEntry', () => {
  test('mirrors the entry, marks the original and nets the balance to zero', async () => {
    const partnerId = oid();
    const entry = await cashDeposit({ partnerId });
    const wallet = await account('220200');

    const reversal = await runInTransaction((session) => reverseEntry(entry._id, { session, reason: 'خطأ' }));
    expect(reversal.lines[0].credit).toBe(entry.lines[0].debit);
    expect(reversal.lines[1].amountCurrency).toBe(900000);
    expect(String(reversal.reversalOf)).toBe(String(entry._id));

    const original = await JournalEntry.findById(entry._id);
    expect(original.status).toBe('reversed');
    expect(await getBalance(wallet._id, { partnerId })).toEqual({ usd: 0, foreign: 0 });

    const again = await runInTransaction((session) => reverseEntry(entry._id, { session }));
    expect(String(again._id)).toBe(String(reversal._id));
    await expect(runInTransaction((session) => reverseEntry(reversal._id, { session }))).rejects.toThrow('العكسي');
  });
});

describe('carrying balance', () => {
  test('wallet balance per customer in USD and LYD', async () => {
    const partnerId = oid();
    await cashDeposit({ partnerId, key: 'D:1', usd: 10000, lyd: 900000 });
    await cashDeposit({ partnerId, key: 'D:2', usd: 10000, lyd: 1000000 });
    await cashDeposit({ key: 'D:3' }); // another customer
    const wallet = await account('220200');
    expect(await getBalance(wallet._id, { partnerId })).toEqual({ usd: -20000, foreign: -1900000 });
  });
});
