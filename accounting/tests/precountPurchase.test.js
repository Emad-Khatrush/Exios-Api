// A purchase paid from a counted bank before the count: matched to its historical bill when there is
// one; with none, posted as a new cost only after the person confirms (the counted bank unchanged)
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, MigrationRun } = require('../models');
const { BankStatementLine, Vendor } = require('../models/documents');
const bank = require('../services/posting/bank');
const payables = require('../services/posting/payables');

beforeAll(startDb);
afterAll(stopDb);

const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = (fn) => runInTransaction(fn);
let usdBank, cost;

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  usdBank = await account('110202');
  cost = await account('510400');
  await MigrationRun.collection.insertOne({ status: 'committed', committedAt: new Date('2026-09-01'),
    cutoff: new Date('2026-09-01'), config: { countDay: '2026-08-31', openingCounts: [{ accountId: usdBank._id }] } });
  invalidateConfig();
});

const purchaseLine = async (amount, description = 'SHOP ONLINE PURCHASE') => {
  await tx((session) => bank.importLines(usdBank._id, [{ day: '2026-08-20', description, amount }], { session, req }));
  return BankStatementLine.findOne({ accountId: usdBank._id, description }).lean();
};

test('a possible historical bill is named; with none, a confirmed new cost posts without moving the counted bank', async () => {
  const vendor = await Vendor.create({ name: 'Old supplier', type: 'supplier' });
  await tx((session) => payables.createBill({ vendorId: vendor._id, day: '2026-08-19', currency: 'USD',
    lines: [{ description: 'old purchase', amount: 120, target: 'expense', accountId: cost._id, office: 'turkey' }] }, { session, req }));
  const withBill = await purchaseLine(-120);
  await expect(tx((session) => bank.createEntryForLine(withBill._id, { counterAccountId: cost._id, office: 'turkey', confirmBeforeCountPurchase: true }, { session, req })))
    .rejects.toThrow('توجد فاتورة محتملة');

  const fresh = await purchaseLine(-37.5, 'ANOTHER SHOP');
  await expect(tx((session) => bank.createEntryForLine(fresh._id, { counterAccountId: cost._id, office: 'turkey' }, { session, req })))
    .rejects.toThrow('أكّد أنها تكلفة جديدة');
  const before = (await getBalance(usdBank._id)).usd;
  await tx((session) => bank.createEntryForLine(fresh._id, { counterAccountId: cost._id, office: 'turkey', confirmBeforeCountPurchase: true }, { session, req }));
  expect((await BankStatementLine.findById(fresh._id)).lineStatus).toBe('created_entry');
  // The counted bank holds it already: only the cost (and the opening balances) move
  expect((await getBalance(usdBank._id)).usd).toBe(before);
  expect((await getBalance(cost._id)).usd).toBe(12000 + 3750);
});
