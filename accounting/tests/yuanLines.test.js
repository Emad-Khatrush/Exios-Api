// Yuan bought from a broker arriving in Alipay: recorded from the statement lines (one or many),
// or matched to a purchase already recorded
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate } = require('../models');
const { BankStatementLine, Vendor, YuanPurchase } = require('../models/documents');
const bank = require('../services/posting/bank');
const yuanLines = require('../services/posting/yuanLines');

beforeAll(startDb);
afterAll(stopDb);

const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = (fn) => runInTransaction(fn);
let alipay, paying;

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  await CurrencyRate.create({ currency: 'CNY', day: '2026-01-01', rate: 6.6 });
  alipay = await account('110302');
  paying = await account('110201');
});

const brokerLines = (rows) => tx((session) => bank.importLines(alipay._id, rows.map(([day, cny, ref]) => ({
  day, amount: cny, description: 'AlQFILA · 收款 · 转账红包', reference: ref, sourceProvider: 'alipay', sourceCurrency: 'CNY',
  sourceTransactionId: ref, counterparty: 'AlQFILA', paymentMethod: '账户余额', transactionStatus: '交易成功', walletImpact: 'balance',
})), { session, req }));

test('several broker lines are recorded as yuan purchases at once and matched', async () => {
  expect(await Vendor.exists({ bankPurpose: 'yuan_purchase' })).toBeTruthy();
  await brokerLines([['2026-02-03', 6289, 'T6289'], ['2026-02-05', 320, 'T320']]);
  const proposals = await yuanLines.suggestions(alipay._id);
  const lines = await BankStatementLine.find({ accountId: alipay._id }).sort({ day: 1 }).lean();
  expect(Object.values(proposals)).toHaveLength(2);
  expect(proposals[lines[0]._id]).toMatchObject({ broker: { name: 'AlQFILA' }, cny: 6289, existing: [] });

  await expect(tx((session) => yuanLines.record({ lineIds: lines.map((l) => l._id), fromAccountId: paying._id, amounts: { [lines[0]._id]: 952.88 } }, { session, req })))
    .rejects.toThrow('اكتب المبلغ المدفوع');
  const result = await tx((session) => yuanLines.record({ lineIds: lines.map((l) => l._id), fromAccountId: paying._id,
    amounts: { [lines[0]._id]: 952.88, [lines[1]._id]: 48.48 } }, { session, req }));
  expect(result.recorded).toBe(2);
  expect(await BankStatementLine.countDocuments({ accountId: alipay._id, lineStatus: 'matched' })).toBe(2);
  expect(await getBalance(alipay._id)).toEqual({ usd: 100136, foreign: 660900 });
  expect((await getBalance(paying._id)).usd).toBe(-100136);
  expect((await YuanPurchase.findOne({ cnyReceived: 6289 })).rate).toBeCloseTo(6.6, 2);
  expect(await yuanLines.suggestions(alipay._id)).toEqual({});
});

test('a purchase already recorded from the Alipay section is proposed and matched', async () => {
  const broker = await Vendor.findOne({ bankPurpose: 'yuan_purchase' });
  const purchase = await tx((session) => require('../services/posting/alipay').createYuanPurchase({ vendorId: broker._id, day: '2026-02-02',
    fromAccountId: paying._id, amount: 453.03, toAccountId: alipay._id, cnyReceived: 2990 }, { session, req }));
  await brokerLines([['2026-02-03', 2990, 'T2990']]);
  const line = await BankStatementLine.findOne({ reference: 'T2990' });
  const [existing] = (await yuanLines.suggestions(alipay._id))[line._id].existing;
  expect(existing).toMatchObject({ number: purchase.number, cny: 2990 });
  await tx((session) => yuanLines.matchExisting(line._id, { yuanPurchaseId: existing._id }, { session, req }));
  expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('matched');
  // Recorded once: the yuan are in Alipay a single time
  expect((await getBalance(alipay._id)).foreign).toBe(299000);
});
