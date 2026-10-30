// Correct earlier bank identifications which debited suspense after its migration
// close. Keep the original bank movement, supplier payment, bill and match intact.
const { JournalEntry } = require('../../models');
const { BankStatementLine, SupplierPayment, SupplierBill } = require('../../models/documents');
const { assertInTransaction } = require('../transaction');
const { lockPeriod } = require('../periodLock');
const { postEntry } = require('../ledger');
const { getBalance } = require('../carrying');
const { today, addDays } = require('../dates');
const { logAudit } = require('../audit');
const { resolveAccount } = require('../roles');
const { fail, lockPostingAccounts } = require('./common');
const { counterpartFor } = require('./historicalPaymentCounterpart');

async function repair(lineId, { session, req, reason }) {
  assertInTransaction(session);
  if (!String(reason || '').trim()) throw fail('سبب التصحيح مطلوب');
  const settings = await lockPeriod(session);
  if (!settings?.liveEnabled) throw fail('فعّل الترحيل المحاسبي قبل تصحيح التسوية');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'created_entry' || !line.historicalSettlementPaymentId || !line.entryId || !line.billId) throw fail('ربط السداد التاريخي غير متاح للتصحيح');
  const bill = await SupplierBill.findById(line.billId).session(session);
  if (!bill || bill.status !== 'posted') throw fail('الفاتورة غير متاحة');
  await require('./payables').lockBillAllocation(bill, session);
  if (await require('./payables').apBalance(require('./payables').billKey(bill._id), session) !== 0) throw fail('الفاتورة ليست مسددة بالكامل؛ راجع دفعاتها');
  const payment = await SupplierPayment.findById(line.historicalSettlementPaymentId).session(session).lean();
  const originalPayment = payment?.entryId && await JournalEntry.findById(payment.entryId).session(session).lean();
  const settlement = await JournalEntry.findById(line.entryId).session(session).lean();
  const suspense = await resolveAccount('migration_suspense');
  if (!payment?.isHistorical || payment.status !== 'posted' || !originalPayment || originalPayment.status !== 'posted' ||
    String(payment.fromAccountId) !== String(suspense._id) || payment.allocations.length !== 1 ||
    String(payment.allocations[0].billId) !== String(bill._id) || payment.advanceUsd || payment.costDifferenceUsd ||
    !settlement || settlement.status !== 'posted' || settlement.reversalOf || settlement.eventType !== 'BANK_HISTORICAL_SETTLEMENT' ||
    settlement.source?.model !== 'AccountingBankStatementLine' || String(settlement.source.id) !== String(line._id)) throw fail('تغير السداد أو قيد البنك؛ راجع البيانات');
  const { account: opening, closure } = await counterpartFor(payment, originalPayment, suspense, { session });
  if (!closure) throw fail('السداد لم يكن ضمن إقفال المعلّق؛ لا ينطبق عليه هذا التصحيح');
  const key = `BANK_HISTORICAL_SETTLEMENT_CLOSE:${settlement._id}`;
  const existing = await JournalEntry.findOne({ eventKey: key }).session(session).lean();
  if (existing) {
    if (existing.status !== 'posted') throw fail('قيد التصحيح مُلغى؛ راجعه قبل محاولة التصحيح مجددًا');
    return { alreadyCorrected: true, entryId: existing._id, number: existing.number };
  }
  const suspenseLines = settlement.lines.filter(item => String(item.accountId) === String(suspense._id));
  const amount = suspenseLines.reduce((sum, item) => sum + item.debit - item.credit, 0);
  const historicalAmount = originalPayment.lines.filter(item => String(item.accountId) === String(suspense._id))
    .reduce((sum, item) => sum + item.credit - item.debit, 0);
  if (suspenseLines.length !== 1 || !Number.isSafeInteger(amount) || amount <= 0 || amount !== historicalAmount ||
    amount !== line.historicalSettlementUsd || amount !== payment.allocations[0].amountUsd || amount !== bill.totalUsd ||
    !settlement.lines.some(item => String(item.accountId) === String(line.accountId) && item.credit > 0)) throw fail('الفرق لا يطابق أصل السداد التاريخي؛ لن يُنشأ قيد موازنة مجهول');
  const index = settlement.lines.indexOf(suspenseLines[0]);
  const manuallySettled = await JournalEntry.exists({ eventKey: new RegExp(`^MANUAL:SETTLE:${settlement._id}:${index}:`), status: 'posted' }).session(session);
  if (manuallySettled) throw fail('البند سُوّي يدويًا سابقًا؛ راجع المعالجة السابقة أولًا');
  await lockPostingAccounts([suspense, opening], session);
  const before = await getBalance(suspense._id, { session });
  const day = settings?.lockDate && today() <= settings.lockDate ? addDays(settings.lockDate, 1) : today();
  const correction = await postEntry({ eventType: 'BANK_HISTORICAL_SETTLEMENT_CLOSE', eventKey: key, date: day, journalCode: 'GEN',
    description: `تصحيح أثر إقفال السداد التاريخي ${settlement.number} — ${reason}`,
    source: { model: 'AccountingBankStatementLine', id: line._id },
    notes: [`السداد الأصلي ${payment.number}، الفاتورة ${bill.number}`, `الإقفال التاريخي ${closure.number}`,
      'تصحيح الحساب المقابل فقط؛ ربط الكشف وحركته البنكية والتكلفة والسداد الأصلي محفوظة'],
    lines: [
      { accountId: opening._id, debit: amount, credit: 0, vendorId: bill.vendorId, label: 'نقل أثر السداد المقفل إلى الرصيد الافتتاحي' },
      { accountId: suspense._id, debit: 0, credit: amount, vendorId: bill.vendorId, label: `إقفال أثر ${settlement.number}` },
    ],
  }, { session, user: req?.user, onLocked: 'reject' });
  const after = await getBalance(suspense._id, { session });
  if (after.usd !== before.usd - amount || after.foreign !== before.foreign - amount) throw fail('أثر تصحيح المعلّق غير متوقع؛ أُلغيت العملية');
  await logAudit({ req, action: 'bank.historicalSettlement.closeCorrection', model: 'AccountingBankStatementLine', docId: line._id,
    before: { originalEntryId: settlement._id, suspenseBalance: before },
    after: { entryId: correction._id, originalEntryId: settlement._id, paymentId: payment._id, billId: bill._id,
      closureId: closure._id, counterpartId: opening._id, suspenseBalance: after, amountUsd: amount, reason } }, session);
  return { alreadyCorrected: false, entryId: correction._id, number: correction.number, amountUsd: amount };
}

module.exports = { repair };
