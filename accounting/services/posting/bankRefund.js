const mongoose = require('mongoose');
const { Account, JournalEntry } = require('../../models');
const { BankStatementLine, SupplierBill, CustomerRefund, SupplierReceipt } = require('../../models/documents');
const Order = require('../../../models/order');
const { getConfig } = require('../config');
const { isDay } = require('../dates');
const { fail, currencyOf, RateBook } = require('./common');
const { originalOf } = require('./bankAmounts');
const payables = require('./payables');
const { logAudit } = require('../audit');
const { assertDirection, assertMerchant } = require('./bankMatchValidation');

async function list(input = {}) {
  if (!mongoose.isValidObjectId(input.accountId)) throw fail('اختر الحساب');
  const bank = await Account.findById(input.accountId).lean();
  if (!bank?.isCash || !bank.isActive) throw fail('اختر حساب البنك');
  const stored = input.lineId && mongoose.isValidObjectId(input.lineId) ? await BankStatementLine.findById(input.lineId).lean() : null;
  if (input.lineId && !stored) throw fail('سطر الكشف غير موجود');
  const line = stored || { ...input, amount: Math.round(Number(input.statementAmount ?? input.paid ?? 0) * 10 ** ((await getConfig()).currencies.get(bank.currency)?.decimals ?? 2)) };
  assertDirection(line, true);
  if (line?.accountId && String(line.accountId) !== String(bank._id)) throw fail('سطر الكشف من حساب آخر');
  if ((input.from && !isDay(input.from)) || (input.to && !isDay(input.to)) || (input.from && input.to && input.from > input.to)) throw fail('فترة البحث غير صالحة');
  const { currencies } = await getConfig();
  const decimals = currencies.get(bank.currency)?.decimals ?? 2;
  const original = originalOf({ ...line, amount: line?.amount ?? Math.round(Number(input.paid || 0) * 10 ** decimals) }, bank.currency, decimals);
  const day = { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) };
  const bills = await SupplierBill.find({ status: 'posted', isCreditNote: { $ne: true }, ...(Object.keys(day).length ? { day } : {}) })
    .sort({ day: -1 }).limit(1001).populate('vendorId', 'name').populate('lines.orderId', 'orderId').lean();
  const merchant = (await require('./bankMerchants').matcher(bank._id))(line || {});
  const refunds = await CustomerRefund.find({ status: 'posted', accountId: bank._id, ...(Object.keys(day).length ? { day } : {}) }).populate('orderId', 'orderId').lean();
  const credits = await SupplierBill.find({ status: 'posted', isCreditNote: true, originalBillId: { $in: bills.map(b => b._id) } }).lean();
  const postedRefunds = await CustomerRefund.find({ status: 'posted', $or: [{ billId: { $in: bills.map(b => b._id) } }, { orderId: { $in: bills.flatMap(b => b.lines.map(l => l.orderId?._id).filter(Boolean)) } }] }).lean();
  const used = new Set((await BankStatementLine.distinct('customerRefundId', { lineStatus: { $in: ['created_entry', 'matched'] } })).filter(Boolean).map(String));
  const refundBills = await SupplierBill.find({ _id: { $in: refunds.map(r => r.billId).filter(Boolean) } }).select('vendorId').lean();
  const rows = refunds.map(r => {
    const originalBill = refundBills.find(b => String(b._id) === String(r.billId));
    const merchantMismatch = !!merchant && !!originalBill && String(merchant.vendorId) !== String(originalBill.vendorId);
    return { _id: `refund:${r._id}`, kind: 'existing_refund', refundId: r._id, source: 'order', number: r.number, day: r.day,
    amount: r.originalAmount || r.usd / 100, currency: r.originalCurrency || 'USD', nativeKnown: !!r.originalCurrency, vendorName: 'ريفاند مسجل على الطلبية', description: r.note,
    orders: r.orderId ? [{ _id: r.orderId._id, number: r.orderId.orderId }] : [], status: 'recorded_refund',
    merchantMismatch, merchantMatch: !!merchant && !!originalBill && !merchantMismatch, statementVendorName: merchant?.vendorName,
    matchProblems: merchantMismatch ? ['المورد مختلف عن تاجر الكشف'] : [],
    bankAmount: r.amount, bankCurrency: r.currency, valuationUsd: r.usd / 100, walletUsd: r.walletUsd / 100, canMatch: !merchantMismatch && !used.has(String(r._id)) && (!(line?.amount || input.paid) || Math.round(r.amount * 10 ** decimals) === (line?.amount || Math.round(Number(input.paid) * 10 ** decimals))),
  }; });
  for (const bill of bills.slice(0, 1000)) {
    const refunded = postedRefunds.filter(r => String(r.billId) === String(bill._id));
    const remaining = Math.max(0, Number(bill.total) - credits.filter(c => String(c.originalBillId) === String(bill._id)).reduce((s, c) => s + Number(c.total), 0)
      - refunded.reduce((s, r) => s + (r.originalCurrency === bill.currency ? Number(r.originalAmount || 0) : 0), 0));
    const orders = bill.lines.filter(l => l.orderId).map(l => ({ _id: l.orderId._id, number: l.orderId.orderId, description: l.description }));
    const merchantMismatch = !!merchant && String(merchant.vendorId) !== String(bill.vendorId?._id);
    const known = !!line?.originalCurrency || original.currency !== bank.currency;
    const currencyMismatch = known && bill.currency !== original.currency;
    const excessive = known && original.amount > remaining + 0.0005;
    rows.push({ _id: `bill:${bill._id}`, kind: 'bill', billId: bill._id, source: orders.length ? 'order' : 'direct', number: bill.number, day: bill.day,
      amount: bill.total, currency: bill.currency, vendorName: bill.vendorId?.name, vendorId: bill.vendorId?._id,
      merchantMatch: !!merchant && String(merchant.vendorId) === String(bill.vendorId?._id), description: bill.lines.map(l => l.description).join('، '), orders,
      merchantMismatch, statementVendorName: merchant?.vendorName,
      matchProblems: [...(merchantMismatch ? ['المورد مختلف عن تاجر الكشف'] : []), ...(currencyMismatch ? ['العملة الأصلية مختلفة'] : []), ...(excessive ? ['الاسترداد أكبر من المتبقي'] : []), ...(line.day && bill.day > line.day ? ['الفاتورة بعد الاسترداد'] : [])],
      status: 'refundable', refundableAmount: remaining, canMatch: !merchantMismatch && !currencyMismatch && !excessive && (!line.day || bill.day <= line.day) && remaining > 0 && bill.lines.every(l => ['order', 'expense', 'trip', 'customs'].includes(l.target)),
      refundLines: bill.lines.map(l => ({ _id: l._id, amount: l.amount, description: l.description, orderId: l.orderId?._id, orderNumber: l.orderId?.orderId, target: l.target })),
    });
  }
  const query = String(input.q || '').trim().toLowerCase();
  const filtered = rows.filter(r => (!input.source || input.source === 'all' || input.source === r.source) && (input.status === 'all' || r.canMatch)
    && (!query || [r.number, r.vendorName, r.description, ...r.orders.map(o => o.number)].join(' ').toLowerCase().includes(query)))
    .sort((a, b) => Number(b.kind === 'existing_refund') - Number(a.kind === 'existing_refund') || Number(!!b.merchantMatch) - Number(!!a.merchantMatch) || Number(b.currency === original.currency) - Number(a.currency === original.currency) || b.day.localeCompare(a.day));
  const page = Math.max(1, parseInt(input.page, 10) || 1);
  return { results: filtered.slice((page - 1) * 30, page * 30), total: filtered.length, page, pageSize: 30, truncated: bills.length > 1000,
    original: { ...original, known: !!line?.originalCurrency || original.currency !== bank.currency } };
}

async function match(id, input, { session, req }) {
  const line = await BankStatementLine.findById(id).session(session);
  if (!line || line.lineStatus !== 'unmatched' || line.amount <= 0) throw fail('اختر سطر مبلغ مرتجع موجب وغير مطابق');
  const bank = await Account.findById(line.accountId).session(session).lean();
  if (require('./bankTransferHints').describe(line, bank, [...(await require('../config').getConfig()).accountsById.values()])?.semanticTransfer)
    throw fail('هذه حركة تحويل أو إيداع؛ ليست استرداد مشتريات');
  assertDirection(line, true);
  const { currencies } = await getConfig();
  const decimals = currencies.get(bank.currency)?.decimals ?? 2;
  const amount = line.amount / 10 ** decimals;
  const services = require('./bank');
  if (input.kind === 'existing_refund') {
    const refund = mongoose.isValidObjectId(input.refundId) && await CustomerRefund.findById(input.refundId).session(session).lean();
    if (!refund || refund.status !== 'posted' || String(refund.accountId) !== String(bank._id) || Math.round(refund.amount * 10 ** decimals) !== line.amount) throw fail('الريفاند المسجل لا يطابق الحساب والمبلغ في الكشف');
    if (refund.billId) {
      const originalBill = await SupplierBill.findById(refund.billId).session(session).lean();
      if (originalBill) await assertMerchant(line, bank, originalBill.vendorId, session);
    }
    if (Math.abs(Date.parse(refund.day) - Date.parse(line.day)) > 7 * 86400000 && !input.confirmDifference) throw fail('أكد اختلاف التاريخ');
    const movements = await services.unmatchedMovements(bank._id, { session });
    if (movements.some(m => String(m._id) === String(refund.entryId) && m.amount === line.amount)) await services.manualMatch(line._id, [refund.entryId], { session, req });
    else {
      if (!await require('./common').isBeforeCashCount(line.day)) throw fail('قيد الريفاند لا يحتوي حركة متاحة لهذا البنك');
      const claimed = await JournalEntry.updateOne({ _id: refund.entryId, status: 'posted', bankMatchedAccounts: { $ne: bank._id } }, { $addToSet: { bankMatchedAccounts: bank._id } }, { session });
      if (claimed.modifiedCount !== 1 || await BankStatementLine.exists({ _id: { $ne: line._id }, lineStatus: { $in: ['matched', 'created_entry'] },
        $or: [{ customerRefundId: refund._id }, { entryId: refund.entryId }, { matchedEntryIds: refund.entryId }] }).session(session)) throw fail('الريفاند مرتبط بكشف سابقاً');
      line.lineStatus = 'matched'; line.matchedEntryIds = [refund.entryId]; await line.save({ session });
      await require('./refundBankValuation').reconcile(refund._id, line, { session, req });
    }
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { customerRefundId: refund._id, orderId: refund.orderId, movementKind: 'purchase_refund' } }, { session });
    if (refund.billId) {
      const originalBill = await SupplierBill.findById(refund.billId).session(session).lean();
      if (originalBill) await require('./bankMerchants').learn(line, originalBill.vendorId, null, session);
    }
    return { matched: true, refundId: refund._id };
  }
  const bill = mongoose.isValidObjectId(input.billId) && await SupplierBill.findById(input.billId).session(session).lean();
  if (!bill || bill.status !== 'posted' || bill.isCreditNote || bill.day > line.day) throw fail('اختر فاتورة أصلية مُرحلة بتاريخ يسبق الاسترداد');
  await assertMerchant(line, bank, bill.vendorId, session);
  await payables.lockBillAllocation(bill, session);
  const original = originalOf(line, bank.currency, decimals);
  const known = !!line.originalCurrency || original.currency !== bank.currency;
  const originalAmount = known ? original.amount : Number(input.refundOriginalAmount);
  if ((known && original.currency !== bill.currency) || !(originalAmount > 0)) throw fail('حدد مبلغ الاسترداد بعملة الفاتورة الأصلية المطابقة للكشف');
  const selected = bill.lines.length === 1 ? bill.lines[0] : bill.lines.find(l => String(l._id) === String(input.billLineId));
  if (!selected || !['order', 'expense', 'trip', 'customs'].includes(selected.target)) throw fail('اختر بند الفاتورة الذي أُعيدت قيمته');
  const priorCredits = await SupplierBill.find({ originalBillId: bill._id, isCreditNote: true, status: 'posted' }).session(session).lean();
  const priorRefunds = await CustomerRefund.find({ billId: bill._id, status: 'posted' }).session(session).lean();
  const unreceivedCredits = selected.target !== 'order' && await payables.apBalance(payables.billKey(bill._id), session) < 0
    ? priorCredits.filter(c => c.currency === bill.currency && Math.abs(Number(c.total) - originalAmount) < 0.0005 && c.day <= line.day) : [];
  if (unreceivedCredits.length > 1) throw fail('يوجد أكثر من إشعار دائن بنفس القيمة؛ راجع استلام المورد قبل المطابقة');
  const existingCredit = unreceivedCredits[0];
  const selectedReturned = priorRefunds.filter(r => !r.billLineId || String(r.billLineId) === String(selected._id)).reduce((sum, r) => sum + Number(r.originalAmount || 0), 0)
    + priorCredits.filter(c => (!existingCredit || String(c._id) !== String(existingCredit._id)) && (bill.lines.length === 1 || c.vendorRef === `BANK_RETURN_LINE:${selected._id}`)).reduce((sum, c) => sum + Number(c.total || 0), 0);
  const returned = priorCredits.filter(c => !existingCredit || String(c._id) !== String(existingCredit._id)).reduce((sum, note) => sum + Number(note.total || 0), 0) + priorRefunds.reduce((sum, r) => sum + Number(r.originalAmount || 0), 0);
  if (originalAmount > Number(selected.amount) - selectedReturned + 0.0005 || originalAmount > Number(bill.total) - returned + 0.0005) throw fail('الاسترداد أكبر من المتبقي من المشتريات الأصلية');
  const rates = new RateBook(session);
  const usd = bank.currency === 'USD' ? amount : Number(line.settlementUsd) > 0 ? Number(line.settlementUsd)
    : known && original.currency === 'USD' ? originalAmount : (await rates.toUsd(line.amount, currencyOf(bank), line.day)) / 100;
  const key = `BANK_REFUND:${line._id}:${line.postingAttempt || 0}`;
  if (selected.target === 'order') {
    // The existing order refund already records BOTH the incoming money and cost reduction.
    // Reuse it, never add a supplier credit note on top of it.
    const existing = await CustomerRefund.find({ orderId: selected.orderId, accountId: bank._id, status: 'posted', amount,
      day: { $gte: require('../dates').addDays(line.day, -7), $lte: require('../dates').addDays(line.day, 7) } }).session(session).lean();
    if (existing.length) throw fail('يوجد ريفاند مسجل بنفس المبلغ على الطلبية؛ اختره من القائمة لمطابقته دون تكرار');
    const refund = await require('./customerRefund').createCustomerRefund({ orderId: selected.orderId, accountId: bank._id, day: line.day,
      amount, usdValue: usd, walletUsd: Number(input.walletUsd || 0), idempotencyKey: key, note: line.description,
      bankLineId: line._id, billId: bill._id, originalAmount, originalCurrency: bill.currency, billLineId: selected._id }, { session, req });
    Object.assign(line, { lineStatus: 'created_entry', entryId: refund.entryId, customerRefundId: refund._id, billId: bill._id, orderId: selected.orderId,
      originalAmount: line.originalAmount, matchedOriginalAmount: originalAmount, matchedOriginalCurrency: bill.currency,
      movementKind: 'purchase_refund', valuationUsd: usd, crossRate: amount / originalAmount, rateBaseCurrency: bill.currency, rateQuoteCurrency: bank.currency });
  } else {
    if (Number(input.walletUsd || 0)) throw fail('الإضافة لمحفظة العميل تكون لاسترداد مرتبط بطلبية');
    if (await payables.apBalance(payables.billKey(bill._id), session) > 0) throw fail('الفاتورة غير مسددة بالكامل؛ راجع ذمة المورد قبل تسجيل استرداد نقدي');
    const bookUsd = Math.round(Number(selected.usd) * originalAmount / Number(selected.amount));
    if (!(bookUsd > 0)) throw fail('تعذر حساب القيمة الأصلية للاسترداد');
    const credit = existingCredit || await payables.createBill({ vendorId: bill.vendorId, originalBillId: bill._id, isCreditNote: true, day: line.day,
      vendorRef: `BANK_RETURN_LINE:${selected._id}`,
      currency: bill.currency, ...(bill.currency !== 'USD' && { rate: originalAmount / (bookUsd / 100) }), idempotencyKey: `${key}:CREDIT`,
      lines: [{ ...selected, _id: undefined, amount: originalAmount, description: `استرداد ${selected.description}` }], note: line.description }, { session, req });
    const receipt = await payables.createReceipt({ vendorId: bill.vendorId, toAccountId: bank._id, day: line.day, amount,
      ...(bank.currency !== 'USD' && { rate: amount / usd }), allocations: [{ billId: bill._id, amountUsd: credit.totalUsd }],
      differenceTo: 'exchange', idempotencyKey: `${key}:RECEIPT`, note: line.description }, { session, req });
    Object.assign(line, { lineStatus: 'created_entry', entryId: receipt.entryId, receiptId: receipt._id, creditNoteId: credit._id, refundCreditCreated: !existingCredit,
      billId: bill._id, billCreatedFromStatement: false, movementKind: 'purchase_refund', matchedOriginalAmount: originalAmount, matchedOriginalCurrency: bill.currency,
      valuationUsd: usd, crossRate: amount / originalAmount, rateBaseCurrency: bill.currency, rateQuoteCurrency: bank.currency });
  }
  await rates.lock();
  await require('./bankMerchants').learn(line, bill.vendorId, selected.accountId, session);
  await line.save({ session });
  await logAudit({ req, action: 'bank.refund', model: 'AccountingBankStatementLine', docId: line._id, after: { billId: bill._id, refundId: line.customerRefundId, receiptId: line.receiptId } }, session);
  return line;
}
module.exports = { list, match };
