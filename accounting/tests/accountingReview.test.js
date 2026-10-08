const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { JournalEntry, AccountingSettings } = require('../models');
const { Vendor, SupplierBill, BankStatementLine } = require('../models/documents');
const { PeriodApproval } = require('../models/review');
const payables = require('../services/posting/payables');
const review = require('../services/accountingReview');
const duplicates = require('../services/costDuplicates');
const bank = require('../services/posting/bank');
const { getBalance } = require('../services/carrying');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
let vendor, expense, orderId;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  vendor = await Vendor.create({ name: 'Review supplier', type: 'supplier' });
  expense = await account('510400');
  orderId = (await require('../../models/order').collection.insertOne({ orderId: 'REVIEW-1', placedAt: 'tripoli', purchaseItems: [], paymentList: [],
    isPayment: true, isCanceled: false, totalInvoice: 1000, createdAt: new Date('2026-09-01') })).insertedId;
});
const input = (extra = {}) => ({ vendorId: vendor._id, day: '2026-09-10', currency: 'USD',
  lines: [{ description: 'Purchase', amount: 800, target: 'expense', accountId: expense._id, office: 'tripoli' }], ...extra });
const create = data => tx(session => payables.createBill(data, { session, req }));
const period = { from: '2026-09-01', to: '2026-09-30' };
async function revenue() {
  const equity = await account('390000');
  // Use the configured role rather than a hard-coded revenue number.
  const role = await require('../services/roles').resolveAccount('revenue_purchase_invoices');
  await post({ eventType: 'MANUAL', eventKey: 'REVIEW:REVENUE', date: '2026-09-10', description: 'Review revenue',
    lines: [{ accountId: equity._id, debit: 100000 }, { accountId: role._id, credit: 100000, orderId, office: 'tripoli' }] });
}

test('cross-screen same-cost creation is stopped and costs stay recorded once', async () => {
  const first = await create(input());
  await expect(create(input({ lines: [{ description: 'Same purchase from order', amount: 800, target: 'order', orderId }] }))).rejects.toThrow('تكلفة محتملة');
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect((await JournalEntry.findById(first.entryId)).totalDebit).toBe(80000);
});
test('same supplier invoice reference is blocked even if amount or date changed', async () => {
  await create(input({ vendorRef: ' INV 900 ' }));
  await expect(create(input({ vendorRef: 'inv900', day: '2026-09-28', lines: [{ description: 'Wrong second entry', amount: 900, target: 'expense', accountId: expense._id, office: 'tripoli' }] }))).rejects.toThrow('رقم فاتورة المورد');
});
test('documented independent purchase requires the current comparison fingerprint', async () => {
  await create(input());
  const preview = await duplicates.preview(input());
  await expect(create(input({ duplicateDecision: 'independent', duplicateReason: 'Different real purchase', duplicateFingerprint: 'stale' }))).rejects.toThrow('تكلفة محتملة');
  await create(input({ duplicateDecision: 'independent', duplicateReason: 'Different real purchase', duplicateFingerprint: preview.fingerprint }));
  expect(await SupplierBill.countDocuments()).toBe(2);
  expect((await review.queue(period)).summary.blocking).toBeGreaterThan(0);
});
test('concurrent independent requests for the same invoice only commit once', async () => {
  const results = await Promise.allSettled([create(input({ vendorRef: 'CONCURRENT' })), create(input({ vendorRef: 'CONCURRENT' }))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await SupplierBill.countDocuments()).toBe(1);
});
test('idempotent retry returns the same invoice before duplicate checks', async () => {
  const first = await create(input({ idempotencyKey: 'REVIEW:ONE' }));
  expect(String((await create(input({ idempotencyKey: 'REVIEW:ONE' })))._id)).toBe(String(first._id));
});
test('several plausible bank entries remain unmatched instead of choosing nearest', async () => {
  const cash = await account('110202');
  await create(input({ paidImmediatelyFrom: cash._id, vendorRef: 'ONE' }));
  const other = await Vendor.create({ name: 'Other supplier', type: 'supplier' });
  await create(input({ vendorId: other._id, paidImmediatelyFrom: cash._id, vendorRef: 'TWO', day: '2026-09-11' }));
  await bank.importLines(cash._id, [{ day: '2026-09-10', description: 'ambiguous outgoing', amount: -800 }], { req });
  expect((await tx(session => bank.autoMatch(cash._id, { session, req }))).matched).toBe(0);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched');
});
test('two bank rows competing for one ledger movement both remain for review', async () => {
  const cash = await account('110202');
  await create(input({ paidImmediatelyFrom: cash._id }));
  const result = await bank.importLines(cash._id, [
    { day: '2026-09-10', description: 'First possible outgoing', amount: -800, reference: 'ONE' },
    { day: '2026-09-11', description: 'Second possible outgoing', amount: -800, reference: 'TWO' },
  ], { req });
  expect(result.matched).toBe(0);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'unmatched' })).toBe(2);
  expect((await getBalance(cash._id)).usd).toBe(-80000);
});

test('unique bank match and repeated import never add another purchase or cash outflow', async () => {
  const cash = await account('110202');
  await create(input({ paidImmediatelyFrom: cash._id }));
  const rows = [{ day: '2026-09-10', description: 'unique outgoing', amount: -800 }];
  expect((await bank.importLines(cash._id, rows, { req })).matched).toBe(1);
  expect((await tx(session => bank.autoMatch(cash._id, { session, req }))).matched).toBe(0);
  await bank.importLines(cash._id, rows, { req });
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await BankStatementLine.countDocuments()).toBe(1);
  expect((await getBalance(cash._id)).usd).toBe(-80000);
});
test('missing and partially entered costs require completion review; additional cost invalidates it', async () => {
  await revenue();
  let queue = await review.queue(period);
  expect(queue.allItems.find(i => i.category === 'cost').zeroCost).toBe(true);
  await expect(tx(session => review.certifyCost(orderId, {}, { session, req }))).rejects.toThrow('سبب');
  await create(input({ lines: [{ description: 'Recorded cost', amount: 500, target: 'order', orderId }] }));
  queue = await review.queue(period);
  expect(queue.allItems.find(i => i.orderId).title).toContain('لم يُراجع');
  await tx(session => review.certifyCost(orderId, {}, { session, req }));
  expect((await review.queue(period)).allItems.some(i => i.orderId)).toBe(false);
  await create(input({ lines: [{ description: 'Forgotten commission', amount: 25, target: 'order', orderId }] }));
  expect((await review.queue(period)).allItems.some(i => i.orderId)).toBe(true);
});
test('deferring a missing-cost warning does not remove the approval blocker', async () => {
  await revenue(); const report = await review.queue(period), item = report.allItems.find(i => i.orderId);
  await tx(session => review.updateTask({ ...period, key: item.key, fingerprint: item.fingerprint, state: 'deferred', reason: 'Waiting for supplier bill', dueDay: '2026-10-15' }, { session, req }));
  const fresh = await review.queue(period);
  expect(fresh.allItems.find(i => i.key === item.key)).toMatchObject({ state: 'deferred', blocking: true });
});
test('linking an existing direct expense creates no invoice or bank payment and keeps costs balanced', async () => {
  const cash = await account('110202'), bill = await create(input({ paidImmediatelyFrom: cash._id }));
  const before = await getBalance(cash._id);
  await tx(session => require('../services/linkExistingCost').link(bill._id, { orderId, reason: 'Same original purchase for order' }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await getBalance(cash._id)).toEqual(before);
  const entry = await JournalEntry.findOne({ eventType: 'BILL_COST_LINK' });
  expect(entry.totalDebit).toBe(entry.lines.reduce((sum, l) => sum + l.credit, 0));
  const wip = await require('../services/roles').resolveAccount('purchase_cost_wip');
  expect(entry.lines.find(l => String(l.accountId) === String(wip._id)).debit).toBe(80000);
  expect((await SupplierBill.findById(bill._id)).lines[0].target).toBe('order');
});
test('locked month is still provisional until explicitly approved, and changed data invalidates approval', async () => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-09-30' } });
  expect((await review.approvalStatus(period)).status).toBe('provisional');
  await tx(session => review.approveMonth('2026-09', { session, req }));
  expect((await review.approvalStatus(period)).status).toBe('approved');
  await bank.importLines((await account('110202'))._id, [{ day: '2026-09-12', amount: -10, description: 'Late unseen charge' }], { req });
  expect((await review.approvalStatus(period)).status).toBe('provisional');
  expect((await review.approvalStatus(period)).changedSinceApproval).toBe(true);
});
test('opening the period again invalidates its approval even without a new journal', async () => {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-09-30' } });
  await tx(session => review.approveMonth('2026-09', { session, req }));
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: null } });
  expect((await review.approvalStatus(period)).status).toBe('provisional');
  expect(await PeriodApproval.countDocuments()).toBe(1);
});

test('bank closing must equal the actual native currency; later bank movement invalidates review', async () => {
  const cash = await account('110202');
  await post({ eventType: 'MANUAL', eventKey: 'REVIEW:OPENING', date: '2026-09-01', description: 'Bank opening',
    lines: [{ accountId: cash._id, debit: 100000 }, { accountId: (await account('390000'))._id, credit: 100000 }] });
  await expect(tx(session => review.certifyBank({ accountId: cash._id, month: '2026-09', balance: 900, nature: 'available' }, { session, req }))).rejects.toThrow('لا يساوي');
  await tx(session => review.certifyBank({ accountId: cash._id, month: '2026-09', balance: 1000, nature: 'available' }, { session, req }));
  expect((await review.queue(period)).allItems.some(i => i.key.startsWith('bankClosing:'))).toBe(false);
  await create(input({ paidImmediatelyFrom: cash._id }));
  expect((await review.queue(period)).allItems.some(i => i.key.startsWith('bankClosing:'))).toBe(true);
});
test('credit card closing supports an amount owed to the bank with the correct sign', async () => {
  const card = await account('250200');
  await require('../models').CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 40 });
  await create(input({ currency: 'TRY', rate: 40, paidImmediatelyFrom: card._id }));
  await expect(tx(session => review.certifyBank({ accountId: card._id, month: '2026-09', balance: 800, nature: 'available' }, { session, req }))).rejects.toThrow('لا يساوي');
  await tx(session => review.certifyBank({ accountId: card._id, month: '2026-09', balance: 800, nature: 'owed' }, { session, req }));
  expect((await review.queue(period)).allItems.some(i => i.key === `bankClosing:${card._id}:2026-09`)).toBe(false);
});
test('canceling a linked invoice reverses the reclassification and its payment without leaving cost', async () => {
  const cash = await account('110202'), bill = await create(input({ paidImmediatelyFrom: cash._id }));
  await tx(session => require('../services/linkExistingCost').link(bill._id, { orderId, reason: 'Link actual invoice to original order' }, { session, req }));
  await tx(session => require('../services/cancel').cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: 'Duplicate actual invoice cancellation' }));
  expect((await getBalance(cash._id)).usd).toBe(0);
  const snapshot = await review.orderSnapshot(orderId);
  expect(snapshot.cost).toBe(0);
});
test('a legacy purchase item can be recorded once with an explicit link, never twice', async () => {
  const itemId = oid();
  await require('../../models/order').collection.updateOne({ _id: orderId }, { $set: { purchaseItems: [{ _id: itemId, unitPrice: 800, currency: 'USD', date: new Date('2026-09-10'), description: 'Legacy purchase' }] } });
  await expect(create(input({ lines: [{ description: 'Duplicate legacy input', amount: 800, target: 'order', orderId }] }))).rejects.toThrow('تكلفة محتملة');
  await create(input({ lines: [{ description: 'Represent original item', amount: 800, target: 'order', orderId, purchaseItemId: itemId }] }));
  await expect(create(input({ lines: [{ description: 'Repeat item', amount: 800, target: 'order', orderId, purchaseItemId: itemId }] }))).rejects.toThrow('فاتورة مسجلة');
  expect((await review.orderSnapshot(orderId)).uncovered).toHaveLength(0);
});
test('the same order cost under a different supplier still triggers cross-screen review', async () => {
  await create(input({ lines: [{ description: 'First order cost', amount: 800, target: 'order', orderId }] }));
  const other = await Vendor.create({ name: 'Accidentally selected supplier', type: 'supplier' });
  await expect(create(input({ vendorId: other._id, lines: [{ description: 'Same order cost again', amount: 800, target: 'order', orderId }] }))).rejects.toThrow('تكلفة محتملة');
});
test('existing expense from a locked period cannot silently shift cost into a new period', async () => {
  const bill = await create(input());
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-09-30' } });
  await expect(tx(session => require('../services/linkExistingCost').link(bill._id, { orderId, reason: 'Link old expense after closing' }, { session, req }))).rejects.toThrow('تسوية تاريخية');
  expect(await JournalEntry.countDocuments({ eventType: 'BILL_COST_LINK' })).toBe(0);
});
test('refund waiting for its order remains in the review queue without altering bank money', async () => {
  const cash = await account('110202');
  await bank.importLines(cash._id, [{ day: '2026-09-12', amount: 20, description: 'Unknown supplier refund' }], { req });
  const line = await BankStatementLine.findOne();
  await tx(session => bank.createEntryForLine(line._id, { pendingRefund: true }, { session, req }));
  const report = await review.queue(period);
  expect(report.allItems.some(i => i.category === 'refund')).toBe(true);
  expect((await getBalance(cash._id)).usd).toBe(2000);
});
test('a trip with shipping revenue needs a cost review even when some cost is present', async () => {
  const tripId = (await require('../../models/inventory').collection.insertOne({ voyage: 'REVIEW-TRIP', inventoryType: 'inventoryGoods', expenses: [], inventoryPlace: 'tripoli' })).insertedId;
  const packageId = oid();
  await require('../../models/order').collection.updateOne({ _id: orderId }, { $set: { paymentList: [{ _id: packageId, tripId }] } });
  const role = await require('../services/roles').resolveAccount('revenue_shipping_air');
  await post({ eventType: 'MANUAL', eventKey: 'REVIEW:SHIPPING', date: '2026-09-10', description: 'Shipping revenue',
    lines: [{ accountId: (await account('390000'))._id, debit: 100000 }, { accountId: role._id, credit: 100000, orderId, packageId, office: 'tripoli' }] });
  await create(input({ lines: [{ description: 'Partial trip cost', amount: 500, target: 'trip', tripId, costCategory: 'shipping' }] }));
  expect((await review.queue(period)).allItems.some(i => i.tripId)).toBe(true);
  await tx(session => review.certifyTrip(tripId, {}, { session, req }));
  expect((await review.queue(period)).allItems.some(i => i.tripId)).toBe(false);
});
