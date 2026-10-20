const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { getBalance } = require('../services/carrying');
const { BankStatementLine, SupplierPayment } = require('../models/documents');
const bank = require('../services/posting/bank');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);
test('opening and manual bank/opening corrections stay in balances but are excluded from matching candidates', async () => {
  const source = await account('110201'), opening = await account('390000');
  for (const [kind, amount] of [['OPENING_CASH', 100000], ['MANUAL', 400000]]) await post({ eventType: kind, eventKey: `balance:${kind}`, date: '2026-10-01',
    lines: [{ accountId: source._id, debit: amount }, { accountId: opening._id, credit: amount }] });
  expect(await bank.unmatchedMovements(source._id)).toEqual([]);
  const adjustments = await bank.unmatchedMovements(source._id, { includeBalanceAdjustments: true });
  expect(adjustments).toHaveLength(2); expect(adjustments.every(e => e.balanceAdjustment)).toBe(true);
  expect((await bank.importStatement(source._id, [{ day: '2026-10-01', amount: 4000, description: 'Real bank receipt' }], { req })).matched).toBe(0);
  expect((await getBalance(source._id)).usd).toBe(500000);
});
test('the reported 4000 payment remains matched while its positive opening correction appears separately', async () => {
  const source = await account('110201'), opening = await account('390000'), expense = await account('530200');
  await post({ eventType: 'MANUAL', eventKey: 'payment:4000', date: '2026-10-01',
    lines: [{ accountId: expense._id, debit: 400000, office: 'tripoli' }, { accountId: source._id, credit: 400000 }] });
  await post({ eventType: 'MANUAL', eventKey: 'correction:4000', date: '2026-10-01',
    lines: [{ accountId: source._id, debit: 400000 }, { accountId: opening._id, credit: 400000 }] });
  expect((await bank.importStatement(source._id, [{ day: '2026-09-29', amount: -4000, description: 'Actual payment' }], { req })).matched).toBe(1);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
  expect(await bank.unmatchedMovements(source._id)).toEqual([]);
  expect(await bank.unmatchedMovements(source._id, { includeBalanceAdjustments: true })).toHaveLength(1);
  expect((await getBalance(source._id)).usd).toBe(0);
  expect(await SupplierPayment.countDocuments()).toBe(0);
});
test('real manual capital receipts and mixed-account entries remain available for bank matching', async () => {
  const source = await account('110201'), capital = await account('310000');
  await post({ eventType: 'MANUAL', eventKey: 'real:capital', date: '2026-10-01',
    lines: [{ accountId: source._id, debit: 400000 }, { accountId: capital._id, credit: 400000 }] });
  expect(await bank.unmatchedMovements(source._id)).toHaveLength(1);
  expect((await bank.importStatement(source._id, [{ day: '2026-10-01', amount: 4000, description: 'Capital received' }], { req })).matched).toBe(1);
});
