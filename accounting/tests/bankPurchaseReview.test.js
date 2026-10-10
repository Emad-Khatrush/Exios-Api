const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { CurrencyRate, JournalEntry } = require('../models');
const { Vendor, SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const Order = require('../../models/order');
const { runInTransaction } = require('../services/transaction');
const bank = require('../services/posting/bank');
const review = require('../services/posting/bankPurchaseReview');
const payables = require('../services/posting/payables');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
const tx = fn => runInTransaction(fn);
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => { await resetDb(); await CurrencyRate.create({ currency: 'TRY', day: '2026-01-01', rate: 50 }); });
async function order(number, amount, date = '2026-09-20T10:00:00Z') {
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: number, customerId: number, phone: `test-${number}` })).insertedId;
  const itemId = oid();
  const id = (await Order.collection.insertOne({ orderId: number, user: customer, placedAt: 'tripoli', totalInvoice: 100,
    isPayment: true, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date(date),
    purchaseItems: [{ _id: itemId, unitPrice: amount, currency: 'USD', date: new Date(date), description: `purchase ${number}` }] })).insertedId;
  return { id, itemId };
}
async function bill(amount, currency = 'USD', day = '2026-09-20', options = {}) {
  const vendor = await Vendor.create({ name: `Vendor-${oid()}`, type: 'supplier' });
  const expense = await account('530800');
  return tx(session => payables.createBill({ vendorId: vendor._id, day, currency, ...(currency !== 'USD' && { rate: currency === 'KWD' ? 3.1 : 0.9 }),
    lines: [{ description: 'review purchase', amount, ...(options.orderId ? { target: 'order', orderId: options.orderId } : { target: 'expense', accountId: expense._id, office: 'turkey' }) }] },
  { session, req, asDraft: options.asDraft !== false }));
}
async function imported(extra = {}) {
  const source = await account('110204');
  const row = { day: '2026-09-20', description: 'Bank purchase', amount: -2750, originalAmount: 55, originalCurrency: 'USD', ...extra };
  await bank.importStatement(source._id, [row], { req });
  return { source, row, line: await BankStatementLine.findOne({ accountId: source._id }).lean() };
}
test('a known merchant mismatch needs confirmation; once confirmed the match is made and the merchant is corrected', async () => {
  const original = await bill(55);
  await Vendor.create({ name: 'Alibaba review merchant', type: 'supplier', bankAliases: ['Alibaba.com Luxembourg'] });
  const { line, source } = await imported({ description: 'Alibaba.com Luxembourg (55.00 USD)' });
  const result = await review.listPurchases({ accountId: String(source._id), lineId: String(line._id), status: 'all' });
  // Shown with its warning, and selectable
  expect(result.results.find(r => String(r.billId) === String(original._id))).toMatchObject({ merchantMismatch: true, canMatch: true });
  const entries = await JournalEntry.countDocuments();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }))).rejects.toThrow('مختلف عن تاجر الكشف');
  await expect(tx(session => bank.createEntryForLine(line._id, { billId: original._id, manualBillMatch: true, confirmDifference: true }, { session, req }))).rejects.toThrow('مختلف عن تاجر الكشف');
  expect(await JournalEntry.countDocuments()).toBe(entries);
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true, confirmMerchant: true }, { session, req }));
  expect((await BankStatementLine.findById(line._id)).lineStatus).not.toBe('unmatched');
  // The merchant on this account is now the bill's vendor: no warning next time
  const merchant = (await require('../services/posting/bankMerchants').matcher(source._id))(line);
  expect(String(merchant.vendorId)).toBe(String(original.vendorId));
  expect(merchant.learned).toBe(true);
});

test('a bill on the generic historical vendor never conflicts with the merchant, and keeps what was learned', async () => {
  const historical = await Vendor.findOne({ seedKey: 'historical_supplier' });
  const expense = await account('530800');
  const original = await tx(session => payables.createBill({ vendorId: historical._id, day: '2026-09-20', currency: 'USD',
    lines: [{ description: 'old purchase', amount: 55, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req }));
  const shop = await Vendor.create({ name: 'Alibaba review merchant', type: 'supplier', bankAliases: ['Alibaba.com Luxembourg'] });
  const { line, source } = await imported({ description: 'Alibaba.com Luxembourg (55.00 USD)' });
  const result = await review.listPurchases({ accountId: String(source._id), lineId: String(line._id), status: 'all' });
  expect(result.results.find(r => String(r.billId) === String(original._id))).toMatchObject({ merchantMismatch: false, genericVendor: true, canMatch: true });
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  const merchant = (await require('../services/posting/bankMerchants').matcher(source._id))(line);
  expect(String(merchant.vendorId)).toBe(String(shop._id));
});

test('Wasl Alipay payment-channel text does not block the real CNY supplier or learn a false merchant', async () => {
  const source = await account('110401');
  const description = 'حواله عبر Alipay بقيمة ¥9,925 تم الحساب بسعر صرف 6.56';
  const merchants = require('../services/posting/bankMerchants');
  const fake = await Vendor.create({ name: 'حواله عبر Alipay', type: 'supplier', bankAliases: ['Alipay'],
    bankMappings: [{ accountId: source._id, merchant: merchants.merchantKey(description) }] });
  const vendor = await Vendor.create({ name: 'Actual historical purchase supplier', type: 'supplier' });
  const expense = await account('530800'), capital = await account('310000');
  const original = await tx(session => payables.createBill({ vendorId: vendor._id, day: '2026-09-19', currency: 'CNY', rate: 6.56,
    lines: [{ description: 'CNY purchase', amount: 9925, target: 'expense', accountId: expense._id, office: 'tripoli' }] }, { session, req, asDraft: true }));
  await tx(session => require('../services/ledger').postEntry({ eventType: 'MANUAL', eventKey: 'TEST:WASL:FUND', date: '2026-09-01', description: 'Fund current account',
    lines: [{ accountId: source._id, debit: 500000 }, { accountId: capital._id, credit: 500000 }] }, { session, user: req.user }));
  await bank.importStatement(source._id, [{ day: '2026-09-19', description, amount: -1513, originalAmount: 9925, originalCurrency: 'CNY' }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id }).lean();
  const listed = await review.listPurchases({ accountId: source._id, lineId: line._id, status: 'all' });
  expect(listed.results.find(row => String(row.billId) === String(original._id))).toMatchObject({ canMatch: true, merchantMismatch: false, paymentChannel: 'Alipay' });
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  expect((await BankStatementLine.findById(line._id)).billId).toEqual(original._id);
  expect((await Vendor.findById(vendor._id)).bankMappings || []).toHaveLength(0);
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id }, { session, req }))).rejects.toThrow('غير مطابق');
  expect((await Vendor.findById(fake._id)).bankMappings).toHaveLength(1);
});
test('date and source filters separate direct bills, recorded orders and unrecorded order purchases without duplication', async () => {
  const recorded = await order('ORD-REC', 20);
  await order('ORD-RAW', 30);
  await order('ORD-OLD', 40, '2026-08-01T10:00:00Z');
  await bill(10); await bill(20, 'USD', '2026-09-20', { orderId: recorded.id }); await bill(40, 'USD', '2026-08-01');
  const source = await account('110204');
  const filters = { accountId: source._id, from: '2026-09-20', to: '2026-09-20' };
  const all = await review.listPurchases(filters);
  expect(all.total).toBe(3);
  expect(all.results.filter(r => r.kind === 'order_item')).toHaveLength(1);
  expect((await review.listPurchases({ ...filters, source: 'direct' })).results.map(r => r.amount)).toEqual([10]);
  const orderRows = (await review.listPurchases({ ...filters, source: 'order' })).results;
  expect(orderRows).toHaveLength(2);
  expect(orderRows.every(r => r.source === 'order')).toBe(true);
  expect((await review.listPurchases({ ...filters, q: 'ORD-RAW' })).total).toBe(1);
  expect((await review.listPurchases({ ...filters, q: '[invalid.*' })).total).toBe(0);
  await expect(review.listPurchases({ ...filters, from: '2026-10-01' })).rejects.toThrow('فترة البحث');
});
test('order date filters use the Libya accounting day for late-night purchases', async () => {
  await order('LATE-ORDER', 30, '2026-09-19T23:15:00Z');
  const source = await account('110204');
  expect((await review.listPurchases({ accountId: source._id, from: '2026-09-20', to: '2026-09-20', source: 'order' })).results[0].day).toBe('2026-09-20');
});
test('manual selection outside the automatic date window needs confirmation and settles the original invoice', async () => {
  const original = await bill(55, 'USD', '2026-09-01');
  const { line } = await imported();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id }, { session, req }))).rejects.toThrow('أكد الاختلاف');
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(1);
  expect(await payables.apBalance(payables.billKey(original._id))).toBe(0);
  expect((await BankStatementLine.findById(line._id)).matchedOriginalAmount).toBe(55);
});
test('confirmed KWD discrepancy retains the bank evidence and values a 173 KWD draft from the actual 564.38 USD settlement', async () => {
  const original = await bill(173, 'KWD');
  const { line } = await imported({ originalAmount: 17.3, originalCurrency: 'KWD', settlementUsd: 564.38, amount: -27924.44 });
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id }, { session, req }))).rejects.toThrow('أكد الاختلاف');
  await tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }));
  expect(await SupplierBill.findById(original._id).lean()).toMatchObject({ total: 173, totalUsd: 56438 });
  expect(await BankStatementLine.findById(line._id).lean()).toMatchObject({ originalAmount: 17.3, matchedOriginalAmount: 173, matchDifferenceConfirmed: true });
  expect(await SupplierBill.countDocuments()).toBe(1);
});
test('a different original currency is refused even when a difference was confirmed', async () => {
  const original = await bill(55, 'EUR'); const { line } = await imported();
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: original._id, confirmDifference: true }, { session, req }))).rejects.toThrow('عملة المشتريات');
  expect(await SupplierPayment.countDocuments()).toBe(0);
});
test('repeated USD 30 bank fees require a fresh explicit independent decision, then post once', async () => {
  const purchase = await order('7082-7827', 30, '2026-10-05T10:00:00Z');
  const source = await account('110202');
  const expense = await account('530400');
  const description = 'Muhabir Masraf 53 - 10374879 - 3 Hesaba Virman';
  const vendor = await Vendor.create({ name: 'Correspondent fees', type: 'supplier', bankAliases: [description] });
  const duplicates = require('../services/costDuplicates');
  const fee = day => ({ vendorId: vendor._id, day, currency: 'USD',
    lines: [{ description: 'Other transfer fee', amount: 30, target: 'expense', accountId: expense._id, office: 'turkey' }] });
  await tx(session => payables.createBill(fee('2026-09-28'), { session, req }));
  const second = fee('2026-09-29');
  const preview = await duplicates.preview(second);
  await tx(session => payables.createBill({ ...second, duplicateDecision: 'independent', duplicateReason: 'Fee for a separate transfer', duplicateFingerprint: preview.fingerprint }, { session, req }));
  await bank.importStatement(source._id, [{ day: '2026-09-30', description, reference: '234', amount: -30 }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id }).lean();
  const choice = { kind: 'order_item', orderId: purchase.id, itemId: purchase.itemId, confirmDifference: true };
  let blocked;
  try { await tx(session => review.matchPurchase(line._id, choice, { session, req })); } catch (error) { blocked = error; }
  expect(blocked.costDuplicatePreview.results).toHaveLength(2);
  expect(blocked.costDuplicatePreview.canConfirmIndependent).toBe(true);
  expect(await SupplierBill.countDocuments()).toBe(2);
  expect(await SupplierPayment.countDocuments()).toBe(0);
  const independent = { ...choice, duplicateDecision: 'independent', duplicateReason: 'Separate transfer reference 234', duplicateFingerprint: blocked.costDuplicatePreview.fingerprint };
  await expect(tx(session => review.matchPurchase(line._id, { ...independent, duplicateReason: 'short' }, { session, req }))).rejects.toThrow('تكلفة محتملة');
  await expect(tx(session => review.matchPurchase(line._id, { ...independent, duplicateFingerprint: 'stale' }, { session, req }))).rejects.toThrow('تكلفة محتملة');
  await tx(session => review.matchPurchase(line._id, independent, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(3);
  expect(await SupplierPayment.countDocuments()).toBe(1);
  const linked = await BankStatementLine.findById(line._id).lean();
  expect(linked.lineStatus).toBe('created_entry');
  const created = await SupplierBill.findById(linked.billId).lean();
  expect(created.duplicateReason).toBe(independent.duplicateReason);
  expect(created.lines[0].purchaseItemId).toEqual(purchase.itemId);
  await expect(tx(session => review.matchPurchase(line._id, independent, { session, req }))).rejects.toThrow('غير مطابق');
  expect(await SupplierBill.countDocuments()).toBe(3);
});

test('duplicate supplier invoice reference cannot be confirmed as independent', async () => {
  const vendor = await Vendor.create({ name: 'Reference guard', type: 'supplier' });
  const expense = await account('530400');
  const input = { vendorId: vendor._id, day: '2026-09-30', currency: 'USD', vendorRef: 'FEE-234',
    lines: [{ description: 'Fee', amount: 30, target: 'expense', accountId: expense._id, office: 'turkey' }] };
  await tx(session => payables.createBill(input, { session, req }));
  const preview = await require('../services/costDuplicates').preview(input);
  expect(preview.canConfirmIndependent).toBe(false);
  await expect(tx(session => payables.createBill({ ...input, duplicateDecision: 'independent', duplicateReason: 'Independent fee override attempt', duplicateFingerprint: preview.fingerprint }, { session, req }))).rejects.toThrow('رقم فاتورة المورد');
  expect(await SupplierBill.countDocuments()).toBe(1);
});

test('an unrecorded order item becomes one linked invoice and payment and cannot be matched again', async () => {
  const purchase = await order('RAW-MATCH', 30);
  const { line } = await imported({ originalAmount: 30, amount: -1500 });
  await tx(session => review.matchPurchase(line._id, { kind: 'order_item', orderId: purchase.id, itemId: purchase.itemId }, { session, req }));
  expect(await BankStatementLine.findById(line._id).lean()).toMatchObject({ orderId: purchase.id, purchaseItemId: purchase.itemId, matchedOriginalAmount: 30 });
  expect(await SupplierBill.countDocuments()).toBe(1); expect(await SupplierPayment.countDocuments()).toBe(1);
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'order_item', orderId: purchase.id, itemId: purchase.itemId }, { session, req }))).rejects.toThrow('غير مطابق');
});
test('multiple bill suggestions prefer the closest date and replace a stale farther proposal', async () => {
  const far = await bill(30, 'USD', '2026-10-05');
  const near = await bill(30, 'USD', '2026-09-29');
  await bill(40, 'USD', '2026-09-30');
  const { source, line } = await imported({ day: '2026-09-30', originalAmount: 30, amount: -1500 });
  const suggestions = await bank.suggestions(source._id);
  expect(String(suggestions[line._id].suggestedBillId)).toBe(String(near._id));
  expect(String(suggestions[line._id].billCandidates[0]._id)).toBe(String(near._id));
  const reviewRows = await review.listPurchases({ accountId: source._id, lineId: line._id, status: 'all', suggestedBillId: far._id });
  expect(String(reviewRows.proposal.billId)).toBe(String(near._id));
  expect(String(reviewRows.results[0].billId)).toBe(String(near._id));
  expect(await SupplierPayment.countDocuments()).toBe(0);
});

test('an exact transfer reference outranks date proximity among matching amounts and currencies', async () => {
  const far = await bill(30, 'USD', '2026-10-05');
  await SupplierBill.updateOne({ _id: far._id }, { $set: { vendorRef: 'REF-234' } });
  await bill(30, 'USD', '2026-09-29');
  const { source, line } = await imported({ day: '2026-09-30', reference: 'REF-234', originalAmount: 30, amount: -1500 });
  const suggestions = await bank.suggestions(source._id);
  expect(String(suggestions[line._id].suggestedBillId)).toBe(String(far._id));
  const reviewRows = await review.listPurchases({ accountId: source._id, lineId: line._id, suggestedBillId: far._id });
  expect(String(reviewRows.proposal.billId)).toBe(String(far._id));
});

test('multiple order purchase candidates suggest the nearest date without posting automatically', async () => {
  await order('FAR-DATE', 30, '2026-10-05T10:00:00Z');
  const near = await order('NEAR-DATE', 30, '2026-09-29T10:00:00Z');
  const { source, line } = await imported({ day: '2026-09-30', originalAmount: 30, amount: -1500 });
  const suggestions = await bank.suggestions(source._id);
  expect(String(suggestions[line._id].link.itemId)).toBe(String(near.itemId));
  expect(suggestions[line._id].requiresConfirmation).toBe(true);
  expect(await SupplierBill.countDocuments()).toBe(0);
});

test('a new SWIFT fee exposes its duplicate evidence and supports a reviewed independent retry', async () => {
  const original = await bill(26.25, 'USD', '2026-09-15', { asDraft: false });
  const otherBank = await account('110204');
  await tx(session => payables.createPayment({ vendorId: original.vendorId, day: '2026-09-15', fromAccountId: otherBank._id, amount: 1312.5, rate: 50,
    allocations: [{ billId: original._id, amountUsd: 2625 }] }, { session, req }));
  const source = await account('110202'), expense = await account('530400');
  const vendor = await Vendor.findById(original.vendorId).lean();
  await bank.importStatement(source._id, [{ day: '2026-09-15', description: '2030053260S00446 - SWIFT MASRAFI', reference: '1419', amount: -26.25 }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id }).lean();
  const input = { counterAccountId: expense._id, vendorName: vendor.name, office: 'turkey' };
  let error;
  try { await tx(session => bank.createEntryForLine(line._id, input, { session, req })); } catch (failure) { error = failure; }
  expect(error.costDuplicatePreview.results[0].billId).toEqual(original._id);
  expect(await SupplierBill.countDocuments()).toBe(1);
  const reason = 'SWIFT fee for a different transfer reference 1419';
  await tx(session => bank.createEntryForLine(line._id, { ...input, duplicateDecision: 'independent', duplicateReason: reason,
    duplicateFingerprint: error.costDuplicatePreview.fingerprint }, { session, req }));
  expect(await SupplierBill.countDocuments()).toBe(2);
  expect(await SupplierPayment.countDocuments()).toBe(2);
  const result = await BankStatementLine.findById(line._id).lean();
  expect(result.lineStatus).toBe('created_entry');
  expect((await SupplierBill.findById(result.billId)).duplicateReason).toBe(reason);
});

test('drafts are selectable, while paid bills explain a payment on a different bank', async () => {
  const draft = await bill(30);
  const paid = await bill(30, 'USD', '2026-09-20', { asDraft: false });
  const otherBank = await account('110202');
  await tx(session => payables.createPayment({ vendorId: paid.vendorId, day: '2026-09-20', fromAccountId: otherBank._id, amount: 30,
    allocations: [{ billId: paid._id, amountUsd: 3000 }] }, { session, req }));
  const { source, line } = await imported({ originalAmount: 30, amount: -1500 });
  const result = await review.listPurchases({ accountId: source._id, lineId: line._id, status: 'all' });
  expect(result.results.find(r => String(r.billId) === String(draft._id))).toMatchObject({ status: 'draft', canMatch: true, openUsd: null });
  const blocked = result.results.find(r => String(r.billId) === String(paid._id));
  expect(blocked).toMatchObject({ status: 'paid', canMatch: false, openUsd: 0 });
  expect(blocked.paymentMatchProblem).toContain('حساب آخر');
  expect(blocked.payments[0]).toMatchObject({ accountName: otherBank.name, sameBank: false });
  await expect(tx(session => review.matchPurchase(line._id, { kind: 'bill', billId: paid._id, confirmDifference: true }, { session, req }))).rejects.toThrow('قيد سداد وحيد');
  expect(await SupplierPayment.countDocuments()).toBe(1);
});

test('a paid invoice is reconciled to its existing bank payment without creating another payment', async () => {
  const original = await bill(55, 'USD', '2026-09-20', { asDraft: false });
  const source = await account('110204');
  const payment = await tx(session => payables.createPayment({ vendorId: original.vendorId, day: '2026-09-20', fromAccountId: source._id, amount: 2750, rate: 50,
    allocations: [{ billId: original._id, amountUsd: 5500 }] }, { session, req }));
  const { line } = await imported({ purchaseMatch: { kind: 'bill', billId: original._id } });
  expect(line.lineStatus).toBe('matched');
  expect(String(line.matchedEntryIds[0])).toBe(String(payment.entryId));
  expect(String(line.billId)).toBe(String(original._id));
  expect(line.purchaseReviewPending).toBe(false);
  expect(await SupplierPayment.countDocuments()).toBe(1);
});
test('manual selections during import use the selected original invoice and retain failed reviews for retry', async () => {
  const original = await bill(55);
  const { source, row, line } = await imported({ purchaseMatch: { kind: 'bill', billId: original._id } });
  expect(line.lineStatus).toBe('created_entry');
  expect(line.purchaseReviewPending).toBe(false);
  expect((await bank.importStatement(source._id, [row], { req })).posted).toBe(0);
  expect(await SupplierBill.countDocuments()).toBe(1);
  const sums = await JournalEntry.find().lean();
  expect(sums.every(e => e.lines.reduce((s, l) => s + l.debit - l.credit, 0) === 0)).toBe(true);
});
