const { JournalEntry } = require('../../models');
const { SupplierPayment, BankStatementLine } = require('../../models/documents');
const { getConfig } = require('../config');
const { resolveAccount } = require('../roles');
const { originalOf, paymentValue } = require('./bankAmounts');
const { fail, currencyOf, lockPostingAccounts, valueOut, moneyLine, addFxLine } = require('./common');

// Reclassify an existing full historical suspense payment. Never create another cost,
// reopen the bill, or rewrite an entry dated before the opening count.
async function inspect(bill, bank, line, { session } = {}) {
  const { count, currencies } = await getConfig();
  if (!count || !count.accountIds.has(String(bank._id)) || !line?.day || line.amount >= 0
    || bill.status !== 'posted' || bill.isCreditNote
    || line.day < count.day || (line.day === count.day && count.endOfDay)) return null;
  const suspense = await resolveAccount('migration_suspense');
  const payments = await SupplierPayment.find({ status: 'posted', 'allocations.billId': bill._id }).session(session || null).lean();
  if (payments.length !== 1) return null;
  const payment = payments[0];
  if (!payment.isHistorical || String(payment.fromAccountId) !== String(suspense._id)
    || payment.allocations.length !== 1 || payment.advanceUsd || payment.costDifferenceUsd || !payment.entryId) return null;
  const original = originalOf(line, currencyOf(bank), currencies.get(currencyOf(bank))?.decimals ?? 2);
  const total = bill.total ?? bill.lines.reduce((sum, item) => sum + Number(item.amount), 0);
  if (original.currency !== bill.currency || Math.abs(original.amount - total) > 0.0005) return null;
  const payables = require('./payables');
  if (await payables.apBalance(payables.billKey(bill._id), session) !== 0) return null;
  const entry = await JournalEntry.findById(payment.entryId).session(session || null).lean();
  if (!entry || entry.status !== 'posted' || entry.reversalOf) return null;
  const suspenseUsd = entry.lines.filter(item => String(item.accountId) === String(suspense._id))
    .reduce((sum, item) => sum + item.credit - item.debit, 0);
  if (!(suspenseUsd > 0) || suspenseUsd !== payment.allocations[0].amountUsd || suspenseUsd !== bill.totalUsd) return null;
  if (await BankStatementLine.exists({ _id: { $ne: line._id }, lineStatus: { $in: ['matched', 'created_entry'] },
    $or: [{ historicalSettlementPaymentId: payment._id }, { billId: bill._id, amount: { $lt: 0 } }] }).session(session || null)) return null;
  return { payment, suspense, suspenseUsd, entry, display: {
    paymentId: payment._id, paymentNumber: payment.number, paymentDay: payment.day,
    accountId: suspense._id, accountName: suspense.name, entryNumber: entry.number, amountUsd: suspenseUsd / 100,
    explanation: 'تسوية السداد التاريخي من المعلّق مع البنك بتاريخ الكشف؛ تبقى الفاتورة والتكلفة الأصلية دون تكرار.',
  } };
}

async function settle(line, bank, bill, input, { session, req }) {
  require('./alipayReconciliation').assertWallet(line);
  if (line.lineStatus !== 'unmatched' || line.entryId || line.historicalPurchase) throw fail('التسوية تحتاج سطر بنك غير مرحّل؛ ألغِ ترحيله السابق أولاً');
  if (input.confirmHistoricalSettlement !== true) throw fail('راجع السداد التاريخي وأكد تسويته مع البنك');
  await require('./payables').lockBillAllocation(bill, session);
  const candidate = await inspect(bill, bank, line, { session });
  if (!candidate) throw fail('الفاتورة غير متاحة للتسوية: يلزم سداد تاريخي كامل من المعلّق، بنفس المبلغ والعملة، ودون ربط سابق');
  const claimed = await SupplierPayment.updateOne({ _id: candidate.payment._id, status: 'posted' }, { $inc: { historicalSettlementVersion: 1 } }, { session });
  if (claimed.modifiedCount !== 1) throw fail('السداد التاريخي لم يعد متاحًا');
  await lockPostingAccounts([bank, candidate.suspense], session);
  const value = await paymentValue(line, bank, {}, session);
  const bankUsd = await valueOut(bank, Math.abs(line.amount), { day: line.day, rates: value.rates, docRate: value.rate });
  const lines = [{ accountId: candidate.suspense._id, debit: candidate.suspenseUsd, vendorId: bill.vendorId,
    label: `تسوية السداد التاريخي ${candidate.payment.number} للفاتورة ${bill.number}` },
  moneyLine(bank, 'credit', Math.abs(line.amount), bankUsd, { label: line.description })];
  await addFxLine(lines, bank.office);
  const entry = await require('../ledger').postEntry({ eventType: 'BANK_HISTORICAL_SETTLEMENT',
    eventKey: `BANK_HISTORICAL_SETTLEMENT:${line._id}:${line.postingAttempt || 0}`, date: line.day,
    description: `تسوية سداد تاريخي ${bill.number} من كشف ${bank.name}`,
    source: { model: 'AccountingBankStatementLine', id: line._id }, lines, fallbacks: value.rates.fallbacks,
  }, { session, user: req?.user, onLocked: 'reject' });
  await value.rates.lock();
  Object.assign(line, { entryId: entry._id, billId: bill._id, billCreatedFromStatement: false, lineStatus: 'created_entry',
    historicalSettlementPaymentId: candidate.payment._id, historicalSettlementUsd: candidate.suspenseUsd,
    matchedOriginalAmount: value.original.amount, matchedOriginalCurrency: value.original.currency,
    matchDifferenceConfirmed: !!input.confirmDifference, purchaseReviewPending: false,
    valuationUsd: bankUsd / 100, valuationSource: value.valuationSource, exchangeRate: value.rate });
  const orderIds = [...new Set(bill.lines.filter(item => item.orderId).map(item => String(item.orderId)))];
  if (orderIds.length === 1) line.orderId = orderIds[0];
  await line.save({ session });
  await require('../audit').logAudit({ req, action: 'bank.historicalSettlement', model: 'AccountingBankStatementLine', docId: line._id,
    after: { billId: bill._id, historicalPaymentId: candidate.payment._id, entryId: entry._id, suspenseUsd: candidate.suspenseUsd, bankUsd } }, session);
  await require('./bankMerchants').learn(line, bill.vendorId, null, session);
  return { settled: true, billId: bill._id, entryId: entry._id };
}
module.exports = { inspect, settle };
