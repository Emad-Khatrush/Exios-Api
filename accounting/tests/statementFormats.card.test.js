const fs = require('fs');
const { readKnownFormat } = require('../services/posting/statementFormats');
const { parsePdf } = require('../services/posting/bank');

test('USD equivalent without original currency retains actual valuation without inventing an original amount', () => {
  const result = readKnownFormat('alBaraka Kredi Kartı Ekstresi\n29 Temmuz2026FACEBK*SHOP\nUSD Karşılığı:83,04USD\n3.992,71');
  expect(result.rows[0]).toMatchObject({ amount: 3992.71, settlementUsd: 83.04 });
  expect(result.rows[0].originalCurrency).toBeUndefined();
  expect(result.rows[0].originalAmount).toBeUndefined();
});

const attachedPdf = 'C:/Users/qweem/Downloads/Kart Ekstre-25.08.2026.pdf';
(fs.existsSync(attachedPdf) ? test : test.skip)('all August statement movements reconcile exactly to the bank summary, including refund', async () => {
  const parsed = await parsePdf(fs.readFileSync(attachedPdf));
  const rows = parsed.rows;
  const cents = value => Math.round(value * 100);
  const outgoing = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + cents(r.amount), 0);
  const payments = rows.filter(r => r.movementKind === 'card_payment').reduce((sum, r) => sum - cents(r.amount), 0);
  const refunds = rows.filter(r => r.movementKind === 'purchase_refund').reduce((sum, r) => sum - cents(r.amount), 0);
  expect(rows).toHaveLength(30);
  expect(outgoing).toBe(21192882); expect(payments).toBe(15111465); expect(refunds).toBe(301322);
  expect(outgoing - refunds).toBe(20891560);
  expect(14166445 + outgoing - refunds - payments).toBe(19946540);
  expect(rows.filter(r => /FACEBK/.test(r.description)).map(r => r.settlementUsd)).toEqual([83.04, 30.54, 82.74, 33.67]);
  const days = rows.map(r => r.day).sort();
  expect([days[0], days[days.length - 1]]).toEqual(['2026-07-25', '2026-08-22']);
});
