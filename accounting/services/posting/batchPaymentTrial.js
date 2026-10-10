const { SupplierPayment, SupplierBill, YuanPurchase } = require('../../models/documents');
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { postEntry } = require('../ledger');
const { logAudit } = require('../audit');
const { today } = require('../dates');
const { getConfig } = require('../config');
const payables = require('./payables');
const { fail, getAccount, resolveAccount, nextDocNumber, findExisting } = require('./common');

function assertTrial() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL || '';
  const localTrial = process.env.EXIOS_LOCAL_ACCOUNTING_TRIAL === '1'
    && /^mongodb:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?:exios-prod-copy|exios-september-trial-\d{8})(?:\?|$)/.test(uri);
  const qa = process.env.EXIOS_QA === '1' && new URL(uri).hostname === 'exios-api-qa.ian5mmn.mongodb.net';
  if (!qa && !localTrial) {
    throw fail('الدفعة المجمعة التجريبية متاحة في نسخة التجربة فقط');
  }
}

async function createBatchPayment(input, { session, req }) {
  assertTrial();
  if (!input.idempotencyKey) throw fail('مرجع العملية مطلوب');
  const existing = await findExisting(SupplierPayment, input.idempotencyKey, session);
  if (existing) {
    if (!existing.batchTrial || String(existing.vendorId) !== String(input.vendorId)) throw fail('مرجع العملية مستخدم لدفعة أخرى');
    return { payment: existing, purchase: await YuanPurchase.findOne({ fundedFromPaymentId: existing._id }).session(session) };
  }
  if (input.day > today()) throw fail('اختر تاريخ الدفع الفعلي');
  const { count } = await getConfig();
  if (count && input.day <= count.day) throw fail('الدفعة التجريبية تخص العمليات بعد الجرد؛ راجع السداد التاريخي من قسمه');
  const from = await getAccount(input.fromAccountId, 'الحساب الدافع');
  if (!from.isCash || from.currency !== 'USD') throw fail('اختر حساب دفع بالدولار لهذه التجربة');
  const allocations = Array.isArray(input.allocations) ? input.allocations : [];
  if (!allocations.length) throw fail('اختر فاتورة مورد واحدة على الأقل');
  if (allocations.some(row => !row || !mongoose.isValidObjectId(row.billId) || !Number.isSafeInteger(row.amountUsd) || row.amountUsd <= 0)
    || new Set(allocations.map(row => String(row.billId))).size !== allocations.length) throw fail('راجع الفواتير والمبالغ المحددة؛ لا تحدد نفس الفاتورة مرتين');
  const total = allocations.reduce((sum, row) => sum + Number(row.amountUsd || 0), 0);
  const paid = Math.round(Number(input.amount) * 100);
  if (!Number.isSafeInteger(paid) || paid <= 0 || !Number.isSafeInteger(total) || total <= 0 || total > paid) throw fail('إجمالي الدفع يجب أن يغطي المبالغ المحددة للفواتير');
  const excess = paid - total;
  if (excess && !['advance', 'alipay'].includes(input.excessPurpose)) throw fail('حدد استخدام المبلغ الزائد');
  let to;
  if (excess && input.excessPurpose === 'alipay') {
    to = await getAccount(input.toAccountId, 'حساب Alipay المستلم');
    if (!to.isCash || to.currency !== 'CNY') throw fail('اختر محفظة Alipay باليوان');
  }
  // Only existing order bills enter this workflow. It never creates a second order cost.
  for (const allocation of allocations) {
    const bill = await SupplierBill.findById(allocation.billId).session(session).lean();
    if (!bill || bill.status !== 'posted' || bill.isCreditNote || !bill.lines.length || bill.lines.some(line => line.target !== 'order' || !line.orderId)) {
      throw fail('اختر فواتير مورد مرحّلة مرتبطة بالطلبيات');
    }
  }
  const payment = await payables.createPayment({
    vendorId: input.vendorId, day: input.day, fromAccountId: from._id, amount: input.amount,
    allocations, differenceTo: 'advance', idempotencyKey: input.idempotencyKey, note: input.note,
  }, { session, req });
  payment.batchTrial = true;
  await payment.save({ session });
  let purchase = null;
  if (to) {
    const paymentEntry = await JournalEntry.findById(payment.entryId).session(session);
    const advanceLine = paymentEntry.lines.find(line => line.apKey === payables.advanceKey(payment.vendorId));
    const payable = advanceLine && await getAccount(advanceLine.accountId);
    if (!payable || payment.advanceUsd !== excess) throw fail('تعذّر تحديد المبلغ الزائد للدفعة');
    [purchase] = await YuanPurchase.create([{
      vendorId: payment.vendorId, day: payment.day, fromAccountId: from._id, currency: 'USD', amount: excess / 100, usd: excess,
      toAccountId: to._id, arrived: false, fundedFromPaymentId: payment._id,
      idempotencyKey: `BATCH_YUAN:${payment._id}`, number: await nextDocNumber('CNY', payment.day, session),
      createdBy: req?.user?._id, note: input.note,
    }], { session });
    const entry = await postEntry({
      eventType: 'YUAN_PURCHASE', eventKey: `YUAN_PURCHASE:${purchase._id}`, date: purchase.day,
      description: `شحن Alipay بانتظار الوصول من الدفعة ${payment.number}`,
      source: { model: 'AccountingYuanPurchase', id: purchase._id },
      lines: [
        { accountId: (await resolveAccount('yuan_in_transit'))._id, debit: excess, vendorId: payment.vendorId },
        { accountId: payable._id, credit: excess, vendorId: payment.vendorId, apKey: payables.advanceKey(payment.vendorId) },
      ],
    }, { session, user: req?.user });
    purchase.entryId = entry._id;
    await purchase.save({ session });
    await logAudit({ req, action: 'alipay.batchPurchase', model: 'AccountingYuanPurchase', docId: purchase._id, after: purchase }, session);
  }
  await require('./bank').autoMatch(from._id, { session, req });
  return { payment, purchase };
}

module.exports = { assertTrial, createBatchPayment };
