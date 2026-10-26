const crypto = require('crypto');
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SupplierBill, SupplierPayment, SupplierReceipt, BankStatementLine, Netting } = require('../models/documents');
const { getConfig } = require('./config');
const { lockPeriod } = require('./periodLock');
const { reverseSourceEntries } = require('./cancel');
const { RateBook, toCurrencyMinor } = require('./posting/common');
const payables = require('./posting/payables');
const { logAudit } = require('./audit');
const { resolveAccount } = require('./roles');
const { isDay } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');
const Order = require('../../models/order');
const fail = message => new ErrorHandler(400, message);
const idOf = value => value ? String(value._id || value) : '';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TARGETS = ['trip', 'order', 'expense', 'customs'];
const lineView = line => ({ description: String(line.description || '').trim(), amount: Number(line.amount), target: line.target,
  office: line.office || '', accountId: idOf(line.accountId), tripId: idOf(line.tripId), orderId: idOf(line.orderId),
  packageId: idOf(line.packageId), costCategory: line.costCategory || '', purchaseItemId: idOf(line.purchaseItemId) });
const financialView = line => { const { description, ...rest } = lineView(line); return rest; };

// Read-only preparation is shared by the preview and commit. Nothing is posted
// until the exact preview fingerprint is confirmed in a transaction.
async function prepare(id, input, { session, settings: lockedSettings } = {}) {
  if (!mongoose.isValidObjectId(id)) throw fail('رقم الفاتورة غير صالح');
  const bill = await SupplierBill.findById(id).session(session || null).lean();
  if (!bill || bill.status !== 'posted') throw fail('اختر فاتورة مُرحّلة غير ملغاة');
  const { settings: cached } = await getConfig();
  const settings = lockedSettings || cached;
  if (settings?.lockDate && bill.day <= settings.lockDate) throw fail(`الفترة مقفلة حتى ${settings.lockDate}؛ لا يمكن تعديل الفاتورة`);
  if (settings?.migrationGuardDay && bill.day <= settings.migrationGuardDay) throw fail('الفاتورة ضمن فترة الترحيل قيد المراجعة');
  if (new Date(input.updatedAt).getTime() !== new Date(bill.updatedAt).getTime()) throw new ErrorHandler(409, 'تغيّرت الفاتورة؛ أعد فتح التعديل');
  const day = input.day;
  if (!isDay(day)) throw fail('تاريخ الفاتورة غير صالح');
  if ((settings?.lockDate && day <= settings.lockDate) || (settings?.migrationGuardDay && day <= settings.migrationGuardDay)) throw fail('لا يمكن نقل الفاتورة إلى فترة مقفلة أو محجوزة للترحيل');
  if (!String(input.reason || '').trim() || String(input.reason).length > 1000) throw fail('سبب التعديل مطلوب، حتى 1000 حرف');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw fail('أدخل سطور الفاتورة، حتى 100 سطر');
  const seen = new Set();
  const lines = input.lines.map(row => {
    const previous = row._id && bill.lines.find(line => String(line._id) === String(row._id));
    if (row._id && (!previous || seen.has(String(row._id)))) throw fail('سطر الفاتورة غير صالح أو مكرر');
    if (row._id) seen.add(String(row._id));
    const line = lineView(row);
    if (previous?.purchaseItemId) line.purchaseItemId = previous.purchaseItemId;
    if (!TARGETS.includes(line.target)) throw fail('تعديل القيمة متاح لفواتير الرحلات والطلبات والمصاريف والتخليص؛ الأصول والمخزون وشراء اليوان تُصحّح من مستنداتها المختصة');
    if (!line.description || line.description.length > 1000 || !Number.isFinite(line.amount) || line.amount <= 0) throw fail('أدخل وصفًا ومبلغًا موجبًا لكل سطر');
    // Only the dimensions meaningful to this target are accepted.
    for (const key of ['accountId', 'tripId', 'orderId', 'packageId', 'purchaseItemId']) if (!line[key]) delete line[key];
    if (line.target !== 'trip') { delete line.tripId; delete line.costCategory; }
    if (!['order', 'customs'].includes(line.target)) { delete line.orderId; delete line.purchaseItemId; }
    if (line.target !== 'customs') delete line.packageId;
    if (line.target !== 'expense') delete line.accountId;
    return { ...line, ...(previous ? { _id: previous._id } : {}) };
  });
  const rate = input.rate == null || input.rate === '' ? undefined : Number(input.rate);
  if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0)) throw fail('سعر الصرف يجب أن يكون موجبًا');
  const merged = { ...bill, vendorId: input.vendorId, vendorRef: String(input.vendorRef || '').trim(), note: String(input.note || '').trim(),
    day, currency: input.currency, rate, lines };
  if (merged.vendorRef.length > 200 || merged.note.length > 5000) throw fail('رقم المورد أو الملاحظات أطول من الحد المسموح');
  const financial = day !== bill.day || merged.currency !== bill.currency || Number(rate || 0) !== Number(bill.rate || 0)
    || JSON.stringify(lines.map(financialView)) !== JSON.stringify(bill.lines.map(financialView));
  if (financial && (bill.yuanPurchaseId || bill.isCreditNote || bill.lines.some(line => !TARGETS.includes(line.target)))) {
    throw fail('هذه الفاتورة مرتبطة بمستند متخصص أو إشعار دائن؛ عدّل القيمة من مستندها الأصلي');
  }
  // A correction preserves the existing payments. Their currency and account
  // must not be revalidated as though a new payment were being made.
  const originItems = [];
  for (const previous of bill.lines.filter(line => line.purchaseItemId)) {
    const replacement = lines.find(line => String(line._id) === String(previous._id));
    if (!replacement || replacement.target !== 'order' || idOf(replacement.orderId) !== idOf(previous.orderId)) {
      throw fail('السطر مرتبط بمشتريات الطلبية؛ يمكن تعديل قيمته مع الاحتفاظ بربطه، ولا يُحذف أو يُنقل إلى طلبية أخرى من هنا');
    }
    const order = await Order.findById(previous.orderId).select('purchaseItems updatedAt').session(session || null).lean();
    const item = order?.purchaseItems?.find(row => String(row._id) === String(previous.purchaseItemId));
    if (!item) throw fail('بند مشتريات الطلبية الأصلي غير موجود');
    originItems.push({ orderId: order._id, updatedAt: order.updatedAt, before: item,
      after: { ...item, description: replacement.description, unitPrice: replacement.amount, currency: merged.currency, date: merged.day } });
  }
  await payables.validateBillInput({ ...merged, paidImmediatelyFrom: undefined, employeeId: undefined,
    // The original purchase item is validated above and updated atomically below.
    lines: merged.lines.map(({ purchaseItemId, ...line }) => line), paidBeforeCount: false }, session, { readOnly: true });
  const [entries, payments, receipts, notes, nettings] = await Promise.all([
    JournalEntry.find({ 'source.model': 'AccountingSupplierBill', 'source.id': bill._id, status: 'posted', reversalOf: null }).session(session || null).lean(),
    SupplierPayment.find({ 'allocations.billId': bill._id, status: 'posted' }).session(session || null).lean(),
    SupplierReceipt.find({ 'allocations.billId': bill._id, status: 'posted' }).session(session || null).lean(),
    SupplierBill.find({ originalBillId: bill._id, status: 'posted' }).session(session || null).lean(),
    Netting.find({ billId: bill._id, status: 'posted' }).session(session || null).lean(),
  ]);
  if (financial) {
    if (!entries.length) throw fail('لم يُعثر على قيود الفاتورة الأصلية');
    if (settings?.lockDate && entries.some(entry => entry.day <= settings.lockDate)) throw fail('للفاتورة قيود في فترة مقفلة؛ لا يمكن تعديل قيمتها');
    if (notes.length && merged.currency !== bill.currency) throw fail('عدّل الإشعارات الدائنة المرتبطة قبل تغيير عملة الفاتورة');
    const entriesIds = [...entries.map(entry => entry._id), ...payments.map(payment => payment.entryId), ...receipts.map(receipt => receipt.entryId)].filter(Boolean);
    const paymentIds = payments.map(payment => payment._id);
    const receiptIds = receipts.map(receipt => receipt._id);
    const bank = await BankStatementLine.findOne({ lineStatus: { $in: ['matched', 'created_entry'] }, $or: [
      { billId: bill._id }, { paymentId: { $in: paymentIds } }, { historicalSettlementPaymentId: { $in: paymentIds } },
      { receiptId: { $in: receiptIds } }, { entryId: { $in: entriesIds } }, { matchedEntryIds: { $in: entriesIds } },
      { groupPaymentIds: { $in: paymentIds } },
    ] }).session(session || null).lean();
    if (bank) throw fail('الفاتورة أو إحدى دفعاتها مطابقة بكشف بنك. فكّ المطابقة من سطر الكشف أولًا، ثم أعد التعديل والمطابقة');
    const targetView = rows => JSON.stringify(rows.map(row => { const { amount, ...target } = financialView(row); return target; }));
    if (payments.some(payment => payment.costDifferenceUsd) && targetView(lines) !== targetView(bill.lines)) throw fail('يوجد فرق تكلفة موزع من دفعة مرتبطة؛ ألغِ تسوية الفرق قبل تغيير جهة تحميل التكلفة');
    if (merged.currency !== bill.currency && (bill.paidBeforeCount || payments.length || receipts.length || nettings.length)) throw fail('الفاتورة عليها سداد أو تسوية؛ احتفظ بعملتها وعدّل القيمة وسعر الصرف، أو عالج السداد قبل تغيير العملة');
  }
  const rates = new RateBook(session);
  let newUsd = 0;
  for (const line of lines) {
    const minor = await toCurrencyMinor(line.amount, merged.currency);
    const usd = await rates.toUsd(minor, merged.currency, day, rate);
    if (!Number.isSafeInteger(usd) || usd <= 0) throw fail('قيمة السطر بالدولار يجب أن تكون موجبة');
    newUsd += usd;
    if (!Number.isSafeInteger(newUsd)) throw fail('إجمالي الفاتورة يتجاوز الحد المسموح');
  }
  if (!financial) newUsd = bill.totalUsd;
  if (financial && newUsd < notes.reduce((sum, note) => sum + note.totalUsd, 0)) throw fail('قيمة الفاتورة الجديدة أقل من إشعاراتها الدائنة؛ عدّل الإشعارات أولًا');
  const oldOpen = await payables.apBalance(payables.billKey(bill._id), session);
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const fingerprint = hash({ bill, input: merged, entries, payments, receipts, notes, nettings, originItems, newUsd,
    lockDate: settings?.lockDate, migrationGuardDay: settings?.migrationGuardDay, oldOpen });
  return { bill, merged, financial, entries, payments, originItems, oldOpen, newUsd, fingerprint,
    summary: { oldTotal: bill.total, newTotal: total, oldCurrency: bill.currency, newCurrency: merged.currency,
      oldUsd: bill.totalUsd, newUsd, settledUsd: bill.totalUsd - oldOpen, oldOpen,
      newOpen: oldOpen + newUsd - bill.totalUsd, costDelta: newUsd - bill.totalUsd, day } };
}

async function preview(id, input) {
  const prepared = await prepare(id, input);
  const duplicates = await require('./costDuplicates').preview(prepared.merged, { excludeId: prepared.bill._id });
  return { ...prepared.summary, fingerprint: prepared.fingerprint, duplicates };
}

async function apply(id, input, { session, req }) {
  const settings = await lockPeriod(session);
  const prepared = await prepare(id, input, { session, settings });
  if (!input.fingerprint || input.fingerprint !== prepared.fingerprint) throw new ErrorHandler(409, 'تغيّرت بيانات المعاينة أو السداد؛ راجع أثر التعديل مجددًا');
  const { bill: before, merged, financial } = prepared;
  await require('./costDuplicates').assertNoDuplicate({ ...merged,
    duplicateDecision: input.duplicateDecision, duplicateReason: input.duplicateReason, duplicateFingerprint: input.duplicateFingerprint,
  }, { session, excludeId: before._id });
  // The existing audited correction handles vendor balances, linked payments and
  // descriptions without touching cash. Its source-scoped entries remain cancellable.
  const details = await require('./billDetailsEdit').edit(id, { vendorId: merged.vendorId, vendorRef: merged.vendorRef,
    note: merged.note, reason: input.reason, updatedAt: input.updatedAt,
    ...(merged.lines.length === before.lines.length && merged.lines.every(line => line._id) ? {
      descriptions: merged.lines.map(line => ({ id: line._id, description: line.description })) } : {}),
  }, { session, req });
  if (!financial) return { ...details, preview: prepared.summary };
  const current = await SupplierBill.findById(id).session(session);
  for (const origin of prepared.originItems) {
    const order = await Order.findById(origin.orderId).session(session);
    const item = order?.purchaseItems.id(origin.before._id);
    if (!item) throw fail('تغيّرت مشتريات الطلبية؛ أعد المعاينة');
    Object.assign(item, { description: origin.after.description, unitPrice: origin.after.unitPrice, currency: origin.after.currency, date: origin.after.date });
    await order.save({ session });
    await logAudit({ req, action: 'bill.edit.purchaseItem', model: 'Order', docId: order._id,
      before: origin.before, after: { item: item.toObject(), billId: current._id, reason: input.reason } }, session);
  }
  let embeddedPaidUsd;
  if (before.paidBeforeCount) {
    const opening = await resolveAccount('opening_balance');
    const source = await JournalEntry.find({ 'source.model': 'AccountingSupplierBill', 'source.id': current._id }).session(session).lean();
    embeddedPaidUsd = source.flatMap(entry => entry.lines).filter(line => String(line.accountId) === String(opening._id))
      .reduce((sum, line) => sum + line.credit - line.debit, 0);
  }
  const batch = crypto.randomUUID();
  await reverseSourceEntries('AccountingSupplierBill', current._id, { session, user: req.user, reason: `تعديل ${current.number}: ${input.reason}` });
  Object.assign(current, { day: merged.day, currency: merged.currency, rate: merged.rate, lines: merged.lines });
  await payables.postBill(current, { session, user: req.user, sync: { defer: true }, embeddedPaidUsd,
    correctionKey: `BILL_EDIT:${current._id}:${batch}` });
  // Recalculate both previous and new destinations when a line moves between trips/orders.
  await payables.syncBillTargets({ lines: [...before.lines, ...current.lines] }, { session, user: req.user });
  const open = await payables.apBalance(payables.billKey(current._id), session);
  if (current.totalUsd !== prepared.newUsd || open !== prepared.summary.newOpen) throw fail('تغيّر الأثر المحاسبي عن المعاينة؛ لم يُحفظ التعديل');
  await logAudit({ req, action: 'bill.financial.edit', model: 'AccountingSupplierBill', docId: current._id,
    before, after: { document: current.toObject(), reason: input.reason, preview: prepared.summary, batch } }, session);
  return { bill: current, preview: prepared.summary };
}

module.exports = { preview, apply };
