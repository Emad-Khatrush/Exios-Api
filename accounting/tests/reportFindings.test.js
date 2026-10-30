jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { reverseEntry } = require('../services/ledger');
const { AccountingEvent, AccountingSettings, JournalEntry } = require('../models');
const { invalidateConfig } = require('../services/config');
const { today, addDays } = require('../services/dates');
const summaries = require('../services/reports/summaries');
const customers = require('../services/reports/customers');
const { annotateDebts } = require('../services/reports/writeOffBalances');
const { CHECKS } = require('../services/reports/exceptions');
const suspense = require('../services/suspense');
const Balance = require('../../models/balance');
const Order = require('../../models/order');
beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);
let sequence = 0;
const entry = async (eventType, lines, extra = {}) => post({ eventType, eventKey: `${eventType}:REPORT:${++sequence}`, date: today(), description: 'Report regression', lines, ...extra });

async function writtenOffOrder() {
  const id = oid(), customer = oid(), key = `PUR:${id}`;
  await Order.collection.insertOne({ _id: id, orderId: 'REPORT-ORDER', user: customer, isPayment: true, totalInvoice: 100, createdAt: new Date(), paymentList: [] });
  const ar = await account('121000');
  // Resolve through the configured role instead of assuming the deferred account's code.
  const def = await require('../services/roles').resolveAccount('deferred_purchase_revenue');
  const dims = { orderId: id, partnerId: customer, arKey: key };
  await entry('PURCHASE_BILLED', [{ accountId: ar._id, debit: 10000, ...dims }, { accountId: def._id, credit: 10000, ...dims }]);
  const writeoff = await entry('CLAIM_WRITEOFF', [{ accountId: ar._id, credit: 10000, ...dims }, { accountId: def._id, debit: 10000, ...dims }]);
  return { id, customer, key, ar, def, dims, writeoff };
}

test('a fully written-off invoice shows zero collected and a separate write-off, including debt reminders', async () => {
  const { id, key } = await writtenOffOrder();
  const summary = await summaries.orderSummary(String(id));
  expect(summary.totals).toMatchObject({ billed: 10000, paid: 0, open: 0, writtenOff: 10000 });
  const invoices = await customers.customerInvoices({});
  expect(invoices.results[0]).toMatchObject({ billed: 10000, paid: 0, writtenOff: 10000, status: 'written_off' });
  const reminder = { order: id, debtType: 'invoice', amount: 100, currency: 'USD', deliveryClaimKeys: [key] };
  await annotateDebts([reminder]);
  expect(reminder.accountingWriteOff).toEqual({ amountUsd: 10000, collectible: true });
  expect(reminder.amount).toBe(100);
});

test('the customer debt endpoint serializes the write-off explanation without changing the collectible amount', async () => {
  const { id, customer, key } = await writtenOffOrder();
  await Balance.collection.insertOne({ owner: customer, order: id, debtType: 'invoice', status: 'open', balanceType: 'debt', amount: 100, initialAmount: 100, currency: 'USD', deliveryClaimKeys: [key] });
  let response;
  await require('../../controllers/balance').getDebtOfUser({ params: { userId: String(customer) } }, { status() { return this; }, json(data) { response = JSON.parse(JSON.stringify(data)); } }, error => { throw error; });
  expect(response[0]).toMatchObject({ amount: 100, accountingWriteOff: { amountUsd: 10000, collectible: true } });
});

test('later recovery reduces written-off amount and only the actual payment appears as paid', async () => {
  const { id, ar, def, dims } = await writtenOffOrder();
  await entry('WRITEOFF_RECOVERY', [{ accountId: ar._id, debit: 2000, ...dims }, { accountId: def._id, credit: 2000, ...dims }]);
  const wallet = await require('../services/roles').resolveAccount('wallet_usd');
  await entry('WALLET_PAYMENT', [{ accountId: ar._id, credit: 2000, ...dims }, { accountId: wallet._id, debit: 2000, ...dims }]);
  expect((await summaries.orderSummary(String(id))).totals).toMatchObject({ paid: 2000, writtenOff: 8000, open: 0 });
  expect((await customers.customerInvoices({})).results[0]).toMatchObject({ paid: 2000, writtenOff: 8000 });
});

test('canceling a write-off reopens the receivable without reporting payment', async () => {
  const { id, writeoff } = await writtenOffOrder();
  await runInTransaction(session => reverseEntry(writeoff._id, { session }));
  expect((await summaries.orderSummary(String(id))).totals).toMatchObject({ paid: 0, writtenOff: 0, open: 10000 });
});

test('manual suspense entries are visible and settle once; canceling the settlement reopens the original', async () => {
  const s = await account('399000'), equity = await account('390000'), loan = await account('230100');
  const original = await entry('MANUAL', [{ accountId: s._id, debit: 500 }, { accountId: equity._id, credit: 500 }], { eventKey: 'MANUAL:REPORT-TEST' });
  let list = await suspense.listOpen();
  expect(list).toMatchObject({ count: 1, net: 500, ledgerNet: 500, unlistedNet: 0 });
  const item = list.results[0];
  const settlement = await runInTransaction(session => suspense.settleItem(item.id, { accountId: String(loan._id), day: today(), note: 'Loan from owner' }, { session, req: { user: { _id: oid() } } }));
  expect((await suspense.listOpen()).count).toBe(0);
  expect((await suspense.listOpen()).ledgerNet).toBe(0);
  await expect(runInTransaction(session => suspense.settleItem(item.id, { accountId: String(loan._id) }, { session, req: {} }))).rejects.toMatchObject({ statusCode: 400 });
  await runInTransaction(session => reverseEntry(settlement._id, { session }));
  list = await suspense.listOpen();
  expect(list).toMatchObject({ count: 1, net: 500, ledgerNet: 500 });
  expect(String(list.results[0].entryId)).toBe(String(original._id));
});

test('derived lost debts are covered only by a matching completed parent event AND an active posted write-off', async () => {
  await AccountingSettings.updateOne({ key: 'main' }, { cutoffAt: new Date(addDays(today(), -1)) }); invalidateConfig();
  const parent = oid(), child = oid(), customer = oid();
  await Balance.collection.insertMany([
    { _id: parent, owner: customer, currency: 'USD', balanceType: 'debt', status: 'closed', createdAt: new Date(), manualClosure: { writtenOffAmount: 10, lostBalance: child } },
    { _id: child, owner: customer, currency: 'USD', initialAmount: 10, amount: 10, balanceType: 'debt', status: 'lost', sourceBalance: parent, createdAt: new Date(), notes: 'Derived loss' },
  ]);
  await AccountingEvent.create([{ type: 'balance', refId: parent, status: 'done' }, { type: 'balanceWriteOff', refId: parent, status: 'done' }]);
  const ar = await account('121000'), loss = await require('../services/roles').resolveAccount('bad_debt_expense');
  const posted = await entry('DEBT_WRITEOFF', [{ accountId: ar._id, credit: 1000, partnerId: customer, arKey: `GEN:${parent}` }, { accountId: loss._id, debit: 1000, office: 'tripoli' }], { eventKey: `DEBT_WRITEOFF:${parent}`, source: { model: 'Balance', id: parent } });
  expect((await CHECKS.liveCoverage()).count).toBe(0);
  await AccountingEvent.updateOne({ type: 'balanceWriteOff', refId: parent }, { status: 'failed' });
  expect((await CHECKS.liveCoverage()).count).toBe(1);
  await AccountingEvent.updateOne({ type: 'balanceWriteOff', refId: parent }, { status: 'skipped', result: { skipped: 'already posted' } });
  expect((await CHECKS.liveCoverage()).count).toBe(0);
  await AccountingEvent.updateOne({ type: 'balanceWriteOff', refId: parent }, { status: 'done' });
  await runInTransaction(session => reverseEntry(posted._id, { session }));
  expect((await CHECKS.liveCoverage()).count).toBe(1);
});

test('concurrent settlement clicks cannot clear the same manual suspense item twice', async () => {
  const s = await account('399000'), equity = await account('390000'), loan = await account('230100');
  await entry('MANUAL', [{ accountId: s._id, debit: 500 }, { accountId: equity._id, credit: 500 }], { eventKey: 'MANUAL:REPORT-RACE' });
  const item = (await suspense.listOpen()).results[0];
  const settle = () => runInTransaction(session => suspense.settleItem(item.id, { accountId: String(loan._id), day: today(), note: 'Loan classification' }, { session, req: { user: { _id: oid() } } }));
  const replies = await Promise.allSettled([settle(), settle()]);
  expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await suspense.listOpen()).ledgerNet).toBe(0);
  expect(await JournalEntry.countDocuments({ eventKey: /^MANUAL:SETTLE:/ })).toBe(1);
});
