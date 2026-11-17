// A statement line a few cents or days off a supplier payment already in the books (owner 2026-11-17:
// IKEA 10,654.81 on the Alipay statement, 10,654.83 typed in the books). The statement is the truth:
// the payment is corrected to the line's amount and day, then the line is matched to it.
//  - paid on the spot with its bill: the bill itself is corrected (its last line takes the
//    difference, its day becomes the statement day); the bill edit replaces its payment;
//  - a payment made on its own: canceled and made again at the statement amount and day, paying
//    the same bills (less of the last one, or more up to what it still owes, the rest an advance).
const mongoose = require('mongoose');
const { BankStatementLine, SupplierBill, SupplierPayment } = require('../../models/documents');
const { getConfig } = require('../config');
const { logAudit } = require('../audit');
const { fail, currencyOf } = require('./common');

async function correct(lineId, input, { session, req }) {
  if (!mongoose.isValidObjectId(lineId) || !mongoose.isValidObjectId(input.entryId)) throw fail('اختر سطر الكشف والقيد المسجل');
  const reason = String(input.reason || '').trim().slice(0, 500);
  if (!reason) throw fail('اكتب سبب التصحيح');
  const bank = require('./bank');
  const payables = require('./payables');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  const twin = (await bank.possibleDuplicates(line, session)).find((t) => String(t._id) === String(input.entryId));
  if (!twin) throw fail('القيد المختار ليس قريبًا من مبلغ السطر وتاريخه؛ طابقه أو صحّحه من قسمه');
  const payment = await SupplierPayment.findOne({ entryId: twin._id, status: 'posted' }).session(session).lean();
  if (!payment) throw fail('التصحيح من الكشف متاح لدفعات الموردين؛ صحّح هذا المستند من قسمه ثم طابقه');
  const { currencies, accountsById } = await getConfig();
  const currency = currencyOf(accountsById.get(String(line.accountId)) || {});
  if (payment.currency && payment.currency !== currency) throw fail(`الدفعة بعملة ${payment.currency} والكشف بعملة ${currency}؛ صحّحها من صفحة الدفعات`);
  const decimals = currencies.get(currency)?.decimals ?? 2;
  const unit = 10 ** decimals;
  const round = (value) => Math.round(value * unit) / unit;
  const newMinor = -line.amount;
  const oldMinor = Math.round(Number(payment.amount) * unit);
  const note = `تصحيح حسب كشف ${line.day} (${newMinor / unit} بدل ${oldMinor / unit}): ${reason}`;
  let entryId;

  if (payment.autoFromBillId) {
    const bill = await SupplierBill.findById(payment.autoFromBillId).session(session).lean();
    if (!bill || bill.status !== 'posted' || bill.currency !== currency) throw fail('فاتورة الدفعة غير متاحة للتصحيح؛ صحّحها من صفحتها');
    const lines = bill.lines.map((l) => ({ _id: l._id, description: l.description, amount: Number(l.amount), target: l.target, office: l.office,
      accountId: l.accountId, tripId: l.tripId, orderId: l.orderId, packageId: l.packageId, costCategory: l.costCategory }));
    const last = lines[lines.length - 1];
    last.amount = round(last.amount + (newMinor - oldMinor) / unit);
    if (!(last.amount > 0)) throw fail('الفرق أكبر من آخر سطر في الفاتورة؛ صحّحها من صفحتها');
    const edit = { updatedAt: bill.updatedAt, day: line.day, reason: note, vendorId: bill.vendorId, vendorRef: bill.vendorRef, note: bill.note,
      currency: bill.currency, rate: bill.rate, lines };
    const billFinancialEdit = require('../billFinancialEdit');
    const preview = await billFinancialEdit.preview(bill._id, edit);
    if (!preview.autoPayment) throw fail('لا يمكن تصحيح دفعة هذه الفاتورة تلقائيًا؛ صحّحها من صفحتها');
    await billFinancialEdit.apply(bill._id, { ...edit, fingerprint: preview.fingerprint }, { session, req });
    entryId = (await SupplierPayment.findOne({ autoFromBillId: bill._id, status: 'posted' }).session(session).lean())?.entryId;
  } else {
    await require('../cancel').cancelDocument('AccountingSupplierPayment', payment._id, { session, req, reason: note });
    // The same bills, in dollars by the payment's own rate: less of the last ones, or more up to what they owe
    const allocations = payment.allocations.map((a) => ({ billId: a.billId, amountUsd: a.amountUsd }));
    const paidUsd = allocations.reduce((s, a) => s + a.amountUsd, 0) + (payment.advanceUsd || 0);
    let change = oldMinor ? Math.round(paidUsd * (newMinor - oldMinor) / oldMinor) : 0;
    for (let i = allocations.length - 1; i >= 0 && change !== 0; i--) {
      const a = allocations[i];
      const step = change < 0 ? Math.max(change, -(a.amountUsd - 1))
        : Math.min(change, Math.max(await payables.apBalance(payables.billKey(a.billId), session) - a.amountUsd, 0));
      a.amountUsd += step; change -= step;
    }
    const replaced = await payables.createPayment({ vendorId: payment.vendorId, day: line.day, fromAccountId: payment.fromAccountId,
      employeeId: payment.employeeId, amount: newMinor / unit, rate: payment.rate, allocations,
      differenceTo: payment.costDifferenceUsd ? 'cost' : 'advance', note: [payment.note, note].filter(Boolean).join(' — '),
      idempotencyKey: `BANK_NEAR_FIX:${line._id}:${payment._id}` }, { session, req });
    entryId = replaced.entryId;
  }
  if (!entryId) throw fail('لم تُنشأ الدفعة المصححة؛ لم يُحفظ شيء');
  await bank.manualMatch(line._id, [entryId], { session, req });
  await logAudit({ req, action: 'bank.nearCorrection', model: 'AccountingBankStatementLine', docId: line._id,
    after: { paymentId: payment._id, oldAmount: oldMinor / unit, newAmount: newMinor / unit, oldDay: payment.day, newDay: line.day, entryId, reason } }, session);
  return { line: await BankStatementLine.findById(line._id).session(session).lean() };
}

module.exports = { correct };
