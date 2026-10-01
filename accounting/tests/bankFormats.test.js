// The company's own bank statements, as the PDF reader extracts them, checked against each
// statement's own totals
const fs = require('fs');
const path = require('path');
const { readKnownFormat } = require('../services/posting/statementFormats');

const read = (name) => readKnownFormat(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const sum = (rows, keep) => Math.round(rows.filter(keep).reduce((s, r) => s + r.amount, 0) * 100) / 100;

test('Kuveyt Türk lira account: 42 lines, deposits and withdrawals equal the statement', () => {
  const { rows, creditCard } = read('kuveytturk-try.pdf.txt');
  expect(creditCard).toBe(false);
  expect(rows).toHaveLength(42);
  expect(sum(rows, (r) => r.amount > 0)).toBe(893552.3); // Toplam Yatırılan
  expect(sum(rows, (r) => r.amount < 0)).toBe(-809145.25); // Toplam Çekilen
  expect(rows[1]).toEqual({ day: '2026-09-01', description: 'Kredi Kartı Borç Ödemesi (kart 5271)', reference: 'A05XF', amount: -25000, balanceAfter: 48184.03 });
  expect(rows[rows.length - 1].balanceAfter).toBe(109407.05);
});

test('Albaraka card: payments and spending equal the statement; foreign amounts kept', () => {
  const { rows, creditCard } = read('albaraka-card.pdf.txt');
  expect(creditCard).toBe(true);
  expect(rows).toHaveLength(10);
  // Card statement signs: spending +, payments -
  expect(sum(rows, (r) => r.amount < 0)).toBe(-199465.4); // Ödemeler
  expect(sum(rows, (r) => r.amount > 0)).toBe(69758.32); // Dönem Hareketleri
  expect(rows.find((r) => r.amount === 10222.47).description).toBe('world.taobao.comLUXEMBOURGLU (206.85 USD)');
});

test('Albaraka dollar account: 35 lines; dollars sold for lira carry the lira received', () => {
  const { rows } = read('albaraka-usd.pdf.txt');
  expect(rows).toHaveLength(35);
  expect(sum(rows, (r) => r.amount > 0)).toBe(57700);
  expect(sum(rows, (r) => r.amount < 0)).toBe(-61881.75);
  const sale = rows.find((r) => r.day === '2026-09-07' && r.amount === -1096.07);
  // "5331153000.00 TRY": the receipt number 53311 glued in front of 53000.00
  expect(sale).toMatchObject({ counterAmount: 53000, counterCurrency: 'TRY' });
  expect(rows[0]).toMatchObject({ description: 'SWIFT MASRAFI', reference: '203005326OS00463', amount: -10.5 });
  expect(rows[1].description).toBe('HONGKONG SHINEKOO INTERNATIONAL TRADE CO LIMITED');
});

test('Al Mutaheda dollar account: movements follow the balance', () => {
  const { rows } = read('almutaheda-usd.pdf.txt');
  expect(rows).toHaveLength(7);
  let balance = 27080.01;
  rows.forEach((row) => {
    balance = Math.round((balance + row.amount) * 100) / 100;
    expect(row.balanceAfter).toBe(balance);
  });
  expect(balance).toBe(12882.32);
});
