const { resolveClosing } = require('../services/posting/statementClosingBalance');
const { startDb, stopDb, resetDb, account, post } = require('./helpers');
const { BankStatementLine } = require('../models/documents');
const { call } = require('./e2eKit');
const day = '2026-09-30';

test.each(['USD', 'TRY', 'CNY', 'LYD', 'EUR'])('%s closing balance follows movements in either import direction', () => {
  const rows = [{ day, amount: 100000, balanceAfter: 400000 }, { day, amount: -86405, balanceAfter: 313595 }, { day, amount: -1050, balanceAfter: 312545 }];
  expect(resolveClosing(rows)).toEqual({ balance: 312545, day, status: 'verified' });
  expect(resolveClosing([...rows].reverse())).toEqual({ balance: 312545, day, status: 'verified' });
});
test('negative and zero balances and a revisited balance remain valid', () => {
  const rows = [{ day, amount: -5000, balanceAfter: -5000 }, { day, amount: 5000, balanceAfter: 0 }, { day, amount: 8000, balanceAfter: 8000 }];
  expect(resolveClosing(rows.reverse()).balance).toBe(8000);
  expect(resolveClosing([{ day, amount: -5000, balanceAfter: 0 }]).balance).toBe(0);
});
test('conflicting or missing last-day balances do not fabricate a closing balance', () => {
  expect(resolveClosing([{ day, amount: 100, balanceAfter: 900 }, { day, amount: -10, balanceAfter: 500 }]).status).toBe('ambiguous');
  expect(resolveClosing([{ day, amount: 100, balanceAfter: 900 }, { day, amount: -10 }]).balance).toBeNull();
  expect(resolveClosing([{ day, amount: 100, balanceAfter: 900 }, { day: '2026-10-01', amount: -10 }]).status).toBe('missing');
});

describe('all bank accounts use the shared closing resolver', () => {
  beforeAll(startDb); afterAll(stopDb);
  beforeEach(resetDb);
  test.each(['110201', '110202', '110204'])('%s descending rows choose final fee balance independent of UI filters', async code => {
    const source = await account(code);
    await BankStatementLine.insertMany([
      { accountId: source._id, day, amount: -1050, balanceAfter: 3134900, description: 'final fee' },
      { accountId: source._id, day, amount: 10000, balanceAfter: 3135950, description: 'previous movement' },
      { accountId: source._id, day: '2026-08-31', amount: 50, balanceAfter: 10000000, description: 'older statement uploaded later' },
    ]);
    const response = await call(require('../controllers/documents').listBankLines, { query: { accountId: String(source._id), filter: 'unmatched', search: 'no visible row' } });
    expect(response.body.lines).toHaveLength(0);
    expect(response.body.statementBalance).toBe(3134900);
    expect(response.body.statementBalanceDay).toBe(day);
    expect(response.body.statementBalanceStatus).toBe('verified');
  });
  test('book comparison uses the statement date while preserving current book balance', async () => {
    const source = await account('110202'), capital = await account('310000');
    await post({ eventType: 'MANUAL', eventKey: 'closing:test', date: day, lines: [
      { accountId: source._id, debit: 3134900 }, { accountId: capital._id, credit: 3134900 },
    ] });
    await post({ eventType: 'MANUAL', eventKey: 'closing:later', date: '2026-10-01', lines: [
      { accountId: source._id, debit: 50000 }, { accountId: capital._id, credit: 50000 },
    ] });
    await BankStatementLine.create({ accountId: source._id, day, amount: 3134900, balanceAfter: 3134900, description: 'closing' });
    const response = await call(require('../controllers/documents').listBankLines, { query: { accountId: String(source._id) } });
    expect(response.body.bookBalance.foreign).toBe(3184900);
    expect(response.body.bookBalanceAtStatement.foreign).toBe(response.body.statementBalance);
  });
});
