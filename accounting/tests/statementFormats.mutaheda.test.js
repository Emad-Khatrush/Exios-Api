const fs = require('fs');
const { readKnownFormat } = require('../services/posting/statementFormats');
const hints = require('../services/posting/bankTransferHints');
const bank = require('../services/posting/bank');
const { startDb, stopDb, resetDb, account, post } = require('./helpers');
const { getBalance } = require('../services/carrying');
const { SupplierBill } = require('../models/documents');
const { JournalEntry } = require('../models');
const { BankStatementLine } = require('../models/documents');
const { call } = require('./e2eKit');
const statement = `AL MUTAHEDA Pre Balance
12,882.32418,983.86406,101.542026/09/30Pre Balance
27,882.3215,000.000.002026/10/04دخول طرابلس // 1414 // اشاري 409
-19,117.680.0047,000.002026/10/05كااش // بيده // 1414
-19,129.430.0011.752026/10/054 // كااش // بيدهCom 141
10,870.5730,000.000.002026/10/05لجبل الذهبي -811 ا -1414`;
const cents = n => Math.round(n * 100);
test('negative balances retain all movements and reconcile opening to closing', () => {
  const { rows } = readKnownFormat(statement);
  expect(rows).toHaveLength(4);
  expect(rows.map(r => r.amount)).toEqual([15000, -47000, -11.75, 30000]);
  let balance = 1288232;
  for (const row of rows) { balance += cents(row.amount); expect(balance).toBe(cents(row.balanceAfter)); }
  expect(balance).toBe(1087057);
});
const pdfFile = 'C:/Users/qweem/Downloads/عماد ختروش -1414 old دولار امريكي.pdf';
(fs.existsSync(pdfFile) ? test : test.skip)('the supplied PDF includes the cash withdrawal and its separate commission', async () => {
  const parsed = await bank.parsePdf(fs.readFileSync(pdfFile));
  expect(parsed.rows).toHaveLength(4);
  expect(parsed.rows.map(r => r.amount)).toEqual([15000, -47000, -11.75, 30000]);
  expect(parsed.rows.at(-1).balanceAfter).toBe(10870.57);
});
describe('classification and posting', () => {
  beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);
  test('cash aliases and split commission identifiers cannot be mistaken for a purchase', async () => {
    const source = await account('110201'), cash = await account('110107'), fee = await account('530400');
    for (const label of ['1414 // بيده // ك', 'كااش // بيده // 1414', '١٤١٤ // بيده // كاش'])
      expect(hints.describe({ description: label, amount: -4700000 }, source, [cash, fee])).toMatchObject({ source: 'cash_withdrawal', account: { code: '110107' }, semanticTransfer: true });
    const commission = hints.describe({ description: '4 // كااش // بيدهCom 141', amount: -1175 }, source, [cash, fee]);
    expect(commission).toMatchObject({ source: 'bank_fee', account: { code: '530400' } });
    expect(commission.semanticTransfer).toBeUndefined();
    expect(hints.describe({ description: '1414 // supplier', amount: -500 }, source, [cash, fee])).toBeNull();
    expect(hints.describe({ description: '1414 // بيده // ك', amount: 500 }, source, [cash, fee])).toBeNull();
  });
  test('withdrawal increases Turkey USD cash; only the commission creates an expense bill', async () => {
    const source = await account('110201'), capital = await account('310000');
    await post({ eventType: 'MANUAL', eventKey: 'initial', date: '2026-09-30', lines: [
      { accountId: source._id, debit: 6000000, office: 'turkey' }, { accountId: capital._id, credit: 6000000 },
    ] });
    const rows = readKnownFormat(statement).rows;
    const classified = await bank.classifyRows(source._id, rows);
    expect(classified[1].account.code).toBe('110107');
    expect(classified[2].account.code).toBe('530400');
    const outgoing = rows.slice(1, 3).map((row, i) => ({ ...row, counterAccountId: classified[i + 1].account._id,
      office: 'turkey', vendorName: classified[i + 1].vendorName }));
    const result = await bank.importStatement(source._id, outgoing, {});
    expect(result.notPosted).toEqual([]); expect(result.posted).toBe(2);
    expect((await getBalance((await account('110107'))._id)).usd).toBe(4700000);
    const bills = await SupplierBill.find().lean();
    expect(bills).toHaveLength(1); expect(bills[0].total).toBe(11.75);
    const before = await JournalEntry.countDocuments();
    expect((await bank.importStatement(source._id, outgoing, {})).count).toBe(0);
    expect(await JournalEntry.countDocuments()).toBe(before);
  });
  test('display uses the final commission balance when same-day rows share the import timestamp', async () => {
    const source = await account('110201');
    const importedAt = new Date('2026-10-09T08:00:00Z');
    await BankStatementLine.insertMany([
      { accountId: source._id, day: '2026-10-08', description: '-1414 // -1207', amount: -500000, balanceAfter: 380193, createdAt: importedAt },
      { accountId: source._id, day: '2026-10-08', description: 'Com -1414 // -1207', amount: -125, balanceAfter: 380068, createdAt: importedAt },
      // A later upload of an older statement must not override the newer closing day.
      { accountId: source._id, day: '2026-10-05', description: 'older file', amount: 3000000, balanceAfter: 1087057, createdAt: new Date('2026-10-09T09:00:00Z') },
    ]);
    const response = await call(require('../controllers/documents').listBankLines, { query: { accountId: String(source._id) } });
    expect(response.body.statementBalance).toBe(380068);
  });
});
