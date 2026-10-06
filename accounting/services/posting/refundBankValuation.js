const { CustomerRefund } = require('../../models/documents');
const Order = require('../../../models/order');
const { postEntry } = require('../ledger');
const { logAudit } = require('../audit');
const { fail, getAccount, currencyOf, toCurrencyMinor, resolveAccount, lockPostingAccounts } = require('./common');

// The bank's native amount has already been matched. Correct only its USD book
// valuation; never repeat native cash, wallet payments, or the original refund.
async function reconcile(refundId, line, { session, req }) {
  const refund = await CustomerRefund.findById(refundId).session(session);
  if (!refund || refund.status !== 'posted' || String(refund.accountId) !== String(line.accountId)) throw fail('الريفاند غير متاح لهذا البنك');
  const account = await getAccount(refund.accountId, 'حساب الاسترداد');
  if (await toCurrencyMinor(refund.amount, currencyOf(account)) !== line.amount) throw fail('مبلغ الاسترداد بعملة البنك لا يطابق الكشف');
  if (refund.originalCurrency && line.originalCurrency && refund.originalCurrency !== line.originalCurrency) throw fail('عملة الاسترداد الأصلية لا تطابق الكشف');
  const printedUsd = Number(line.settlementUsd) || (line.originalCurrency === 'USD' ? Number(line.originalAmount) : 0);
  if (!Number.isFinite(printedUsd) || printedUsd < 0) throw fail('مقابل الدولار غير صالح');
  if (currencyOf(account) === 'USD' && printedUsd > 0 && Math.round(printedUsd * 100) !== line.amount) throw fail('مقابل الدولار يخالف مبلغ الحركة على حساب الدولار');
  const beforeUsd = refund.usd;
  const afterUsd = printedUsd > 0 ? Math.round(printedUsd * 100) : beforeUsd;
  const difference = afterUsd - beforeUsd;
  if (difference) {
    await lockPostingAccounts([account], session);
    const order = await Order.findById(refund.orderId).select('placedAt').session(session).lean();
    if (!order) throw fail('طلبية الاسترداد غير موجودة');
    const value = Math.abs(difference);
    const entry = await postEntry({ eventType: 'REFUND',
      eventKey: `REFUND_BANK_VALUE:${refund._id}:${line._id}:${line.postingAttempt || 0}`,
      date: line.day, description: `تسوية تقييم ${refund.number} حسب كشف البنك: ${beforeUsd / 100} → ${afterUsd / 100} USD`,
      source: { model: 'AccountingCustomerRefund', id: refund._id }, lines: [
        { accountId: account._id, currency: currencyOf(account), amountCurrency: 0,
          ...(difference > 0 ? { debit: value } : { credit: value }), label: 'تصحيح مقابل الدولار؛ دون حركة جديدة بعملة البنك' },
        { accountId: (await resolveAccount('purchase_cost_wip'))._id, orderId: refund.orderId, office: order.placedAt,
          ...(difference > 0 ? { credit: value } : { debit: value }), label: 'تصحيح قيمة ما أعاده المورد للطلبية' },
      ] }, { session, user: req?.user });
    if (refund.bankValuationBeforeUsd == null) refund.bankValuationBeforeUsd = beforeUsd;
    refund.bankValuationEntryIds.push(entry._id);
    refund.usd = afterUsd;
  }
  refund.bankLineId = line._id;
  if (line.originalCurrency && Number(line.originalAmount) > 0) {
    refund.originalCurrency = line.originalCurrency; refund.originalAmount = Number(line.originalAmount);
  }
  await refund.save({ session });
  if (difference) {
    await require('../claims/sync').syncOrder(refund.orderId, { session, user: req?.user, date: line.day });
    await logAudit({ req, action: 'customer.refundBankValuation', model: 'AccountingCustomerRefund', docId: refund._id,
      before: { usd: beforeUsd }, after: { usd: afterUsd, differenceUsd: difference, walletUsd: refund.walletUsd, bankLineId: line._id } }, session);
  }
  return refund;
}
module.exports = { reconcile };
