const fs = require('fs');
const path = require('path');
const { parsePdf, rowsFromText } = require('../services/posting/bank');

test('statement text becomes rows; the running balance gives each amount its sign', () => {
  const rows = rowsFromText([
    'ACCOUNT STATEMENT 110201',
    'Date Description Amount Balance',
    '01/05/2026 Opening deposit 1,000.00 1,000.00',
    '02/05/2026 Transfer out TRX123456 250.00 750.00',
    '03/05/2026 Bank commission 5.50 744.50',
    '2026-05-04 Incoming transfer 100.00 844.50',
    'Page 1 of 1',
  ].join('\n'));
  expect(rows.map((r) => r.day)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04']);
  expect(rows.map((r) => r.amount)).toEqual([1000, -250, -5.5, 100]);
  expect(rows[1]).toMatchObject({ reference: 'TRX123456', balanceAfter: 750 });
  expect(rows[2].description).toBe('Bank commission');
});

test('without a balance column the amount keeps its printed sign', () => {
  const rows = rowsFromText('05.06.26 Fee -12.00\n06.06.26 Deposit 400.00');
  expect(rows).toEqual([
    expect.objectContaining({ day: '2026-06-05', amount: -12, balanceAfter: null }),
    expect.objectContaining({ day: '2026-06-06', amount: 400 }),
  ]);
});

test('a real PDF is read; an unreadable one gives a clear message', async () => {
  const sample = path.join(path.dirname(require.resolve('pdf-parse/package.json')), 'test/data/01-valid.pdf');
  await expect(parsePdf(fs.readFileSync(sample))).resolves.toEqual({ rows: expect.any(Array), creditCard: false, format: null });
  await expect(parsePdf(Buffer.from('not a pdf'))).rejects.toThrow('تعذّرت قراءة ملف PDF');
});

test('Turkish statements: 30.09.2026 dates and 1.234,56 amounts', () => {
  const rows = rowsFromText([
    'TARİH AÇIKLAMA TUTAR BAKİYE',
    '29.09.2026 Devir 5.000,00 5.000,00',
    '30.09.2026 EFT GİDEN ABC LTD -1.250,50 3.749,50',
    '30.09.2026 Havale masrafı 12,75- 3.736,75',
  ].join('\n'));
  expect(rows.map((r) => r.amount)).toEqual([5000, -1250.5, -12.75]);
  expect(rows[1]).toMatchObject({ day: '2026-09-30', description: 'EFT GİDEN ABC LTD', balanceAfter: 3749.5 });
});

test('Chinese statements: 2026年9月30日 dates, ¥ amounts, Chinese text kept', () => {
  const rows = rowsFromText([
    '交易日期 摘要 金额 余额',
    '2026年9月29日 充值 ¥2,000.00 ¥2,000.00',
    '2026-09-30 手续费 15.00 1,985.00',
  ].join('\n'));
  expect(rows.map((r) => r.day)).toEqual(['2026-09-29', '2026-09-30']);
  expect(rows.map((r) => r.amount)).toEqual([2000, -15]);
  expect(rows[1].description).toBe('手续费');
});

// Kuveyt Türk credit card statement (text as the PDF gives it), checked against its own summary:
// carried 22.556,97 + spending 1.529.965,84 - payments 1.529.983,84 = debt 22.538,97
test('a Kuveyt Türk credit card statement: every line read, totals equal the statement', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/kuveytturk-card.txt'), 'utf8');
  const { isCreditCard } = require('../services/posting/bank');
  const rows = rowsFromText(text);
  const sum = (list) => Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  expect(isCreditCard(text)).toBe(true);
  expect(rows).toHaveLength(100);
  // The bank counts refunds with the payments
  expect(sum(rows.filter((r) => r.amount < 0))).toBe(-1529983.84);
  expect(sum(rows.filter((r) => r.amount > 0))).toBe(1529965.84);
  // The TL amount is the movement; the foreign amount stays in the text; miles are dropped
  expect(rows.find((r) => r.description.startsWith('world.taobao.com Luxembourg LUX (5,598.33'))).toMatchObject({ day: '2026-08-01', amount: 266624.39, balanceAfter: null });
  expect(rows.find((r) => r.amount === -9820.71).description).toBe('Alibaba.com Luxembourg LUX (205.00 US Dollar)');
});

// The same statement as the PDF reader really extracts it: no spaces between the columns
// ("31/07/2026Kredi Kartı Borç Ödeme-25.000,00 TL0,00", "LUX107.73 US Dollar5.130,72 TL162,00")
test('the Kuveyt Türk PDF as extracted, with its columns glued together', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/kuveytturk-card.pdf.txt'), 'utf8');
  const rows = rowsFromText(text);
  const sum = (list) => Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  expect(rows).toHaveLength(100);
  expect(sum(rows.filter((r) => r.amount < 0))).toBe(-1529983.84);
  expect(sum(rows.filter((r) => r.amount > 0))).toBe(1529965.84);
  expect(rows[0]).toEqual({ day: '2026-07-31', description: 'Kredi Kartı Borç Ödeme', reference: '', amount: -25000, balanceAfter: null });
  expect(rows.find((r) => r.day === '2026-08-02' && r.amount === 2912.31).description).toBe('1688.com INTERNET SGP (61.15 US Dollar)');
});

describe('the Kuveyt Türk card classified by the default rules', () => {
  const { startDb, stopDb, resetDb, account } = require('./helpers');
  const { classifyRows } = require('../services/posting/bank');
  beforeAll(async () => { await startDb(); await resetDb(); });
  afterAll(stopDb);

  test('websites go to purchases, services to their expense, card payments to the lira account', async () => {
    const card = await account('250100');
    expect(card).toMatchObject({ currency: 'TRY', isCash: true, type: 'liability' });
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/kuveytturk-card.pdf.txt'), 'utf8');
    // As imported: the card statement's signs turned around
    const rows = rowsFromText(text).map((row) => ({ ...row, amount: -row.amount }));
    const table = await classifyRows(card._id, rows);
    const codeOf = (start) => table[rows.findIndex((r) => r.description.startsWith(start))].account?.code || null;
    expect(codeOf('Alibaba.com')).toBe('510400');
    expect(codeOf('1688.com')).toBe('510400');
    expect(codeOf('world.taobao.com')).toBe('510400');
    expect(codeOf('AMZNMktplace')).toBe('510400');
    expect(codeOf('MF**ahla')).toBe('510400');
    expect(codeOf('GOOGLE*CLOUD')).toBe('531100');
    expect(codeOf('Nexway/Kaspersky')).toBe('531100');
    expect(codeOf('TikTok')).toBe('531000');
    expect(codeOf('TKPAY/THY')).toBe('531500');
    // The card is paid from the owner's Kuveyt Türk lira account (seeded rule)
    expect(codeOf('Kredi Kartı Borç Ödeme')).toBe('110204');
    expect(codeOf('KARYAN PALACE')).toBe('510400');
    expect(codeOf('Lam*t Al Zenah')).toBe('510400');
    const counts = table.reduce((c, r) => ({ ...c, [r.account ? 'classified' : 'review']: (c[r.account ? 'classified' : 'review'] || 0) + 1 }), {});
    // eslint-disable-next-line no-console
    console.log('Kuveyt Türk card:', counts, table.map((r, i) => (!r.account && !/Borç Ödeme/.test(rows[i].description) ? rows[i].description : null)).filter(Boolean));
  });

  test("the owner's other statements are classified by the seeded rules", async () => {
    const { readKnownFormat } = require('../services/posting/statementFormats');
    const read = async (file, code) => {
      const parsed = readKnownFormat(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));
      const rows = parsed.creditCard ? parsed.rows.map((row) => ({ ...row, amount: -row.amount })) : parsed.rows;
      const table = await classifyRows((await account(code))._id, rows);
      return (pattern) => table[rows.findIndex((r) => pattern.test(r.description))];
    };
    // Albaraka dollars: the owner's deposits come from Al Mutaheda, dollar sales go to the lira account
    const usd = await read('albaraka-usd.pdf.txt', '110202');
    expect(usd(/Ortaklık/).account.code).toBe('110201');
    expect(usd(/USD Satış/).account.code).toBe('110203');
    // Albaraka card: parking is an expense billed to GENCSOY; purchases abroad carry their dollars
    const card = await read('albaraka-card.pdf.txt', '250200');
    expect(card(/GENCSOY/)).toMatchObject({ account: { code: '531600' }, vendorName: 'GENCSOY' });
    expect(card(/KWD/)).toBeTruthy();
    // Al Mutaheda (1414 is the company): its commission; money sent to another client number is a
    // service bill of that supplier, money received from one goes on that supplier's balance
    const mutaheda = await read('almutaheda-usd.pdf.txt', '110201');
    // Money received is a customer's payment: no account, it waits for the wallet deposit to match
    expect(mutaheda(/1178/)).toMatchObject({ status: 'new', account: null, vendorName: null });
    expect(mutaheda(/^Com/)).toMatchObject({ account: { code: '530400' } });
    expect(mutaheda(/^1414 \/\/ -1207/)).toMatchObject({ account: { code: '531700' }, vendorName: 'مورد خدمات - المتحدة 1207' });
    expect(mutaheda(/^-1414 +\/\/ +-1260/)).toMatchObject({ account: { code: '531700' }, vendorName: 'مورد خدمات - المتحدة 1260' });
  });
});
