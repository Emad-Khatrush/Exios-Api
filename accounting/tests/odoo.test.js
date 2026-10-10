const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { Account, JournalEntry, MigrationRun, CurrencyRate } = require('../models');
const odoo = require('../services/odoo');

beforeAll(startDb);
afterAll(stopDb);

let seq = 0;
const user = { _id: oid() };
const total = (rows, field) => Math.round(rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) * 1000) / 1000;

// Every account an entry of these tests uses gets an Odoo code (its own, with an O prefix)
const mapAll = async () => {
  const accounts = await Account.find({ isGroup: false });
  for (const a of accounts) await Account.updateOne({ _id: a._id }, { $set: { odooCode: `O${a.code}` } });
};

async function seed() {
  const id = async (code) => (await account(code))._id;
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', lastName: 'أ', customerId: 'W021' })).insertedId;
  const trip = (await mongoose.connection.collection('inventories').insertOne({ voyage: 'AIR-1', inventoryType: 'inventoryGoods', odoReferenceCode: '77' })).insertedId;
  await CurrencyRate.create({ currency: 'LYD', day: '2026-01-01', rate: 9 });
  // 90 dinars into the Tripoli dinar box, owed by a customer
  await post({
    eventType: 'MANUAL', eventKey: `O:${++seq}`, date: '2026-01-05', description: 'إيداع بالدينار',
    lines: [
      { accountId: await id('110102'), debit: 1000, currency: 'LYD', amountCurrency: 90000, rate: 9 },
      { accountId: await id('121000'), credit: 1000, partnerId: customer, arKey: `GEN:${oid()}` },
    ],
  });
  // A trip cost paid in dollars
  await post({
    eventType: 'MANUAL', eventKey: `O:${++seq}`, date: '2026-01-06', description: 'تكلفة رحلة',
    lines: [
      { accountId: await id('130100'), debit: 2500, tripId: trip },
      { accountId: await id('110101'), credit: 2500 },
    ],
  });
}

describe('odoo export', () => {
  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  test('an account with no Odoo code stops the export', async () => {
    const pending = await odoo.pendingSummary('2026-12-31');
    expect(pending.count).toBe(2);
    expect(pending.unmapped.map((a) => a.code)).toEqual(expect.arrayContaining(['110101', '110102', '121000', '130100']));
    await expect(odoo.createExport({ upTo: '2026-12-31', user })).rejects.toThrow('رمز أودو');
  });

  test('rows in dollars: balanced entries, partner, analytic trip and the dinar amount kept', async () => {
    await mapAll();
    const { export: batch, rows } = await odoo.createExport({ upTo: '2026-12-31', user });
    expect(batch.count).toBe(2);
    expect(rows).toHaveLength(4);
    expect(total(rows, 'line_ids/debit')).toBe(total(rows, 'line_ids/credit'));

    const [header, customerLine] = rows;
    expect(header.id).toMatch(/^exios_/);
    expect(header.date).toBe('2026-01-05');
    expect(header['line_ids/account_id']).toBe('O110102');
    expect(header['line_ids/debit']).toBe(10);
    expect(header['line_ids/currency_id']).toBe('LYD');
    expect(header['line_ids/amount_currency']).toBe(90);
    expect(customerLine.id).toBe('');
    expect(customerLine['line_ids/partner_id/id']).toBe('W021');
    expect(rows[2]['line_ids/analytic_distribution']).toBe('{ "77": 100 }');

    // exported once: the next export has nothing new, until the batch is undone
    expect((await odoo.pendingSummary('2026-12-31')).count).toBe(0);
    await odoo.undoExport(batch._id, user);
    expect((await odoo.pendingSummary('2026-12-31')).count).toBe(2);
    expect(await JournalEntry.countDocuments({ odooExportId: { $exists: true } })).toBe(0);
  });

  test('rows in dinars: dinar lines keep their dinars, the rest at the day rate, still balanced', async () => {
    await mapAll();
    await odoo.saveSettings({ companyCurrency: 'LYD' });
    const { rows } = await odoo.createExport({ upTo: '2026-12-31', user });
    expect(rows[0]['line_ids/debit']).toBe(90);
    // Odoo 19 wants a currency on every journal item, the company's own included
    expect(rows[0]['line_ids/currency_id']).toBe('LYD');
    expect(rows[0]['line_ids/amount_currency']).toBe(90);
    expect(rows[1]['line_ids/credit']).toBe(90);
    expect(rows[1]['line_ids/currency_id']).toBe('USD');
    expect(rows[1]['line_ids/amount_currency']).toBe(-10);
    expect(rows[2]['line_ids/debit']).toBe(225);
    expect(total(rows, 'line_ids/debit')).toBe(total(rows, 'line_ids/credit'));
  });

  test('entries of a dry run that is not committed are never exported', async () => {
    await mapAll();
    await MigrationRun.create({ runId: 'dry-1', status: 'review', cutoff: new Date() });
    await JournalEntry.updateMany({}, { $set: { migrationRunId: 'dry-1' } });
    expect((await odoo.pendingSummary('2026-12-31')).count).toBe(0);
    await MigrationRun.updateOne({ runId: 'dry-1' }, { $set: { status: 'committed' } });
    expect((await odoo.pendingSummary('2026-12-31')).count).toBe(2);
  });
});
