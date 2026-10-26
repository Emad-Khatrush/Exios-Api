// Correct a posted bill's identifying details without reposting its cost or cash.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { Vendor, SupplierBill, SupplierPayment, SupplierReceipt, Netting } = require('../models/documents');
const { postEntry } = require('./ledger');
const { lockPeriod } = require('./periodLock');
const { logAudit } = require('./audit');
const { today, addDays } = require('./dates');
const { resolveAccount } = require('./roles');
const { apBalance, billKey } = require('./posting/payables');
const ErrorHandler = require('../../utils/errorHandler');
const fail = message => new ErrorHandler(400, message);
const idOf = value => String(value?._id || value);

async function edit(id, input, { session, req }) {
  if (!mongoose.isValidObjectId(id)) throw fail('الفاتورة غير صالحة');
  const allowed = new Set(['vendorId', 'vendorRef', 'note', 'descriptions', 'reason', 'updatedAt']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw fail('هذا التعديل مخصص للمورد ورقم الفاتورة والوصف والملاحظات فقط');
  const reason = String(input.reason || '').trim();
  if (!reason || reason.length > 1000) throw fail('اكتب سبب التعديل، حتى 1000 حرف');
  const settings = await lockPeriod(session);
  const bill = await SupplierBill.findById(id).session(session);
  if (!bill || bill.status !== 'posted') throw fail('التعديل متاح للفاتورة المُرحّلة غير الملغاة فقط');
  if (settings?.lockDate && bill.day <= settings.lockDate) throw fail(`الفترة مقفلة حتى ${settings.lockDate}؛ لا يمكن تعديل الفاتورة. سجّل تصحيحًا في فترة مفتوحة`);
  if (settings?.migrationGuardDay && bill.day <= settings.migrationGuardDay) throw fail('الفاتورة ضمن فترة الترحيل قيد المراجعة؛ أكمل الترحيل قبل التعديل');
  if (!input.updatedAt || new Date(input.updatedAt).getTime() !== new Date(bill.updatedAt).getTime()) {
    throw new ErrorHandler(409, 'تغيّرت الفاتورة. أغلق التعديل وافتحه مجددًا لقراءة آخر البيانات');
  }
  const before = bill.toObject();
  // Serialize against allocations and cancellation as well as a second correction.
  await SupplierBill.updateOne({ _id: bill._id, status: 'posted' }, { $inc: { allocationVersion: 1 } }, { session });
  const nextVendorId = input.vendorId || bill.vendorId;
  if (!mongoose.isValidObjectId(nextVendorId)) throw fail('اختر المورد الصحيح');
  const vendor = await Vendor.findById(nextVendorId).session(session);
  if (!vendor) throw fail('المورد غير موجود');
  const vendorChanged = idOf(vendor) !== idOf(bill.vendorId);
  if (vendorChanged && !vendor.isActive) throw fail('المورد الجديد مؤرشف');
  const entryIds = [];
  let related = [];
  if (vendorChanged) {
    if (bill.isCreditNote) throw fail('غيّر المورد من الفاتورة الأصلية؛ تتبعها إشعاراتها الدائنة تلقائيًا');
    if (bill.yuanPurchaseId) throw fail('فاتورة شراء اليوان مرتبطة بعملية صرافة؛ يمكن تعديل بياناتها هنا، ويُصحَّح المورد من عملية الشراء');
    related = await SupplierBill.find({ originalBillId: bill._id, status: { $in: ['posted', 'draft'] } }).session(session);
    if (settings?.lockDate && related.some(note => note.status === 'posted' && note.day <= settings.lockDate)) {
      throw fail('للفاتورة إشعار دائن في فترة مقفلة؛ لا يمكن تغيير مورده مباشرة');
    }
    const ids = [bill._id, ...related.map(note => note._id)];
    const family = new Set(ids.map(String));
    if (await Netting.exists({ billId: { $in: ids }, status: 'posted' }).session(session)) {
      throw fail('الفاتورة مرتبطة بمقاصة مع محفظة عميل. ألغِ المقاصة قبل تغيير المورد');
    }
    const linked = [];
    for (const Model of [SupplierPayment, SupplierReceipt]) {
      const docs = await Model.find({ 'allocations.billId': { $in: ids }, status: 'posted' }).session(session);
      for (const doc of docs) {
        if (settings?.lockDate && doc.day <= settings.lockDate) throw fail(`المستند ${doc.number} في فترة مقفلة؛ لا يمكن تغيير مورد الفاتورة المرتبط به مباشرة`);
        if ((doc.allocations || []).some(a => !family.has(String(a.billId))) || doc.advanceUsd || doc.fromAdvance) {
          throw fail(`الدفعة أو الاسترداد ${doc.number} يشمل فواتير أخرى أو دفعة مقدمة. افصل تسويته أولًا قبل تغيير المورد`);
        }
        if (idOf(doc.vendorId) !== idOf(bill.vendorId)) throw fail('يوجد اختلاف في مورد دفعة مرتبطة؛ راجعها قبل التعديل');
        linked.push(doc);
      }
    }
    const payable = await resolveAccount(vendor.type === 'carrier' ? 'payable_carriers' : 'payable_suppliers');
    const key = billKey(bill._id);
    const balanceBefore = await apBalance(key, session);
    // Reclassify each source separately. Cancelling a payment later then reverses
    // its own correction too, restoring the debt to the corrected vendor.
    const groups = await JournalEntry.aggregate([
      { $match: { lines: { $elemMatch: { apKey: key, vendorId: bill.vendorId } } } },
      { $unwind: '$lines' },
      { $match: { 'lines.apKey': key, 'lines.vendorId': bill.vendorId } },
      { $group: { _id: { model: '$source.model', source: '$source.id', account: '$lines.accountId' },
        net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
      { $match: { net: { $ne: 0 } } },
    ]).session(session);
    const batch = crypto.randomUUID();
    let day = today();
    for (const boundary of [settings?.lockDate, settings?.migrationGuardDay]) {
      if (boundary && day <= boundary) day = addDays(boundary, 1);
    }
    const payables = await Promise.all(['payable_suppliers', 'payable_carriers'].map(resolveAccount));
    const payableIds = new Set(payables.map(account => String(account._id)));
    for (const [index, group] of groups.entries()) {
      if (!group._id.model || !group._id.source || !payableIds.has(String(group._id.account))) {
        throw fail('يوجد قيد غير معتاد على حساب المورد؛ يحتاج مراجعة قبل تغيير المورد');
      }
      const amount = Math.abs(group.net);
      const entry = await postEntry({
        eventType: 'BILL_VENDOR_CORRECTION', eventKey: `BILL_VENDOR_CORRECTION:${bill._id}:${batch}:${index}`,
        date: day, description: `تصحيح مورد ${bill.number}: ${reason}`,
        source: { model: group._id.model, id: group._id.source },
        lines: [
          { accountId: group._id.account, vendorId: bill.vendorId, apKey: key,
            debit: group.net < 0 ? amount : 0, credit: group.net > 0 ? amount : 0, label: `نقل ربط المورد السابق - ${bill.number}` },
          { accountId: payable._id, vendorId: vendor._id, apKey: key,
            debit: group.net > 0 ? amount : 0, credit: group.net < 0 ? amount : 0, label: `تصحيح المورد إلى ${vendor.name} - ${bill.number}` },
        ],
      }, { session, user: req.user });
      entryIds.push(entry._id);
    }
    if (await apBalance(key, session) !== balanceBefore) throw fail('تعذر الحفاظ على رصيد الفاتورة؛ لم يُحفظ التعديل');
    for (const doc of [...related, ...linked]) {
      const old = doc.toObject();
      doc.vendorId = vendor._id;
      if (doc.constructor.modelName === 'AccountingSupplierBill') doc.payableAccountId = payable._id;
      await doc.save({ session });
      await logAudit({ req, action: 'bill.vendor.correct.related', model: doc.constructor.modelName, docId: doc._id,
        before: old, after: { document: doc.toObject(), reason, billId: bill._id } }, session);
    }
    bill.vendorId = vendor._id;
    bill.payableAccountId = payable._id;
  }
  for (const field of ['vendorRef', 'note']) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string' || input[field].length > (field === 'note' ? 5000 : 200)) throw fail('رقم المورد أو الملاحظات غير صالحة');
      bill[field] = input[field].trim();
    }
  }
  if (input.descriptions !== undefined) {
    if (!Array.isArray(input.descriptions) || input.descriptions.length !== bill.lines.length) throw fail('سطور الفاتورة تغيّرت؛ أعد فتح التعديل');
    const seen = new Set();
    for (const row of input.descriptions) {
      const line = bill.lines.id(row.id);
      const description = String(row.description || '').trim();
      if (!line || seen.has(String(row.id)) || !description || description.length > 1000) throw fail('وصف السطر غير صالح أو مكرر');
      seen.add(String(row.id));
      line.description = description;
    }
  }
  // Never save over the allocation lock's increment with a stale document version.
  bill.allocationVersion = (before.allocationVersion || 0) + 1;
  await bill.save({ session });
  await logAudit({ req, action: 'bill.details.correct', model: 'AccountingSupplierBill', docId: bill._id,
    before, after: { document: bill.toObject(), reason, entryIds, relatedBillIds: related.map(note => note._id) } }, session);
  return { bill, entryIds };
}

module.exports = { edit };
