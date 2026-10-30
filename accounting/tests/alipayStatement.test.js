const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction: tx } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { CurrencyRate, JournalEntry } = require('../models');
const { Vendor, BankStatementLine, SupplierBill } = require('../models/documents');
const alipay = require('../services/posting/alipay');
const bank = require('../services/posting/bank');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const ref = '20260922000000000000000000000001';
const row = (extra = {}) => ({ day: '2026-09-22', amount: 700, description: 'Alipay broker receipt', reference: ref,
  sourceProvider: 'alipay', sourceCurrency: 'CNY', sourceTransactionId: ref, walletImpact: 'balance', paymentMethod: '账户余额', transactionStatus: '交易成功', ...extra });
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'CNY', day: '2026-01-01', rate: 7 }); });
async function buy(extra = {}) {
  const wallet = await account('110301'); const cash = await account('110101');
  const vendor = await Vendor.create({ name: 'Alipay statement broker', type: 'service' });
  const purchase = await tx(session => alipay.createYuanPurchase({ vendorId: vendor._id, fromAccountId: cash._id, toAccountId: wallet._id,
    day: '2026-09-22', amount: 100, cnyReceived: 700, ...extra }, { session, req }));
  return { wallet, cash, vendor, purchase };
}
test('complete Alipay ID deduplicates descriptions and overlapping exports without changing the wallet', async () => {
  const wallet = await account('110301');
  const first = await bank.importStatement(wallet._id, [row()], { req });
  const second = await bank.importStatement(wallet._id, [row({ description: 'different export formatting' })], { req });
  expect(first.count).toBe(1); expect(second).toMatchObject({ count: 0, skipped: 1, posted: 0 });
  expect(await BankStatementLine.countDocuments()).toBe(1);
  expect(await getBalance(wallet._id)).toEqual({ usd: 0, foreign: 0 });
});
test('equal amounts with distinct IDs remain distinct; repeated identical rows are imported once', async () => {
  const wallet = await account('110301');
  const rows = [row(), row(), row({ sourceTransactionId: ref + '1', reference: ref + '1' })];
  const result = await bank.importStatement(wallet._id, rows, { req });
  expect(result.count).toBe(2); expect(await BankStatementLine.countDocuments()).toBe(2);
  expect((await bank.importStatement(wallet._id, [rows[2]], { req })).count).toBe(0);
});
test('same ID with altered amount or date is rejected instead of creating a second movement', async () => {
  const wallet = await account('110301');
  await bank.importStatement(wallet._id, [row()], { req });
  await expect(bank.importStatement(wallet._id, [row({ amount: 701 })], { req })).rejects.toThrow('مستورد مسبقًا');
  expect(await BankStatementLine.countDocuments()).toBe(1);
});
test('legacy ledger receipt is suggested for manual match; matching never receives yuan twice', async () => {
  const { wallet, purchase } = await buy();
  const result = await bank.importStatement(wallet._id, [row()], { req });
  expect(result.matched).toBe(0);
  const preview = await bank.classifyRows(wallet._id, [row({ sourceTransactionId: 'other-id', reference: 'other-id' })]);
  expect(preview[0].status).toBe('maybeDuplicate');
  const line = await BankStatementLine.findOne();
  const before = await getBalance(wallet._id); const count = await JournalEntry.countDocuments();
  await tx(session => bank.manualMatch(line._id, [purchase.entryId], { session, req }));
  expect(await getBalance(wallet._id)).toEqual(before); expect(await JournalEntry.countDocuments()).toBe(count);
});
test('recorded yuan purchase with exact reference auto matches an imported statement without additional entries', async () => {
  const { wallet } = await buy({ transactionReference: ref });
  const count = await JournalEntry.countDocuments();
  const result = await bank.importStatement(wallet._id, [row()], { req });
  expect(result.matched).toBe(1); expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
  expect(await getBalance(wallet._id)).toEqual({ usd: 10000, foreign: 70000 });
  expect(await JournalEntry.countDocuments()).toBe(count);
});
test('statement imported first auto matches when the yuan purchase is recorded later using its reference', async () => {
  const wallet = await account('110301');
  await bank.importStatement(wallet._id, [row()], { req });
  await buy({ transactionReference: ref });
  expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
  expect(await getBalance(wallet._id)).toEqual({ usd: 10000, foreign: 70000 });
});
test('missing wallet method blocks posting/matching until evidence is explicitly confirmed', async () => {
  const { wallet, purchase } = await buy();
  await bank.importStatement(wallet._id, [row({ paymentMethod: '', walletImpact: 'unknown' })], { req });
  const line = await BankStatementLine.findOne();
  await expect(tx(session => bank.manualMatch(line._id, [purchase.entryId], { session, req }))).rejects.toThrow('أكد وصول المبلغ');
  await tx(session => bank.editLine(line._id, { ...row(), paymentMethod: '', walletImpact: 'unknown', reason: 'Verified wallet receipt', confirmWalletImpact: true }, { session, req }));
  expect((await BankStatementLine.findById(line._id)).walletImpact).toBe('confirmed');
  await tx(session => bank.manualMatch(line._id, [purchase.entryId], { session, req }));
  expect(await getBalance(wallet._id)).toEqual({ usd: 10000, foreign: 70000 });
});
test('Alipay external-card transactions and other currency accounts are rejected', async () => {
  const wallet = await account('110301'); const cash = await account('110101');
  await expect(bank.importStatement(wallet._id, [row({ paymentMethod: '银行卡' })], { req })).rejects.toThrow('ليست مدفوعة');
  await expect(bank.importStatement(cash._id, [row()], { req })).rejects.toThrow('CNY');
});
test('refund is marked for review; generic incoming yuan cannot be posted as revenue', async () => {
  const wallet = await account('110301'); const income = await account('410300');
  const classes = await bank.classifyRows(wallet._id, [row({ amount: 29, movementKind: 'purchase_refund', originalCurrency: 'CNY', originalAmount: 29 })]);
  expect(classes[0]).toMatchObject({ isRefund: true, requiresConfirmation: true, account: null });
  await bank.importStatement(wallet._id, [row()], { req });
  const line = await BankStatementLine.findOne();
  await expect(tx(session => bank.createEntryForLine(line._id, { counterAccountId: income._id }, { session, req }))).rejects.toThrow('لا يُسجل إيرادًا');
});
test('an already matched receipt prevents a second yuan purchase from posting', async () => {
  const { wallet, cash, vendor } = await buy({ transactionReference: ref });
  await bank.importStatement(wallet._id, [row()], { req });
  const count = await JournalEntry.countDocuments();
  await expect(tx(session => alipay.createYuanPurchase({ vendorId: vendor._id, fromAccountId: cash._id, toAccountId: wallet._id,
    day: '2026-09-22', amount: 100, cnyReceived: 700, transactionReference: ref }, { session, req }))).rejects.toThrow('حركة ثانية');
  expect(await JournalEntry.countDocuments()).toBe(count);
});
test('concurrent imports of the same Alipay transaction create one statement line', async () => {
  const wallet = await account('110301');
  const results = await Promise.all([bank.importStatement(wallet._id, [row()], { req }), bank.importStatement(wallet._id, [row()], { req })]);
  expect(results.reduce((s, r) => s + r.count, 0)).toBe(1); expect(await BankStatementLine.countDocuments()).toBe(1);
});
test('pending yuan arrives once and its arrival reference matches the statement at the original purchase cost', async () => {
  const { wallet, purchase } = await buy({ arrived: false, cnyExpected: 700 });
  await bank.importStatement(wallet._id, [row({ day: '2026-09-24' })], { req });
  await tx(session => alipay.completeYuanPurchase(purchase._id, { cnyReceived: 700, day: '2026-09-24', transactionReference: ref }, { session, req }));
  expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
  expect(await getBalance(wallet._id)).toEqual({ usd: 10000, foreign: 70000 });
  const count = await JournalEntry.countDocuments();
  await expect(tx(session => alipay.completeYuanPurchase(purchase._id, { cnyReceived: 700, day: '2026-09-24', transactionReference: ref }, { session, req }))).rejects.toThrow('وصل مسبقاً');
  expect(await JournalEntry.countDocuments()).toBe(count);
});
test('known reference mismatch cannot be manually matched even when date and amount are equal', async () => {
  const { wallet, purchase } = await buy({ transactionReference: 'correct-reference' });
  await bank.importStatement(wallet._id, [row()], { req });
  const line = await BankStatementLine.findOne();
  await expect(tx(session => bank.manualMatch(line._id, [purchase.entryId], { session, req }))).rejects.toThrow('يختلف');
});
test('cancelled yuan purchase releases its statement and only the replacement can match it again', async () => {
  const { wallet, purchase } = await buy({ transactionReference: ref });
  await bank.importStatement(wallet._id, [row()], { req });
  await tx(session => require('../services/cancel').cancelDocument('AccountingYuanPurchase', purchase._id, { session, req, reason: 'Correct the purchase' }));
  expect((await BankStatementLine.findOne()).lineStatus).toBe('unmatched');
  expect(await getBalance(wallet._id)).toEqual({ usd: 0, foreign: 0 });
  expect((await tx(session => bank.autoMatch(wallet._id, { session, req }))).matched).toBe(0);
  const replacement = await buy({ transactionReference: ref });
  expect((await BankStatementLine.findOne()).matchedEntryIds.map(String)).toEqual([String(replacement.purchase.entryId)]);
  expect(await getBalance(wallet._id)).toEqual({ usd: 10000, foreign: 70000 });
});
test('original and explicitly corrected Alipay evidence both deduplicate after editing', async () => {
  const wallet = await account('110301');
  await bank.importStatement(wallet._id, [row()], { req });
  const line = await BankStatementLine.findOne();
  await tx(session => bank.editLine(line._id, { ...row({ amount: 701 }), reason: 'Correct from bank evidence' }, { session, req }));
  expect((await bank.importStatement(wallet._id, [row()], { req })).count).toBe(0);
  expect((await bank.importStatement(wallet._id, [row({ amount: 701 })], { req })).count).toBe(0);
});
test('remittance reference matches the statement and idempotent retry creates no duplicate cost', async () => {
  const { wallet } = await buy();
  const customer = (await mongoose.connection.collection('users').insertOne({ customerId: 'ALIPAY-TEST', firstName: 'Statement test' })).insertedId;
  const orderId = (await require('../../models/order').collection.insertOne({ orderId: 'ALIPAY-ORDER', user: customer, placedAt: 'tripoli', isRemittance: true,
    isPayment: true, totalInvoice: 100, purchaseItems: [], paymentList: [], createdAt: new Date('2026-09-22') })).insertedId;
  const outgoing = row({ amount: -350, sourceTransactionId: 'remit-ref', reference: 'remit-ref' });
  await bank.importStatement(wallet._id, [outgoing], { req });
  const input = { accountId: wallet._id, cny: 350, day: '2026-09-22', transactionReference: 'remit-ref', idempotencyKey: 'alipay-statement-test' };
  const first = await tx(session => alipay.sendRemittance(orderId, input, { session, req }));
  const before = await getBalance(wallet._id); const count = await JournalEntry.countDocuments();
  const second = await tx(session => alipay.sendRemittance(orderId, input, { session, req }));
  expect(String(second._id)).toBe(String(first._id)); expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await getBalance(wallet._id)).toEqual(before); expect(await JournalEntry.countDocuments()).toBe(count);
  expect((await BankStatementLine.findOne()).lineStatus).toBe('matched');
});
