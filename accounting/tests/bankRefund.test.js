const fs = require('fs');
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { CurrencyRate, JournalEntry } = require('../models');
const { Vendor, SupplierBill, SupplierReceipt, BankStatementLine, CustomerRefund } = require('../models/documents');
const Order = require('../../models/order');
const Wallet = require('../../models/wallet');
const { runInTransaction: tx } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const payables = require('../services/posting/payables');
const bank = require('../services/posting/bank');
const refund = require('../services/posting/bankRefund');
const { createCustomerRefund } = require('../services/posting/customerRefund');
const { cancelDocument } = require('../services/cancel');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 40 }); });
async function seed(target = 'order', currency = 'USD', total = 100) {
 const customer = (await mongoose.connection.collection('users').insertOne({ firstName: 'Refund customer', lastName: 'test', customerId: 'REF-1' })).insertedId;
 const orderId = (await Order.collection.insertOne({ orderId: 'REF-ORDER', user: customer, placedAt: 'tripoli', isPayment: true, totalInvoice: 150,
   unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-07-01') })).insertedId;
 const vendor = await Vendor.create({ name: '1688.com', type: 'supplier' });
 const source = await account('110204'); const cash = await account('110101'); const expense = await account('530800');
 const bill = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-07-01', currency,
  ...(currency !== 'USD' && { rate: 2 }), lines: [{ description: '1688 purchase', amount: total, target,
    ...(target === 'order' ? { orderId } : { accountId: expense._id, office: 'turkey' }) }] }, { session, req }));
 await tx(session => payables.createPayment({ vendorId: vendor._id, day: bill.day, fromAccountId: cash._id, amount: bill.totalUsd / 100,
   allocations: [{ billId: bill._id, amountUsd: bill.totalUsd }] }, { session, req }));
 // A real paid invoice is necessary before anything can be given back to the customer's wallet.
 await require('../../models/orderPaymentHistory').collection.insertOne({ order: orderId, currency: 'USD', receivedAmount: 150, category: 'purchase', createdAt: new Date('2026-07-01') });
 await tx(session => require('../services/claims/sync').syncOrder(orderId, { session, user: req.user }));
 return { source, bill, orderId, customer, expense };
}
async function incoming(source, extra = {}) {
 await bank.importStatement(source._id, [{ day: '2026-08-02', amount: 3013.22, description: '1688.comLUXEMBOURGLU (62.34 USD)', originalAmount: 62.34, originalCurrency: 'USD', settlementUsd: 62.34, movementKind: 'purchase_refund', ...extra }], { req });
 return BankStatementLine.findOne({ accountId: source._id, lineStatus: 'unmatched' }).lean();
}
test('outgoing purchase cannot be listed or posted as refund, including the 109.39 USD versus 81 USD case', async () => {
 const { source, bill } = await seed('expense', 'USD', 81);
 const line = await incoming(source, { amount: -5227.53, originalAmount: 109.39, settlementUsd: 109.39,
  description: 'Alibaba.com Luxembourg (109.39 USD)', movementKind: 'purchase' });
 const count = await JournalEntry.countDocuments();
 await expect(refund.list({ accountId: String(source._id), lineId: String(line._id) })).rejects.toThrow('ليست استرداداً');
 await expect(refund.list({ accountId: String(source._id), statementAmount: -5227.53, paid: 5227.53, day: line.day })).rejects.toThrow('ليست استرداداً');
 await expect(tx(session => refund.match(line._id, { kind: 'bill', billId: bill._id, confirmDifference: true }, { session, req }))).rejects.toThrow('مبلغ مرتجع');
 expect(await JournalEntry.countDocuments()).toBe(count);
 expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('unmatched');
});

test('equal currency, date and amount do not match another known merchant without confirmation', async () => {
 const { source, bill } = await seed('expense', 'USD', 81);
 await Vendor.create({ name: 'Alibaba review merchant', type: 'supplier', bankAliases: ['Alibaba.com Luxembourg'] });
 const line = await incoming(source, { description: 'Alibaba.com Luxembourg (81.00 USD)', originalAmount: 81, settlementUsd: 81 });
 const listed = await refund.list({ accountId: String(source._id), lineId: String(line._id), status: 'all' });
 const row = listed.results.find(r => String(r.billId) === String(bill._id));
 expect(row).toMatchObject({ merchantMismatch: true, canMatch: true });
 const count = await JournalEntry.countDocuments();
 await expect(tx(session => refund.match(line._id, { kind: 'bill', billId: bill._id, confirmDifference: true }, { session, req }))).rejects.toThrow('مختلف عن تاجر الكشف');
 expect(await JournalEntry.countDocuments()).toBe(count);
});

test('card funding cannot be used as a merchant refund', async () => {
 const { source, bill } = await seed('expense');
 const line = await incoming(source, { movementKind: 'card_payment', description: 'ODEME ICIN' });
 await expect(tx(session => refund.match(line._id, { kind: 'bill', billId: bill._id }, { session, req }))).rejects.toThrow('سداد بطاقة');
});
const attachedPdf = 'C:/Users/qweem/Downloads/Kart Ekstre-25.08.2026.pdf';
(fs.existsSync(attachedPdf) ? test : test.skip)('the actual August PDF distinguishes 62.34 USD refund from purchases and card funding', async () => {
 const parsed = await bank.parsePdf(fs.readFileSync(attachedPdf));
 expect(parsed.creditCard).toBe(true);
 const returned = parsed.rows.find(r => r.originalAmount === 62.34 && /1688/.test(r.description));
 expect(returned).toMatchObject({ day: '2026-08-02', amount: -3013.22, originalCurrency: 'USD', movementKind: 'purchase_refund' });
 expect(parsed.rows.find(r => r.originalAmount === 81.46)).toMatchObject({ amount: 3926.49, movementKind: 'purchase' });
 expect(parsed.rows.filter(r => /ÖDEME/.test(r.description)).every(r => r.movementKind === 'card_payment')).toBe(true);
});
test('refund import stays unposted and suggests refund review; a new order refund lowers cost once and is available in the order', async () => {
 const { source, bill, orderId } = await seed(); const line = await incoming(source);
 expect((await bank.suggestions(source._id))[line._id].isRefund).toBe(true);
 expect((await refund.list({ accountId: source._id, lineId: line._id })).results.some(r => String(r.billId) === String(bill._id))).toBe(true);
 const capital = await account('310000');
 await expect(tx(session => bank.createEntryForLine(line._id, { counterAccountId: capital._id }, { session, req }))).rejects.toThrow('استرداد');
 const result = await tx(session => refund.match(line._id, { kind: 'bill', billId: bill._id, walletUsd: 0 }, { session, req }));
 const recorded = await CustomerRefund.findById(result.customerRefundId);
 expect(recorded).toMatchObject({ amount: 3013.22, usd: 6234, walletUsd: 0, originalAmount: 62.34 });
 expect(String(recorded.orderId)).toBe(String(orderId));
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect(await SupplierBill.countDocuments({ isCreditNote: true })).toBe(0);
 expect(await SupplierReceipt.countDocuments()).toBe(0);
 await expect(tx(session => refund.match(line._id, { billId: bill._id }, { session, req }))).rejects.toThrow('غير مطابق');
});
test('an existing order refund is matched without posting incoming money or cost twice', async () => {
 const { source, orderId } = await seed();
 const existing = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 62.34, walletUsd: 20 }, { session, req }));
 const line = await incoming(source, { purchaseMatch: { refund: true, kind: 'existing_refund', refundId: existing._id } });
 // Imports may already auto-match the existing bank movement; use the linked saved row.
 const saved = line || await BankStatementLine.findOne({ accountId: source._id }).lean();
 if (saved.lineStatus === 'unmatched') await tx(session => refund.match(saved._id, { kind: 'existing_refund', refundId: existing._id }, { session, req }));
 expect(await CustomerRefund.countDocuments()).toBe(1);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
});
test('bank first, then customer wallet: wallet allocation does not repeat bank/cost, and cancellation frees the statement', async () => {
 const { source, bill, orderId, customer } = await seed(); const line = await incoming(source);
 const saved = await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 const before = await getBalance(source._id);
 await tx(session => createCustomerRefund({ orderId, existingRefundId: saved.customerRefundId, walletUsd: 60, day: '2026-08-03' }, { session, req }));
 expect(await getBalance(source._id)).toEqual(before);
 expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(60);
 expect(await CustomerRefund.countDocuments()).toBe(1);
 await expect(tx(session => createCustomerRefund({ orderId, existingRefundId: saved.customerRefundId, walletUsd: 60 }, { session, req }))).rejects.toThrow('مسبقاً');
 await tx(session => cancelDocument('AccountingCustomerRefund', saved.customerRefundId, { session, req, reason: 'Wrong refund' }));
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(0);
 expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('unmatched');
});
test('direct supplier purchase refund creates a credit and receipt, then cancels and retries cleanly', async () => {
 const { source, bill, expense } = await seed('expense'); const line = await incoming(source);
 const result = await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 expect(result.creditNoteId).toBeTruthy(); expect(result.receiptId).toBeTruthy();
 expect(await payables.apBalance(payables.billKey(bill._id))).toBe(0);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect((await getBalance(expense._id)).usd).toBe(3766);
 await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'Wrong invoice' }));
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
});
test('partial refunds reject wrong currencies, over-refunds and duplicate manual refunds', async () => {
 const { source, bill, orderId } = await seed(); const line = await incoming(source);
 await BankStatementLine.updateOne({ _id: line._id }, { $set: { originalCurrency: 'SAR' } });
 await expect(tx(session => refund.match(line._id, { billId: bill._id }, { session, req }))).rejects.toThrow('المطابقة');
 await BankStatementLine.updateOne({ _id: line._id }, { $set: { originalCurrency: 'USD' } });
 await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 await expect(tx(session => createCustomerRefund({ orderId, accountId: source._id, day: line.day, amount: 3013.22, usdValue: 62.34 }, { session, req }))).rejects.toThrow('مسجل من كشف');
 const second = await incoming(source, { day: '2026-08-03', description: 'second refund', originalAmount: 40, settlementUsd: 40, amount: 1900 });
 await expect(tx(session => refund.match(second._id, { billId: bill._id }, { session, req }))).rejects.toThrow('المتبقي');
});
test('a pre-existing supplier credit is received without reducing cost twice, even after receipt cancellation', async () => {
 const { source, bill, expense } = await seed('expense');
 await tx(session => payables.createBill({ vendorId: bill.vendorId, day: '2026-08-01', currency: 'USD', isCreditNote: true, originalBillId: bill._id,
  lines: [{ target: 'expense', accountId: expense._id, office: 'turkey', amount: 62.34, description: 'prior credit' }] }, { session, req }));
 const line = await incoming(source);
 const posted = await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 expect(await SupplierBill.countDocuments({ isCreditNote: true, status: 'posted' })).toBe(1);
 expect(posted.refundCreditCreated).toBe(false);
 await tx(session => cancelDocument('AccountingSupplierReceipt', posted.receiptId, { session, req, reason: 'Correction' }));
 expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('unmatched');
 await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 expect(await SupplierBill.countDocuments({ isCreditNote: true, status: 'posted' })).toBe(1);
 expect((await getBalance(expense._id)).usd).toBe(3766);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
});
test('third-currency refund keeps the native pair and reports only the actual exchange difference', async () => {
 const { source, bill, expense } = await seed('expense', 'EUR');
 const line = await incoming(source, { originalAmount: 10, originalCurrency: 'EUR', settlementUsd: 6, amount: 240 });
 const posted = await tx(session => refund.match(line._id, { billId: bill._id }, { session, req }));
 expect(posted.crossRate).toBe(24);
 expect((await SupplierBill.findById(posted.creditNoteId)).totalUsd).toBe(500);
 expect(await getBalance(source._id)).toEqual({ usd: 600, foreign: 24000 });
 expect((await getBalance(expense._id)).usd).toBe(4500);
 expect((await getBalance((await account('710100'))._id)).usd).toBe(-100);
 expect(await payables.apBalance(payables.billKey(bill._id))).toBe(0);
});
test('an order refund before the opening count is matched to its original document without altering the counted bank balance', async () => {
 const { source, orderId } = await seed();
 await require('../models').MigrationRun.collection.insertOne({ runId: 'REFUND-COUNT', status: 'committed', cutoff: new Date('2026-09-03T12:00:00Z'),
  countAt: new Date('2026-09-03T12:00:00Z'), committedAt: new Date(), config: { countDay: '2026-09-03', openingCounts: [{ accountId: source._id }] } });
 require('../services/config').invalidateConfig();
 const recorded = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 62.34 }, { session, req }));
 const before = await getBalance(source._id);
 expect(before).toEqual({ usd: 0, foreign: 0 });
 const line = await incoming(source);
 await tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }));
 expect(await CustomerRefund.countDocuments()).toBe(1);
 expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('matched');
 expect(await getBalance(source._id)).toEqual(before);
});
test.each(['review', 'ledger'])('bank valuation corrects an existing refund through %s, preserves wallet, and cancellation reverses both journals', async path => {
 const { source, orderId } = await seed();
 const recorded = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 60.51, walletUsd: 62 }, { session, req }));
 const line = await incoming(source);
 if (path === 'review') await tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }));
 else await tx(session => bank.manualMatch(line._id, [recorded.entryId], { session, req }));
 expect((await CustomerRefund.findById(recorded._id))).toMatchObject({ usd: 6234, bankValuationBeforeUsd: 6051, walletUsd: 6200 });
 expect((await Wallet.findOne({ user: recorded.partnerId, currency: 'USD' })).balance).toBe(62);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect(await CustomerRefund.countDocuments()).toBe(1);
 const entries = await JournalEntry.find({ eventKey: { $regex: '^REFUND_BANK_VALUE:' } }).lean();
 expect(entries).toHaveLength(1);
 expect(entries[0].lines.find(l => String(l.accountId) === String(source._id))).toMatchObject({ debit: 183, amountCurrency: 0 });
 const details = await require('../services/posting/bankLineDetails').details(String(line._id));
 expect(details.entries.find(entry => String(entry._id) === String(entries[0]._id)).role).toBe('settlement');
 const summary = await require('../services/reports/summaries').orderSummary(orderId);
 expect(summary.costExplanation.total).toBe(3766);
 expect(summary.costExplanation.recognizedCost).toBe(summary.totals.cost);
 expect(summary.costExplanation.rows.filter(row => row.kind === 'refund').map(row => row.impact)).toContain(-6051);
 expect(summary.costExplanation.rows.filter(row => row.kind === 'refund_valuation').map(row => row.impact)).toEqual([-183]);
 const costRefund = summary.costExplanation.rows.find(row => row.kind === 'refund');
 expect(costRefund.lines.filter(row => row.affectsCost)).toHaveLength(1);
 expect(new Set(costRefund.lines.map(row => row._id)).size).toBe(costRefund.lines.length);
 expect(costRefund.lines.find(row => String(row.account._id) === String(source._id)).affectsCost).toBe(false);
 expect(summary.costExplanation.rows.filter(row => row.kind === 'recognition').every(row => row.impact === 0)).toBe(true);
 await expect(tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }))).rejects.toThrow('غير مطابق');
 expect(await JournalEntry.countDocuments({ eventKey: { $regex: '^REFUND_BANK_VALUE:' } })).toBe(1);
 await tx(session => cancelDocument('AccountingCustomerRefund', recorded._id, { session, req, reason: 'Cancel reconciled refund' }));
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 expect((await Wallet.findOne({ user: recorded.partnerId, currency: 'USD' })).balance).toBe(0);
 expect((await BankStatementLine.findById(line._id)).lineStatus).toBe('unmatched');
 expect((await require('../services/reports/summaries').orderSummary(orderId)).costExplanation.total).toBe(10000);
});

test('a lower bank USD value settles downwards without changing native cash or wallet', async () => {
 const { source, orderId } = await seed();
 const recorded = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 75, walletUsd: 62 }, { session, req }));
 const line = await incoming(source);
 await tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }));
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect((await CustomerRefund.findById(recorded._id)).walletUsd).toBe(6200);
 const adjustment = await JournalEntry.findOne({ eventKey: { $regex: '^REFUND_BANK_VALUE:' } }).lean();
 expect(adjustment.lines.find(l => String(l.accountId) === String(source._id))).toMatchObject({ credit: 1266, amountCurrency: 0 });
});

test('a historical valuation correction goes to opening balances and leaves the counted bank unchanged', async () => {
 const { source, orderId } = await seed();
 await require('../models').MigrationRun.collection.insertOne({ runId: 'REFUND-VALUE-COUNT', status: 'committed', cutoff: new Date('2026-09-03T12:00:00Z'),
  countAt: new Date('2026-09-03T12:00:00Z'), committedAt: new Date(), config: { countDay: '2026-09-03', openingCounts: [{ accountId: source._id }] } });
 require('../services/config').invalidateConfig();
 const recorded = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 60.51 }, { session, req }));
 const line = await incoming(source);
 await tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }));
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 expect((await CustomerRefund.findById(recorded._id)).usd).toBe(6234);
 const adjustment = await JournalEntry.findOne({ eventKey: { $regex: '^REFUND_BANK_VALUE:' } }).lean();
 expect(adjustment.lines.some(l => String(l.accountId) === String(source._id))).toBe(false);
});

test('without a printed USD equivalent, matching preserves the recorded valuation', async () => {
 const { source, orderId } = await seed();
 const recorded = await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: '2026-08-02', amount: 3013.22, usdValue: 75 }, { session, req }));
 const line = await incoming(source, { description: '1688 refund', originalAmount: undefined, originalCurrency: undefined, settlementUsd: undefined });
 await tx(session => refund.match(line._id, { kind: 'existing_refund', refundId: recorded._id }, { session, req }));
 expect((await CustomerRefund.findById(recorded._id)).usd).toBe(7500);
 expect(await JournalEntry.countDocuments({ eventKey: { $regex: '^REFUND_BANK_VALUE:' } })).toBe(0);
});
test('concurrent partial refund approvals cannot refund the same original amount twice', async () => {
 const { source, bill } = await seed();
 const first = await incoming(source);
 const second = await incoming(source, { day: '2026-08-03', description: 'Concurrent partial refund' });
 // The helper picks an unmatched row, so address the second row explicitly.
 const secondLine = await BankStatementLine.findOne({ description: 'Concurrent partial refund' }).lean();
 const outcomes = await Promise.allSettled([first, secondLine].map(line => tx(session => refund.match(line._id, { billId: bill._id }, { session, req }))));
 expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
 expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
 expect(await CustomerRefund.countDocuments()).toBe(1);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
});

test('unknown refund posts to suspense, later links from the order without repeating the bank, and unlinking restores suspense', async () => {
 const { source, orderId, customer } = await seed(); const line = await incoming(source);
 await tx(session => bank.createEntryForLine(line._id, { pendingRefund: true }, { session, req }));
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 const suspense = await account('219100');
 expect((await getBalance(suspense._id)).usd).toBe(-6234);
 const input = { orderId, accountId: source._id, day: '2026-08-05', amount: 3013.22, walletUsd: 62 };
 const suggestions = await require('../services/posting/pendingRefund').candidates(input);
 expect(suggestions.map(row => String(row._id))).toContain(String(line._id));
 expect((await require('../services/posting/pendingRefund').candidates({ ...input, day: '2026-10-05' }, null, { allDates: true })).map(row => String(row._id))).toContain(String(line._id));
 await expect(tx(session => createCustomerRefund(input, { session, req }))).rejects.toThrow(/قيد التحديد|اختره واعتمد الربط/);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 const doc = await tx(session => createCustomerRefund({ ...input, pendingBankLineId: line._id }, { session, req }));
 expect(doc).toMatchObject({ usd: 6234, walletUsd: 6200, amount: 3013.22 });
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect((await getBalance(suspense._id)).usd).toBe(0);
 expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(62);
 await tx(session => cancelDocument('AccountingCustomerRefund', doc._id, { session, req, reason: 'wrong order' }));
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
 expect((await getBalance(suspense._id)).usd).toBe(-6234);
 expect((await BankStatementLine.findById(line._id))).toMatchObject({ lineStatus: 'created_entry', pendingRefund: true });
 const again = await tx(session => createCustomerRefund({ ...input, pendingBankLineId: line._id }, { session, req }));
 await tx(session => bank.cancelLineEntry(line._id, { session, req, reason: 'wrong bank refund' }));
 expect((await CustomerRefund.findById(again._id)).status).toBe('canceled');
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 expect((await getBalance(suspense._id)).usd).toBe(0);
 expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(0);
});

test('USD matching can identify a suspense refund while multiple candidates require choosing the actual bank line', async () => {
 const { source, orderId } = await seed(); const first = await incoming(source);
 await tx(session => bank.createEntryForLine(first._id, { pendingRefund: true }, { session, req }));
 await incoming(source, { day: '2026-08-03', description: 'another unknown refund' });
 const second = await BankStatementLine.findOne({ description: 'another unknown refund' });
 await tx(session => bank.createEntryForLine(second._id, { pendingRefund: true }, { session, req }));
 const input = { orderId, accountId: source._id, day: '2026-08-05', amount: 62.34, usdValue: 62.34, walletUsd: 0 };
 expect(await require('../services/posting/pendingRefund').candidates(input)).toHaveLength(2);
 await expect(tx(session => createCustomerRefund(input, { session, req }))).rejects.toThrow('اختره');
 const doc = await tx(session => createCustomerRefund({ ...input, pendingBankLineId: second._id }, { session, req }));
 expect(doc.amount).toBe(3013.22);
 expect((await BankStatementLine.findById(first._id)).pendingRefund).toBe(true);
 expect(await getBalance(source._id)).toEqual({ usd: 12468, foreign: 602644 });
 await expect(tx(session => createCustomerRefund({ ...input, pendingBankLineId: second._id }, { session, req }))).rejects.toThrow();
});

test('concurrent claims on a suspense refund succeed once', async () => {
 const { source, orderId } = await seed(); const line = await incoming(source);
 await tx(session => bank.createEntryForLine(line._id, { pendingRefund: true }, { session, req }));
 const input = { orderId, accountId: source._id, day: line.day, amount: 3013.22, pendingBankLineId: line._id };
 const results = await Promise.allSettled([1,2].map(() => tx(session => createCustomerRefund(input, { session, req }))));
 expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
 expect(await CustomerRefund.countDocuments()).toBe(1);
 expect(await getBalance(source._id)).toEqual({ usd: 6234, foreign: 301322 });
});

test('unknown historical refunds preserve the opening bank balance when posted and later identified', async () => {
 const { source, orderId } = await seed();
 await require('../models').MigrationRun.collection.insertOne({ runId: 'PENDING-COUNT', status: 'committed', cutoff: new Date('2026-09-03T12:00:00Z'),
  countAt: new Date('2026-09-03T12:00:00Z'), committedAt: new Date(), config: { countDay: '2026-09-03', openingCounts: [{ accountId: source._id }] } });
 require('../services/config').invalidateConfig();
 const line = await incoming(source);
 await tx(session => bank.createEntryForLine(line._id, { pendingRefund: true }, { session, req }));
 await tx(session => createCustomerRefund({ orderId, accountId: source._id, day: line.day, amount: 3013.22, pendingBankLineId: line._id }, { session, req }));
 expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
 expect((await getBalance((await account('219100'))._id)).usd).toBe(0);
});
