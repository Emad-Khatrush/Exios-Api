jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { call } = require('./e2eKit');
const { AccountingSettings, AccountingEvent, JournalEntry, MigrationRun } = require('../models');
const { BankStatementLine } = require('../models/documents');
const { invalidateConfig } = require('../services/config');
const { getBalance } = require('../services/carrying');
const { runInTransaction } = require('../services/transaction');
const { processQueue } = require('../services/events');
const bank = require('../services/posting/bank');
const controller = require('../../controllers/wallet');
const User = require('../../models/user');
const Wallet = require('../../models/wallet');
const UserStatement = require('../../models/userStatement');
let customer, current;
const user = { _id: oid(), roles: { isAdmin: true, isAccountant: true } };
const day = '2026-02-01';
beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01' } });
  invalidateConfig();
  customer = (await User.collection.insertOne({ firstName: 'Wasl', customerId: 'W001' })).insertedId;
  current = await account('110401');
});
const deposit = (extra = {}) => call(controller.addBalanceToWallet, { params: { id: String(customer) }, user,
  body: { createdAt: `${day}T12:00:00Z`, amount: 500, currency: 'USD', description: 'Shipping credit at Wasl',
    accountId: String(current._id), actionType: 'bank', office: 'tripoli', ...extra } });
const importRows = (rows = [{ day, description: 'Shipping credit', reference: 'W500', amount: 500 }]) =>
  runInTransaction(session => bank.importLines(current._id, rows, { session, req: { user } }));

test('ordinary wallet deposit immediately increases the current account and matches an earlier statement', async () => {
  await importRows();
  await deposit();
  expect((await Wallet.findOne({ user: customer })).balance).toBe(500);
  expect((await getBalance(current._id)).usd).toBe(50000);
  expect((await getBalance((await account('110101'))._id)).usd).toBe(0);
  expect(await UserStatement.countDocuments()).toBe(1);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'matched' })).toBe(1);
  expect(await AccountingEvent.countDocuments({ status: 'done' })).toBe(1);
  const before = await JournalEntry.countDocuments();
  await processQueue();
  expect(await JournalEntry.countDocuments()).toBe(before);
});

test('later statement import matches the existing deposit and repeated import does not add funds', async () => {
  await deposit();
  expect((await importRows()).matched).toBe(1);
  expect((await importRows()).count).toBe(0);
  expect((await Wallet.findOne({ user: customer })).balance).toBe(500);
  expect((await getBalance(current._id)).usd).toBe(50000);
});

test('ambiguous or opposite direction rows are not automatically linked', async () => {
  await importRows([
    { day, description: 'First', reference: '1', amount: 500 },
    { day, description: 'Second', reference: '2', amount: 500 },
    { day, description: 'Outgoing', reference: '3', amount: -500 },
  ]);
  await deposit();
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(3);
});

test('ordinary bank deposits retain queued posting and refunds never become current-account deposits', async () => {
  await deposit({ accountId: String((await account('110202'))._id) });
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(1);
  expect(await JournalEntry.countDocuments()).toBe(0);
  await deposit({ actionType: 'refund' });
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(2);
  expect((await getBalance(current._id)).usd).toBe(0);
});

test('matching failure rolls back the deposit, wallet increase, accounting event and journal', async () => {
  const spy = jest.spyOn(bank, 'autoMatch').mockRejectedValueOnce(new Error('test match failure'));
  await expect(deposit()).rejects.toThrow('test match failure');
  spy.mockRestore();
  expect(await Wallet.countDocuments()).toBe(0);
  expect(await UserStatement.countDocuments()).toBe(0);
  expect(await AccountingEvent.countDocuments()).toBe(0);
  expect(await JournalEntry.countDocuments()).toBe(0);
});

test('a deposit on the opening count day retains historical handling instead of immediately increasing current funds', async () => {
  await MigrationRun.collection.insertOne({ status: 'committed', committedAt: new Date('2026-02-02'),
    cutoff: new Date('2026-02-02'), config: { countDay: day, openingCounts: [{ accountId: current._id }] } });
  invalidateConfig();
  await deposit();
  expect(await AccountingEvent.countDocuments({ status: 'pending' })).toBe(1);
  expect(await JournalEntry.countDocuments()).toBe(0);
});

test('an old deposit recorded on a cash box is moved to the Wasl current account by editing it, and matches the statement', async () => {
  await importRows();
  // Recorded at the time on the office box, posted by the queue as usual
  await deposit({ accountId: undefined, actionType: 'cash' });
  await processQueue();
  expect((await getBalance(current._id)).usd).toBe(0);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(1);
  const statement = await UserStatement.findOne();
  await call(controller.updateStatement, { params: { id: String(customer), statementId: String(statement._id) }, user, body: { accountId: String(current._id), actionType: 'bank' } });
  // The money is now with Wasl, the box is back to what it was, the wallet did not move
  expect((await getBalance(current._id)).usd).toBe(50000);
  expect((await JournalEntry.find({ status: 'posted', 'lines.accountId': { $ne: current._id }, eventType: 'DEPOSIT' })).length).toBe(0);
  expect((await Wallet.findOne({ user: customer })).balance).toBe(500);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'matched' })).toBe(1);
  expect((await UserStatement.findById(statement._id)).editHistory).toHaveLength(1);
  // Nothing left for the queue to post twice
  const before = await JournalEntry.countDocuments();
  await processQueue();
  expect(await JournalEntry.countDocuments()).toBe(before);
});

test('a refund line cannot be moved to an account, and an unknown account is refused', async () => {
  await deposit({ accountId: undefined, actionType: 'refund' });
  const statement = await UserStatement.findOne();
  const edit = (body) => call(controller.updateStatement, { params: { id: String(customer), statementId: String(statement._id) }, user, body });
  await expect(edit({ accountId: String(current._id) })).rejects.toThrow('cash or bank');
  await expect(edit({ accountId: String(oid()), actionType: 'bank' })).rejects.toThrow();
});

describe('Wasl incoming lines proposed against its wallet deposits by amount', () => {
  const partnerDeposits = require('../services/posting/partnerDeposits');
  const apply = (lineId, input) => runInTransaction((session) => partnerDeposits.apply(lineId, input, { session, req: { user } }));

  test('a deposit typed days later on a cash box is proposed by amount, moved to the current account and matched', async () => {
    // One deposit already on the Wasl account tells which customer is Wasl
    await deposit({ amount: 100, createdAt: '2026-01-20T12:00:00Z' });
    // The real one: typed six days after Wasl credited us, on the office box
    await deposit({ accountId: undefined, actionType: undefined, createdAt: '2026-02-07T12:00:00Z' });
    await processQueue();
    await importRows([{ day, description: 'شحنة جوية رحلة 21', reference: 'W21', amount: 500 }, { day, description: 'Other', reference: 'W22', amount: 777 }]);
    const line = await BankStatementLine.findOne({ reference: 'W21' });
    const other = await BankStatementLine.findOne({ reference: 'W22' });
    const proposals = await partnerDeposits.suggestions(current._id);
    expect(proposals[other._id]).toBeUndefined();
    expect(proposals[line._id]).toHaveLength(1);
    expect(proposals[line._id][0]).toMatchObject({ amount: 500, daysApart: 6, onAccount: false, customer: 'Wasl' });

    // Six days apart: the person confirms
    await expect(apply(line._id, { statementId: proposals[line._id][0].statementId })).rejects.toThrow('فرق التاريخ');
    await apply(line._id, { statementId: proposals[line._id][0].statementId, confirmDifference: true });
    expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('matched');
    expect((await getBalance(current._id)).usd).toBe(60000);
    expect((await getBalance((await account('110101'))._id)).usd + (await getBalance((await account('110121'))._id)).usd).toBe(0);
    expect((await Wallet.findOne({ user: customer })).balance).toBe(600);
    const moved = await UserStatement.findOne({ amount: 500 });
    expect(String(moved.accountId)).toBe(String(current._id));
    expect(moved.actionType).toBe('bank');
    expect(moved.editHistory).toHaveLength(1);
    // Taken: proposed to no other line
    expect(await partnerDeposits.suggestions(current._id)).toEqual({});
  });

  test('a line of the count period is only tied to its deposit, with no entry and no balance change', async () => {
    await deposit({ amount: 100, createdAt: '2026-01-10T12:00:00Z' });
    await deposit({ accountId: undefined, actionType: 'cash', createdAt: '2026-01-25T12:00:00Z' });
    await processQueue();
    // Counted at the end of 2026-01-31: the Wasl balance then already holds January
    await MigrationRun.collection.insertOne({ status: 'committed', committedAt: new Date('2026-02-01'),
      cutoff: new Date('2026-02-01'), config: { countDay: '2026-01-31', openingCounts: [{ accountId: current._id }] } });
    invalidateConfig();
    await importRows([{ day: '2026-01-22', description: 'رحلة 19', reference: 'J19', amount: 500 }]);
    const line = await BankStatementLine.findOne({ reference: 'J19' });
    const [proposal] = (await partnerDeposits.suggestions(current._id))[line._id];
    expect(proposal).toMatchObject({ beforeCount: true, daysApart: 3, amount: 500 });
    const entries = await JournalEntry.countDocuments();
    const balance = (await getBalance(current._id)).usd;
    await apply(line._id, { statementId: proposal.statementId });
    const tied = await BankStatementLine.findById(line._id);
    expect(tied).toMatchObject({ lineStatus: 'ignored' });
    expect(tied.partnerStatementIds.map(String)).toEqual([String(proposal.statementId)]);
    expect(await JournalEntry.countDocuments()).toBe(entries);
    expect((await getBalance(current._id)).usd).toBe(balance);
    // Not offered again; undoing frees it
    expect(await partnerDeposits.suggestions(current._id)).toEqual({});
    await runInTransaction((session) => bank.setIgnored(line._id, false, { session, req: { user } }));
    expect((await partnerDeposits.suggestions(current._id))[line._id]).toHaveLength(1);
  });

  test('a deposit 0.78$ off is proposed; the difference goes to rounding and goes away with the match', async () => {
    await deposit({ amount: 1900, createdAt: '2026-02-01T12:00:00Z' });
    await importRows([{ day, description: 'Wasl credit', reference: 'D1', amount: 1899.22 }]);
    const line = await BankStatementLine.findOne({ reference: 'D1' });
    const [proposal] = (await partnerDeposits.suggestions(current._id))[line._id];
    expect(proposal).toMatchObject({ amount: 1900, difference: -78, onAccount: true });
    await expect(apply(line._id, { statementId: proposal.statementId })).rejects.toThrow('فرق المبلغ');
    await apply(line._id, { statementId: proposal.statementId, confirmDifference: true });
    expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('matched');
    // The current account follows Wasl's statement; the wallet keeps the 1900 the customer got
    expect((await getBalance(current._id)).usd).toBe(189922);
    expect((await getBalance((await account('710200'))._id)).usd).toBe(78);
    expect((await Wallet.findOne({ user: customer })).balance).toBe(1900);
    // Undoing the match takes the difference back, and it can be matched again
    await runInTransaction((session) => bank.setIgnored(line._id, false, { session, req: { user } }));
    expect((await getBalance(current._id)).usd).toBe(190000);
    expect((await getBalance((await account('710200'))._id)).usd).toBe(0);
    await apply(line._id, { statementId: proposal.statementId, confirmDifference: true });
    expect((await getBalance(current._id)).usd).toBe(189922);
  });

  test('two deposits picked by hand for one line; more than 1$ off is refused', async () => {
    await deposit({ amount: 300, createdAt: '2026-02-01T12:00:00Z' });
    await deposit({ amount: 200, createdAt: '2026-02-01T13:00:00Z' });
    await importRows([{ day, description: 'Two credits', reference: 'D2', amount: 500 }]);
    const line = await BankStatementLine.findOne({ reference: 'D2' });
    // Neither alone is within 1$: nothing proposed, both offered to pick
    expect(await partnerDeposits.suggestions(current._id)).toEqual({});
    const { results } = await partnerDeposits.options(line._id);
    expect(results.map((r) => r.amount).sort()).toEqual([200, 300]);
    await expect(apply(line._id, { statementIds: [results.find((r) => r.amount === 300).statementId] })).rejects.toThrow('الحد المسموح');
    await apply(line._id, { statementIds: results.map((r) => r.statementId) });
    expect((await BankStatementLine.findById(line._id)).matchedEntryIds).toHaveLength(2);
    expect((await getBalance(current._id)).usd).toBe(50000);
  });

  test('another bank, a refund line or a deposit outside the window is never proposed', async () => {
    await deposit({ amount: 100, createdAt: '2026-01-20T12:00:00Z' });
    await deposit({ accountId: undefined, actionType: 'refund', createdAt: '2026-02-02T12:00:00Z' });
    await deposit({ accountId: undefined, actionType: 'cash', createdAt: '2026-05-01T12:00:00Z' });
    await processQueue();
    await importRows();
    expect(await partnerDeposits.suggestions(current._id)).toEqual({});
    expect(await partnerDeposits.suggestions((await account('110202'))._id)).toEqual({});
  });
});

test('cash Wasl received from the Tripoli box is suggested as that box; before the count it is closed with no entry', async () => {
  await importRows([{ day: '2026-01-20', description: 'استلام من طرابلس', reference: 'T1', amount: 7000 }, { day: '2026-02-05', description: 'استلام من طرابلس', reference: 'T2', amount: 3000 }]);
  const early = await BankStatementLine.findOne({ reference: 'T1' });
  const late = await BankStatementLine.findOne({ reference: 'T2' });
  const hints = await bank.suggestions(current._id);
  expect(hints[early._id]).toMatchObject({ source: 'rule', account: { code: '110101' } });
  // No count yet: refused
  await expect(runInTransaction((session) => bank.coverBeforeCount(early._id, { note: 'تحويل من خزينة طرابلس' }, { session, req: { user } }))).rejects.toThrow('ليس قبل جرد');
  await MigrationRun.collection.insertOne({ status: 'committed', committedAt: new Date('2026-02-01'),
    cutoff: new Date('2026-02-01'), config: { countDay: '2026-01-31', openingCounts: [{ accountId: current._id }] } });
  invalidateConfig();
  const entries = await JournalEntry.countDocuments();
  await expect(runInTransaction((session) => bank.coverBeforeCount(early._id, {}, { session, req: { user } }))).rejects.toThrow('اكتب');
  await runInTransaction((session) => bank.coverBeforeCount(early._id, { note: 'تحويل من خزينة طرابلس' }, { session, req: { user } }));
  expect(await BankStatementLine.findById(early._id)).toMatchObject({ lineStatus: 'ignored', coveredNote: 'تحويل من خزينة طرابلس' });
  expect(await JournalEntry.countDocuments()).toBe(entries);
  // After the count it is a real transfer: covering is refused
  await expect(runInTransaction((session) => bank.coverBeforeCount(late._id, { note: 'x' }, { session, req: { user } }))).rejects.toThrow('ليس قبل جرد');
});

describe('Wasl paying several Alipay transfers in one line', () => {
  const partnerTransfers = require('../services/posting/partnerTransfers');
  const payables = require('../services/posting/payables');
  const Order = require('../../models/order');
  const { CurrencyRate } = require('../models');
  const { Vendor } = require('../models/documents');
  const yuanBill = async (vendor, number, yuan, billDay) => {
    const { insertedId } = await Order.collection.insertOne({ orderId: number, user: customer, placedAt: 'tripoli', isPayment: true, isRemittance: true,
      totalInvoice: 200, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date(`${billDay}T10:00:00Z`) });
    return runInTransaction((session) => payables.createBill({ vendorId: vendor._id, day: billDay, currency: 'CNY',
      lines: [{ description: 'علي باي', amount: yuan, target: 'order', orderId: insertedId }] }, { session, req: { user } }));
  };
  const line = (description, amount) => importRows([{ day: '2026-02-03', description, reference: `G${amount}`, amount }])
    .then(() => BankStatementLine.findOne({ reference: `G${amount}` }));

  test('each yuan part is proposed against its order bill; approving pays them from the current account, undoing unpays them', async () => {
    await CurrencyRate.create({ currency: 'CNY', day: '2026-01-01', rate: 6.6 });
    const vendor = await Vendor.create({ name: 'Alipay - حوالات العملاء', type: 'supplier' });
    const first = await yuanBill(vendor, 'A-1', 660, '2026-02-01');
    const second = await yuanBill(vendor, 'B-2', 330, '2026-02-02');
    const grouped = await line('مجموعه حوالات عبر Alipay بقيمة 660+330=990¥ تم الحساب بسعر صرف 6.6', -150);
    const proposal = (await partnerTransfers.suggestions(current._id))[grouped._id];
    expect(proposal).toMatchObject({ total: 990, rate: 6.6, complete: true });
    expect(proposal.parts.map((p) => p.bill.number)).toEqual([first.number, second.number]);

    // One bill short of the line: refused with what is missing
    await expect(runInTransaction((session) => partnerTransfers.apply(grouped._id, { billIds: [first._id] }, { session, req: { user } }))).rejects.toThrow('ينقص 330');
    await runInTransaction((session) => partnerTransfers.apply(grouped._id, { billIds: [first._id, second._id] }, { session, req: { user } }));
    expect((await BankStatementLine.findById(grouped._id)).lineStatus).toBe('matched');
    expect((await getBalance(current._id)).usd).toBe(-15000);
    expect(await payables.apBalance(payables.billKey(first._id))).toBe(0);
    expect(await payables.apBalance(payables.billKey(second._id))).toBe(0);
    expect((await partnerTransfers.suggestions(current._id))).toEqual({});

    await runInTransaction((session) => bank.setIgnored(grouped._id, false, { session, req: { user } }));
    expect((await getBalance(current._id)).usd).toBe(0);
    expect(await payables.apBalance(payables.billKey(first._id))).toBe(10000);
    expect((await partnerTransfers.suggestions(current._id))[grouped._id].complete).toBe(true);
  });

  test('a part with no bill is shown as missing', async () => {
    await CurrencyRate.create({ currency: 'CNY', day: '2026-01-01', rate: 6.6 });
    const vendor = await Vendor.create({ name: 'Alipay - حوالات العملاء', type: 'supplier' });
    await yuanBill(vendor, 'A-1', 660, '2026-02-01');
    const grouped = await line('حوالات عبر Alipay بقيمة 660+1,000=1,660¥ تم الحساب بسعر صرف 6.6', -251.52);
    const proposal = (await partnerTransfers.suggestions(current._id))[grouped._id];
    expect(proposal.complete).toBe(false);
    expect(proposal.parts[1]).toMatchObject({ amount: 1000, bill: null });
  });
});
