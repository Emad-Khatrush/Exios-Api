const crypto = require('crypto');
const mongoose = require('mongoose');
const { Vendor, SupplierBill, ExpenseType } = require('../models/documents');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const { getConfig } = require('./config');
const { validateBillInput, createBill, carriedValue } = require('./posting/payables');
const { runInTransaction } = require('./transaction');
const { getRate } = require('./rates');
const { logAudit } = require('./audit');
const { isDay } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');
const fail = message => new ErrorHandler(400, message);
const text = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TARGETS = { expense: 'expense', 'مصروف': 'expense', order: 'order', 'تكلفة طلب': 'order', trip: 'trip', 'تكلفة رحلة': 'trip', asset: 'asset', 'أصل': 'asset', prepaid: 'prepaid', 'مصروف مقدم': 'prepaid', customs: 'customs', 'تخليص طرد': 'customs' };
function number(value, label, optional = false) {
  if (optional && text(value) === '') return undefined;
  // Never guess whether a comma is a decimal mark or a thousands separator.
  if (typeof value !== 'number' && !/^\d+(?:\.\d+)?$/.test(text(value))) throw fail(`${label}: اكتب رقمًا موجبًا باستخدام النقطة للكسور`);
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw fail(`${label}: القيمة يجب أن تكون أكبر من صفر`);
  return result;
}
function resolve(items, value, keys, label, optional = false) {
  const key = text(value);
  if (!key && optional) return null;
  const matches = items.filter(item => keys.some(field => text(item[field]) === key));
  if (matches.length !== 1) throw fail(matches.length ? `${label} «${key}» غير محدد؛ يوجد أكثر من سجل بنفس الاسم` : `${label} «${key}» غير موجود أو مؤرشف`);
  return matches[0];
}
async function references(rows = null) {
  const only = (field, key) => {
    if (!rows) return {};
    const values = [...new Set(rows.map(row => text(row?.[key])).filter(Boolean))];
    return { $or: [{ [field]: { $in: values } }, { _id: { $in: values.filter(value => mongoose.isValidObjectId(value)) } }] };
  };
  const [config, vendors, types, trips, orders] = await Promise.all([
    getConfig(), Vendor.find({ isActive: true }).select('name seedKey defaultCurrency').lean(),
    ExpenseType.find({ isActive: true }).select('name accountId defaultOffice').lean(),
    Inventory.find({ inventoryType: 'inventoryGoods', ...only('voyage', 'trip') }).select('voyage inventoryPlace').lean(),
    Order.find(only('orderId', 'order')).select('orderId placedAt paymentList._id').lean(),
  ]);
  return { config: { ...config, currencies: [...config.currencies.values()], offices: [...config.offices.values()] }, vendors, types, trips, orders };
}
async function templateReferences() {
  const r = await references();
  return { vendors: r.vendors.map(v => ({ name: v.name, currency: v.defaultCurrency })),
    accounts: [...r.config.accountsById.values()].filter(a => a.isActive && !a.isGroup).map(a => ({ code: a.code, name: a.name, currency: a.currency, type: a.type, isCash: a.isCash, requires: a.requires })),
    offices: r.config.offices.filter(o => o.isActive).map(o => ({ code: o.code, name: o.name })),
    currencies: r.config.currencies.filter(c => c.isActive !== false).map(c => ({ code: c.code, name: c.name })),
    expenseTypes: r.types.map(t => ({ name: t.name, account: r.config.accountsById.get(String(t.accountId))?.code, office: t.defaultOffice })),
    orders: r.orders.map(o => ({ number: o.orderId, office: o.placedAt })),
    trips: r.trips.map(t => ({ number: t.voyage, office: t.inventoryPlace })),
  };
}
async function prepare(kind, rows) {
  if (!['bills', 'expenses'].includes(kind)) throw fail('نوع الاستيراد غير صالح');
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw fail('ارفع ملفًا يحتوي من 1 إلى 500 سطر');
  const r = await references(rows);
  const accounts = [...r.config.accountsById.values()].filter(a => a.isActive && !a.isGroup);
  const groups = new Map();
  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('سطر غير صالح في الملف');
    const ref = text(raw.reference);
    const key = ref || `missing-${index}`;
    if (!groups.has(key)) groups.set(key, { reference: ref, sourceRows: [], lines: [], details: [], errors: [], warnings: [], status: 'ready' });
    const group = groups.get(key);
    group.sourceRows.push({ ...raw, rowNumber: Number.isSafeInteger(raw.rowNumber) ? raw.rowNumber : index + 2 });
    const rowNumber = group.sourceRows[group.sourceRows.length - 1].rowNumber;
    try {
      if (!ref || ref.length > 120) throw fail('معرّف الفاتورة/المصروف مطلوب وبحد أقصى 120 حرفًا');
      const vendor = kind === 'expenses' ? resolve(r.vendors, 'cash_expenses', ['seedKey'], 'مورد المصروفات') : resolve(r.vendors, raw.vendor, ['name', '_id'], 'المورد');
      const day = text(raw.day);
      if (!isDay(day)) throw fail('التاريخ يجب أن يكون YYYY-MM-DD ويومًا صحيحًا');
      const currency = text(raw.currency).toUpperCase();
      const currencyInfo = resolve(r.config.currencies.filter(c => c.isActive !== false), currency, ['code'], 'العملة');
      const amount = number(raw.amount, 'المبلغ');
      const precision = currencyInfo.decimals ?? 2;
      if (Math.abs(amount * 10 ** precision - Math.round(amount * 10 ** precision)) > 0.00001) throw fail(`المبلغ يحتوي كسورًا أكثر مما تسمح به ${currency}`);
      const rate = number(raw.rate, 'سعر الصرف', true);
      if (currency === 'USD' && rate !== undefined && rate !== 1) throw fail('سعر الدولار يجب أن يكون 1 أو فارغًا');
      const paying = resolve(accounts.filter(a => a.isCash && !a.requires?.includes('employee')), raw.paymentAccount, ['code'], 'حساب الدفع', kind !== 'expenses');
      if (paying && (paying.currency || 'USD') !== currency) throw fail('عملة حساب الدفع تختلف عن عملة الفاتورة؛ سجّل التحويل أو السداد بعملة مختلفة من إجراء الدفع');
      const type = resolve(r.types, raw.expenseType, ['name', '_id'], 'نوع المصروف', kind !== 'expenses');
      const target = kind === 'expenses' ? 'expense' : TARGETS[text(raw.target)];
      if (!target) throw fail('اختر تصنيفًا من تعليمات القالب');
      const officeInput = text(raw.office) || type?.defaultOffice || paying?.office;
      const office = resolve(r.config.offices.filter(o => o.isActive), officeInput, ['code', 'name'], 'المكتب', ['order', 'trip', 'customs'].includes(target));
      const line = { description: text(raw.description) || type?.name, amount, target, office: office?.code };
      if (!line.description || line.description.length > 1000) throw fail('الوصف مطلوب وبحد أقصى 1000 حرف');
      if (['expense', 'asset', 'prepaid'].includes(target)) {
        const account = resolve(accounts, text(raw.account) || r.config.accountsById.get(String(type?.accountId))?.code, ['code'], 'حساب التكلفة');
        if (type && text(raw.account) && String(account._id) !== String(type.accountId)) throw fail('حساب المصروف لا يطابق نوع المصروف المحدد');
        if (target === 'prepaid') {
          const startMonth = text(raw.startMonth) || day.slice(0, 7);
          if (!isDay(startMonth + '-01')) throw fail('شهر بداية التوزيع يجب أن يكون شهرًا صحيحًا بصيغة YYYY-MM');
          line.prepaid = { expenseAccountId: String(account._id), months: number(raw.months, 'عدد الأشهر'), startMonth };
        }
        else line.accountId = String(account._id);
        if (target === 'asset') line.asset = { name: text(raw.assetName) || line.description, usefulLifeMonths: number(raw.months, 'عمر الأصل بالأشهر'), salvageValue: text(raw.salvageValue) === '' || Number(raw.salvageValue) === 0 ? 0 : number(raw.salvageValue, 'قيمة الخردة بالدولار') };
        if (['asset', 'prepaid'].includes(target) && !Number.isInteger(Number(raw.months))) throw fail('عدد الأشهر يجب أن يكون عددًا صحيحًا موجبًا');
      }
      if (['order', 'customs'].includes(target)) {
        const order = resolve(r.orders, raw.order, ['orderId', '_id'], 'الطلبية');
        line.orderId = String(order._id); line.office = order.placedAt;
        if (target === 'customs') {
          const pack = order.paymentList.find(p => String(p._id) === text(raw.package));
          if (!pack) throw fail('معرّف الطرد غير موجود داخل الطلبية');
          line.packageId = String(pack._id);
        }
      }
      if (target === 'trip') { const trip = resolve(r.trips, raw.trip, ['voyage', '_id'], 'الرحلة'); line.tripId = String(trip._id); line.office = trip.inventoryPlace; }
      const header = { vendorId: String(vendor._id), vendorRef: text(raw.vendorRef), day, currency, rate, paidImmediatelyFrom: paying ? String(paying._id) : undefined, note: text(raw.note), isQuickExpense: kind === 'expenses', expenseTypeId: kind === 'expenses' ? String(type._id) : undefined };
      if (group.header && hash(group.header) !== hash(header)) throw fail('سطور نفس المعرّف يجب أن تتفق في المورد والتاريخ والعملة والدفع والسعر والملاحظات ونوع المصروف');
      group.header = header; group.vendorName = vendor.name;
      group.day = day; group.currency = currency;
      group.paymentLabel = paying ? `${paying.code} · ${paying.name}` : 'آجلة / بدون سداد';
      if (group.lines.some(existing => hash(existing) === hash(line))) throw fail('سطر مكرر داخل الفاتورة؛ احذفه أو اجمع قيمته في سطر واحد');
      group.lines.push(line);
      const role = { order: 'purchase_cost_wip', trip: 'trip_cost_wip', customs: 'customs_cost_wip', prepaid: 'prepaid_expenses' }[target];
      const costAccount = r.config.accountsById.get(String(line.accountId || (role && r.config.settings?.accountRoles?.[role])));
      group.details.push({ rowNumber, description: line.description, target, account: costAccount ? `${costAccount.code} · ${costAccount.name}` : '', office: r.config.offices.find(o => o.code === line.office)?.name || line.office, order: text(raw.order), trip: text(raw.trip) });
    } catch (error) { group.errors.push(`سطر ${rowNumber}: ${error.message}`); }
  }
  for (const group of groups.values()) {
    if (!group.errors.length) {
      try {
        group.input = { ...group.header, lines: group.lines };
        await validateBillInput(group.input, null, { readOnly: true });
        const valued = { ...group.input };
        const carried = await carriedValue(valued, null);
        const effective = carried ? { rate: valued.rate, source: 'carrying' } : await getRate(group.header.currency, group.header.day, { docRate: group.header.rate });
        group.rate = effective.rate;
        group.valuationSource = effective.source;
        if (effective.source === 'previous' || effective.source === 'next') group.warnings.push(`سعر الصرف مأخوذ من ${effective.day} (${effective.source === 'previous' ? 'السعر السابق' : 'السعر التالي'})`);
        group.total = group.lines.reduce((sum, line) => sum + line.amount, 0);
        group.idempotencyKey = 'excel-bill:' + hash([group.header.vendorId, group.reference.toUpperCase()]);
        group.importHash = hash(group.input);
        group.previewHash = hash({ input: group.input, effectiveRate: group.rate });
        const existing = await SupplierBill.findOne({ idempotencyKey: group.idempotencyKey }).lean();
        if (existing) {
          if (existing.importHash !== group.importHash) throw fail('هذا المعرّف مستورد سابقًا بمحتوى مختلف؛ راجع الفاتورة الموجودة بدل استيراد تكلفة ثانية');
          group.status = 'duplicate'; group.existingId = String(existing._id); group.existingNumber = existing.number;
        } else if (group.header.vendorRef) {
          const sameReference = await SupplierBill.findOne({ vendorId: group.header.vendorId, vendorRef: group.header.vendorRef, status: { $ne: 'canceled' }, isCreditNote: { $ne: true } }).select('_id number').lean();
          if (sameReference) { group.existingId = String(sameReference._id); throw fail('رقم فاتورة المورد موجود بالفعل؛ راجع الفاتورة السابقة لتجنب تسجيل تكلفتها مرتين'); }
        }
      } catch (error) { group.errors.push(error.message); }
    }
    if (group.errors.length) group.status = 'error';
    delete group.header;
  }
  return [...groups.values()];
}
async function preview(body) {
  const groups = await prepare(body.kind, body.rows);
  return { groups: groups.map(({ input, idempotencyKey, ...group }) => group), summary: { ready: groups.filter(g => g.status === 'ready').length, errors: groups.filter(g => g.status === 'error').length, duplicates: groups.filter(g => g.status === 'duplicate').length } };
}
async function commit(body, req) {
  if (!['draft', 'post'].includes(body.mode)) throw fail('اختر حفظ مسودة أو ترحيل');
  const groups = await prepare(body.kind, body.rows);
  if (groups.length !== 1) throw fail('اعتمد فاتورة واحدة في كل طلب');
  const group = groups[0];
  if (group.status === 'error') throw fail(group.errors.join(' · '));
  if (body.previewHash !== group.previewHash) throw fail('تغيرت البيانات أو سعر الصرف منذ المعاينة؛ أعد المراجعة قبل الموافقة');
  if (group.status === 'duplicate') return { duplicate: true, _id: group.existingId, number: group.existingNumber };
  const bill = await runInTransaction(async session => {
    // Serialize imports for the same supplier, including different Excel ids
    // that accidentally refer to the same supplier invoice number.
    const locked = await Vendor.updateOne({ _id: group.input.vendorId, isActive: true }, { $inc: { __v: 1 } }, { session });
    if (locked.modifiedCount !== 1) throw fail('المورد لم يعد متاحًا');
    const existing = await SupplierBill.findOne({ idempotencyKey: group.idempotencyKey }).session(session);
    if (existing) { if (existing.importHash !== group.importHash) throw fail('المعرّف موجود بمحتوى مختلف'); return existing; }
    if (group.input.vendorRef && await SupplierBill.exists({ vendorId: group.input.vendorId, vendorRef: group.input.vendorRef, status: { $ne: 'canceled' }, isCreditNote: { $ne: true } }).session(session)) throw fail('رقم فاتورة المورد استورد بالفعل أثناء المراجعة؛ لن تُكرر التكلفة');
    if (group.valuationSource === 'carrying') {
      const current = { ...group.input };
      if (!(await carriedValue(current, session)) || current.rate !== group.rate) throw fail('تغير متوسط تكلفة رصيد الحساب؛ أعد المعاينة قبل الموافقة');
    }
    const doc = await createBill({ ...group.input, ...(group.valuationSource !== 'carrying' && { rate: group.rate }), idempotencyKey: group.idempotencyKey }, { session, req, asDraft: body.mode === 'draft' });
    doc.importReference = group.reference; doc.importHash = group.importHash;
    doc.total = group.total;
    await doc.save({ session });
    await logAudit({ req, action: 'bill.excelImport', model: 'AccountingSupplierBill', docId: doc._id, after: { importReference: group.reference, sourceRows: group.sourceRows.map(row => row.rowNumber), mode: body.mode, kind: body.kind, rate: group.rate, valuationSource: group.valuationSource } }, session);
    return doc;
  });
  return { _id: String(bill._id), number: bill.number, status: bill.status };
}
module.exports = { templateReferences, preview, commit };
