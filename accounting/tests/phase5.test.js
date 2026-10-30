const { startDb, stopDb, resetDb, account, post, oid } = require('./helpers');
const { AccountingSettings, JournalEntry } = require('../models');
const { invalidateConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const statements = require('../services/reports/statements');
const operations = require('../services/reports/operations');
const { runChecks } = require('../services/reports/exceptions');
const closing = require('../services/closing');

beforeAll(startDb);
afterAll(stopDb);

let seq = 0;
const customer = oid();
const claimKey = `GEN:${oid()}`;
const lockDate = async () => (await AccountingSettings.findOne({ key: 'main' }).lean()).lockDate;
const inTx = async (fn) => { const result = await runInTransaction(fn); invalidateConfig(); return result; };

// Two years of a tiny business, written straight into the ledger
async function seedLedger() {
  const id = async (code) => (await account(code))._id;
  const entry = (date, description, lines) => post({ eventType: 'MANUAL', eventKey: `T:${++seq}`, date, description, lines });
  const cash = await id('110101');
  await entry('2025-01-05', 'رأس مال', [{ accountId: cash, debit: 1000000 }, { accountId: await id('310000'), credit: 1000000 }]);
  await entry('2025-02-10', 'شحن جوي', [{ accountId: cash, debit: 50000 }, { accountId: await id('410100'), credit: 50000, office: 'tripoli' }]);
  await entry('2025-02-15', 'إيجار', [{ accountId: await id('530200'), debit: 20000, office: 'tripoli' }, { accountId: cash, credit: 20000 }]);
  await entry('2025-03-01', 'مسحوبات', [{ accountId: await id('330000'), debit: 10000 }, { accountId: cash, credit: 10000 }]);
  await entry('2025-03-05', 'سيارة', [{ accountId: await id('150100'), debit: 100000 }, { accountId: cash, credit: 100000 }]);
  await entry('2026-01-01', 'دين على عميل', [{ accountId: await id('121000'), debit: 10000, partnerId: customer, arKey: claimKey }, { accountId: await id('410600'), credit: 10000, office: 'benghazi' }]);
  await entry('2026-01-10', 'شحن بحري', [{ accountId: cash, debit: 5000 }, { accountId: await id('410200'), credit: 5000, office: 'benghazi' }]);
}

describe('reports and closing', () => {
  beforeAll(async () => {
    await resetDb();
    await seedLedger();
  });

  test('income statement: totals, and split by month and by office', async () => {
    const year = await statements.incomeStatement({ from: '2025-01-01', to: '2025-12-31' });
    expect(year.summary.revenue.total).toBe(50000);
    expect(year.summary.grossProfit.total).toBe(50000);
    expect(year.summary.netProfit.total).toBe(30000);
    expect(year.sections.find((s) => s.key === 'expenses').rows[0]).toMatchObject({ code: '530200', total: 20000 });

    const monthly = await statements.incomeStatement({ from: '2025-01-01', to: '2025-12-31', columns: 'month' });
    expect(monthly.columns.map((c) => c.key)).toEqual(['2025-02']);
    expect(monthly.summary.netProfit.values['2025-02']).toBe(30000);

    const byOffice = await statements.incomeStatement({ columns: 'office' });
    expect(byOffice.summary.netProfit.values).toMatchObject({ tripoli: 30000, benghazi: 15000 });
    expect((await statements.incomeStatement({ office: 'benghazi' })).summary.netProfit.total).toBe(15000);
    expect((await statements.incomeStatement({ columns: 'year' })).columns.map((c) => c.key)).toEqual(['2025', '2026']);
  });

  test('balance sheet balances, with the unclosed result shown in equity', async () => {
    const sheet = await statements.balanceSheet({ asOf: '2025-12-31' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.assets.total).toBe(1000000 + 50000 - 20000 - 10000);
    expect(sheet.equity.unclosedEarnings).toBe(30000);
    expect((await statements.balanceSheet({})).balanced).toBe(true);
  });

  test('cash flow explains the whole change in cash', async () => {
    const flow = await statements.cashFlow({ from: '2025-01-01', to: '2025-12-31' });
    const total = (key) => flow.categories.find((c) => c.key === key).total;
    expect(total('operating')).toBe(30000);
    expect(total('investing')).toBe(-100000);
    expect(total('financing')).toBe(1000000 - 10000);
    expect(flow.net).toBe(flow.closing - flow.opening);
    expect(flow.unexplained).toBe(0);

    const boxes = await statements.cashMovements({ from: '2026-01-01', to: '2026-12-31' });
    expect(boxes.results.find((r) => r.code === '110101')).toMatchObject({ openingUsd: 920000, inUsd: 5000, outUsd: 0, closingUsd: 925000 });
  });

  test('receivables are aged from the day they were billed', async () => {
    const report = await operations.receivables({ asOf: '2026-02-15' });
    expect(report.totals).toMatchObject({ d0: 0, d31: 10000, total: 10000 });
    expect(report.customers[0]).toMatchObject({ d31: 10000, claims: 1 });
    expect((await operations.receivables({ asOf: '2025-12-31' })).totals.total).toBe(0);

    const statement = await operations.customerStatement(customer, {});
    expect(statement.closing.owed).toBe(10000);
    expect(statement.movements).toHaveLength(1);
    expect((await operations.payables({})).totals.total).toBe(0);
    expect((await operations.tripProfitability({})).results).toEqual([]);
  });

  test('a cost counts for its trip even when the other line of the entry has no trip', async () => {
    const trip = oid();
    const wip = await account('130100');
    await post({
      eventType: 'BILL', eventKey: `T:${++seq}`, date: '2026-02-01', description: 'فاتورة شركة شحن',
      lines: [{ accountId: wip._id, debit: 7000, tripId: trip }, { accountId: (await account('210100'))._id, credit: 7000, vendorId: oid() }],
    });
    const byTrip = await operations.netBy('tripId', [wip._id]);
    expect(byTrip.get(String(trip)).get(String(wip._id))).toBe(7000);
    expect((await operations.payables({ asOf: '2026-04-15' })).totals).toMatchObject({ d61: 7000, total: 7000 });
  });

  test('the reconciliation checks run and find a clean ledger', async () => {
    const report = await runChecks();
    expect(report.results.find((r) => r.key === 'balanced').count).toBe(0);
    expect(report.errorCount).toBe(0);
    expect(report.results.every((r) => Array.isArray(r.items))).toBe(true);
  });

  test('scenario 18: closing the year moves the result to retained earnings and locks it', async () => {
    const status = await closing.yearStatus('2025');
    expect(status).toMatchObject({ start: '2025-01-01', end: '2025-12-31', closed: false, profit: 30000, withdrawals: 10000, toRetained: 20000 });

    const closed = await inTx((session) => closing.closeYear('2025', { session }));
    expect(closed.entry.day).toBe('2025-12-31');
    expect(await lockDate()).toBe('2025-12-31');

    const sheet = await statements.balanceSheet({ asOf: '2025-12-31' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.unclosedEarnings).toBe(0);
    expect(sheet.equity.rows.find((r) => r.code === '320000').amount).toBe(20000);
    expect(sheet.equity.rows.find((r) => r.code === '330000')).toBeUndefined();
    // the closed year still shows its result, and the next year starts from zero
    expect((await statements.incomeStatement({ from: '2025-01-01', to: '2025-12-31' })).summary.netProfit.total).toBe(30000);
    expect((await statements.balanceSheet({})).equity.unclosedEarnings).toBe(15000);

    await expect(inTx((session) => closing.closeYear('2025', { session }))).rejects.toThrow('مقفلة');
    await expect(inTx((session) => closing.closeYear('2026', { session }))).rejects.toThrow('لم تنتهِ');
  });

  test('a closed year can be reopened with a reason, and months are closed by the checklist', async () => {
    await expect(inTx((session) => closing.reopenYear('2025', { session }))).rejects.toThrow('سبب');
    await inTx((session) => closing.reopenYear('2025', { session, reason: 'تصحيح' }));
    expect(await lockDate()).toBe('2024-12-31');
    expect((await closing.yearStatus('2025')).closed).toBe(false);
    expect((await statements.balanceSheet({ asOf: '2025-12-31' })).equity.unclosedEarnings).toBe(30000);
    expect(await JournalEntry.countDocuments({ eventType: 'YEAR_CLOSE' })).toBe(2);

    const checklist = await closing.monthChecklist('2025-02');
    expect(checklist.canClose).toBe(true);
    expect(checklist.netProfit).toBe(30000);
    await inTx((session) => closing.closeMonth('2025-02', { session }));
    expect(await lockDate()).toBe('2025-02-28');
    await expect(inTx((session) => closing.closeMonth('2025-01', { session }))).rejects.toThrow('مقفلة');

    // closing the year again after the correction works and keeps its own number
    const again = await inTx((session) => closing.closeYear('2025', { session }));
    expect(again.entry.eventKey).toBe('YEAR_CLOSE:2025:1');
    expect(await lockDate()).toBe('2025-12-31');
  });
});
