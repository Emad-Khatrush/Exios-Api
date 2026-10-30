const mongoose = require('mongoose');
const User = require('../../models/user');
const { Employee, Adjustment } = require('../models/Employee');
const { SalaryPayment } = require('../models/documents');
const { fail, toCurrencyMinor, decimalsOf, officeExists, RateBook } = require('./posting/common');
const { toMinor } = require('./money');
const { isDay, today } = require('./dates');
const { Currency } = require('../models');
const { logAudit } = require('./audit');
const STAFF = { $or: [{ 'roles.isEmployee': true }, { 'roles.isAdmin': true }, { 'roles.isAccountant': true }] };
const monthValid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '');
async function get(id, session) {
  if (!mongoose.isValidObjectId(id)) throw fail('الموظف غير صالح');
  const profile = await Employee.findById(id).session(session || null).lean();
  if (profile) return { ...profile, hasLogin: !!profile.userId };
  const user = await User.findOne({ _id: id, ...STAFF }).select('firstName lastName customerId').session(session || null).lean();
  if (!user) throw fail('الموظف غير موجود');
  return { ...user, userId: user._id, hasLogin: true, isActive: true, baseSalary: 0, salaryCurrency: 'USD', virtual: true };
}
async function list({ includeArchived = false } = {}) {
  const [users, profiles] = await Promise.all([User.find(STAFF).select('firstName lastName customerId').lean(), Employee.find({}).lean()]);
  const map = new Map(users.map(u => [String(u._id), { ...u, userId: u._id, hasLogin: true, isActive: true, baseSalary: 0, salaryCurrency: 'USD' }]));
  for (const p of profiles) map.set(String(p._id), { ...map.get(String(p._id)), ...p, hasLogin: !!p.userId });
  return [...map.values()].filter(p => includeArchived || p.isActive).sort((a, b) => `${a.firstName} ${a.lastName || ''}`.localeCompare(`${b.firstName} ${b.lastName || ''}`));
}
async function lock(id, session) {
  const person = await get(id, session);
  await Employee.updateOne({ _id: person._id }, { $setOnInsert: { firstName: person.firstName, lastName: person.lastName || '', userId: person.userId, baseSalary: person.baseSalary, salaryCurrency: person.salaryCurrency, isActive: person.isActive }, $inc: { allocationVersion: 1 } }, { upsert: true, session });
  return person;
}
async function save(id, body, { session, req }) {
  const old = id ? await lock(id, session) : null;
  const firstName = String(body.firstName || '').trim(), lastName = String(body.lastName || '').trim();
  if (!firstName || firstName.length > 120 || lastName.length > 120) throw fail('اكتب اسم الموظف بشكل صحيح');
  const currency = String(body.salaryCurrency || 'USD').toUpperCase();
  if (!(await Currency.exists({ code: currency, isActive: true }).session(session))) throw fail('اختر عملة فعالة');
  if (old && currency !== old.salaryCurrency && await Adjustment.exists({ employeeId: id, currency: old.salaryCurrency, isCanceled: false, salaryId: null }).session(session)) throw fail('توجد عمولات أو خصومات غير مصروفة بالعملة السابقة؛ سوّها قبل تغيير عملة الراتب');
  const salary = Number(body.baseSalary || 0);
  if (!Number.isFinite(salary) || salary < 0) throw fail('الراتب الأساسي غير صالح');
  const salaryMinor = await toCurrencyMinor(salary, currency);
  if (body.office && !(await officeExists(body.office))) throw fail('المكتب غير صالح');
  const fields = { firstName, lastName, phone: String(body.phone || '').slice(0, 60), office: body.office || '', baseSalary: salaryMinor / 10 ** await decimalsOf(currency), salaryCurrency: currency };
  let doc;
  if (old) doc = await Employee.findByIdAndUpdate(id, { $set: fields }, { new: true, session, runValidators: true });
  else [doc] = await Employee.create([{ ...fields, createdBy: req.user._id }], { session });
  await logAudit({ req, action: old ? 'employee.update' : 'employee.create', model: 'AccountingEmployee', docId: doc._id, before: old, after: doc }, session);
  return doc;
}
async function setActive(id, active, { session, req }) {
  const old = await lock(id, session);
  await Employee.updateOne({ _id: id }, { $set: { isActive: active } }, { session });
  await logAudit({ req, action: active ? 'employee.restore' : 'employee.archive', model: 'AccountingEmployee', docId: old._id, before: old, after: { isActive: active } }, session);
}
async function addAdjustment(id, body, { session, req }) {
  const person = await lock(id, session);
  if (!person.isActive) throw fail('الموظف مؤرشف؛ أعده للقائمة أولًا');
  if (!['commission', 'deduction'].includes(body.kind)) throw fail('اختر عمولة أو خصم');
  const reason = String(body.reason || '').trim();
  if (!isDay(body.day) || !monthValid(body.month) || !reason || reason.length > 1000) throw fail('التاريخ وشهر الاستحقاق وسبب الحركة مطلوبة');
  const currency = String(body.currency || person.salaryCurrency).toUpperCase();
  if (body.kind === 'deduction' && currency !== person.salaryCurrency) throw fail('سجّل الخصم بعملة الراتب الأساسي');
  if (body.rate !== undefined && body.rate !== '' && (!Number.isFinite(Number(body.rate)) || Number(body.rate) <= 0)) throw fail('سعر الصرف غير صالح');
  if (!(await Currency.exists({ code: currency, isActive: true }).session(session))) throw fail('العملة غير صالحة');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw fail('المبلغ يجب أن يكون أكبر من صفر');
  const amountMinor = await toCurrencyMinor(amount, currency);
  if (!amountMinor) throw fail('المبلغ أصغر من أقل وحدة للعملة');
  if (body.kind === 'deduction' && await SalaryPayment.exists({ employeeId: id, month: body.month, status: 'posted', structuredSalary: true, paymentKind: { $ne: 'commission' } }).session(session)) throw fail('راتب هذا الشهر مصروف؛ ألغِ الراتب قبل إضافة خصم عليه، أو اختر شهرًا آخر');
  const [doc] = await Adjustment.create([{ employeeId: id, kind: body.kind, day: body.day, month: body.month, amount: amountMinor / 10 ** await decimalsOf(currency), currency, rate: body.rate ? Number(body.rate) : undefined, reason, createdBy: req.user._id }], { session });
  await logAudit({ req, action: 'employee.adjustment.create', model: 'AccountingEmployeeAdjustment', docId: doc._id, after: doc }, session);
  return doc;
}
async function cancelAdjustment(id, adjustmentId, { session, req }) {
  await lock(id, session);
  const doc = await Adjustment.findOne({ _id: adjustmentId, employeeId: id }).session(session);
  if (!doc) throw fail('الحركة غير موجودة');
  if (doc.salaryId || doc.paidMinor > 0 || doc.waivedMinor > 0) throw fail('الحركة مرتبطة بصرف أو تسوية؛ ألغِ الدفعة أو التسوية أولًا');
  doc.isCanceled = true; await doc.save({ session });
  await logAudit({ req, action: 'employee.adjustment.cancel', model: 'AccountingEmployeeAdjustment', docId: doc._id, after: doc }, session);
}
async function settleCommissionRemainder(id, adjustmentId, body, reopen, { session, req }) {
  await lock(id, session);
  if (!mongoose.isValidObjectId(adjustmentId)) throw fail('العمولة غير صالحة');
  const doc = await Adjustment.findOne({ _id: adjustmentId, employeeId: id, kind: 'commission', isCanceled: false }).session(session);
  if (!doc || doc.salaryId) throw fail('لا توجد عمولة متاحة للتسوية');
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 1000) throw fail('اكتب بيان التسوية حتى 1000 حرف');
  const before = doc.toObject();
  if (reopen) {
    const closed = Number(doc.remainderClosure?.amountMinor || 0);
    if (!closed || closed > (doc.waivedMinor || 0)) throw fail('لا يوجد إقفال مباشر يمكن إلغاؤه لهذه العمولة');
    doc.waivedMinor -= closed;
    doc.remainderClosure = undefined;
  } else {
    if (doc.remainderClosure?.amountMinor > 0) throw fail('ألغِ الإقفال السابق أولًا قبل تسجيل تسوية جديدة');
    const remaining = await toCurrencyMinor(doc.amount, doc.currency) - (doc.paidMinor || 0) - (doc.waivedMinor || 0);
    if (remaining <= 0) throw fail('العمولة مسوّاة بالفعل ولا يوجد متبقٍ');
    if (body.expectedRemainingAmount !== undefined && await toCurrencyMinor(body.expectedRemainingAmount, doc.currency) !== remaining) throw fail('تغير المتبقي من العمولة؛ أعد فتح البيان وراجع المبلغ');
    doc.waivedMinor = (doc.waivedMinor || 0) + remaining;
    doc.remainderClosure = { amountMinor: remaining, reason, closedAt: new Date(), closedBy: req.user._id };
  }
  await doc.save({ session });
  await logAudit({ req, action: reopen ? 'employee.commission.reopen' : 'employee.commission.close', model: 'AccountingEmployeeAdjustment', docId: doc._id, before, after: { ...doc.toObject(), settlementReason: reason } }, session);
  return doc;
}
async function preview(id, month, currency, session, day = today(), targetDocRate, rateBook) {
  if (!monthValid(month)) throw fail('شهر الراتب غير صالح');
  if (!isDay(day)) throw fail('تاريخ الصرف غير صالح');
  if (targetDocRate !== undefined && targetDocRate !== '' && (!Number.isFinite(Number(targetDocRate)) || Number(targetDocRate) <= 0)) throw fail('سعر عملة الراتب غير صالح');
  const person = await get(id, session);
  if (currency !== person.salaryCurrency) throw fail('اختر خزينة بعملة الراتب الأساسي');
  const rows = await Adjustment.find({ employeeId: id, month, kind: 'deduction', isCanceled: false, salaryId: null }).session(session || null).lean();
  if (day && rows.some(r => r.day > day)) throw fail('تاريخ صرف الراتب يسبق أحد خصوماته');
  const decimals = await decimalsOf(currency);
  let deduction = 0;
  for (const row of rows) {
    if (row.currency !== currency) throw fail('يوجد خصم بعملة مختلفة؛ راجع بيان الموظف');
    deduction += await toCurrencyMinor(row.amount, currency);
  }
  return { employee: person, adjustments: rows, conversions: [], commissionAmount: 0, salaryDeduction: deduction / 10 ** decimals };
}
async function commissionPreview(id, month, currency, session, day = today(), targetDocRate, rateBook) {
  if (!monthValid(month) || !isDay(day)) throw fail('اختر شهر الاستحقاق وتاريخ الصرف');
  if (!['USD', 'LYD'].includes(currency)) throw fail('اختر الدولار أو الدينار لصرف العمولة');
  if (targetDocRate !== undefined && targetDocRate !== '' && (!Number.isFinite(Number(targetDocRate)) || Number(targetDocRate) <= 0)) throw fail('سعر عملة الصرف غير صالح');
  const employee = await get(id, session);
  const rates = rateBook || new RateBook(session);
  const decimals = await decimalsOf(currency);
  const rows = await Adjustment.find({ employeeId: id, month, kind: 'commission', isCanceled: false, salaryId: null, day: { $lte: day } })
    .sort({ day: 1, _id: 1 }).session(session || null).lean();
  const adjustments = [];
  let availableMinor = 0;
  for (const row of rows) {
    const remainingMinor = Math.max(0, await toCurrencyMinor(row.amount, row.currency) - (row.paidMinor || 0) - (row.waivedMinor || 0));
    if (!remainingMinor) continue;
    const sourceDecimals = await decimalsOf(row.currency);
    const sourceRate = row.currency === currency || row.currency === 'USD' ? 1 : await rates.rate(row.currency, day, row.rate);
    const targetRate = row.currency === currency || currency === 'USD' ? 1 : await rates.rate(currency, day, targetDocRate);
    const paymentMinor = row.currency === currency ? remainingMinor : toMinor((remainingMinor / 10 ** sourceDecimals) / sourceRate * targetRate, decimals);
    if (!Number.isSafeInteger(paymentMinor) || paymentMinor < 0) throw fail('قيمة تحويل العمولة غير صالحة');
    adjustments.push({ ...row, remainingMinor, paymentMinor, sourceDecimals, sourceRate, targetRate }); availableMinor += paymentMinor;
  }
  const fingerprint = require('crypto').createHash('sha256').update(JSON.stringify({ id: String(employee._id), month, currency, day,
    rows: adjustments.map(row => [String(row._id), row.remainingMinor, row.paymentMinor, row.sourceRate, row.targetRate]) })).digest('hex');
  return { employee, adjustments, availableMinor, availableAmount: availableMinor / 10 ** decimals, currency, day, month, fingerprint };
}
async function detail(id) {
  const employee = await get(id);
  const [adjustments, salaries] = await Promise.all([Adjustment.find({ employeeId: id }).sort({ day: -1, createdAt: -1 }).limit(1000).lean(), SalaryPayment.find({ employeeId: id }).populate('paidFromAccountId', 'code name currency').sort({ day: -1 }).limit(1000).lean()]);
  const { Operation, Action } = require('../models/FinancialOperation');
  const accruals = await Operation.find({ employeeId: id, kind: { $in: ['salary_accrual', 'commission_accrual'] } }).sort({ day: -1 }).limit(1000).lean();
  const settlements = await Action.find({ operationId: { $in: accruals.map(a => a._id) } }).sort({ day: -1 }).populate('accountId', 'name currency').lean();
  const detailedAdjustments = await Promise.all(adjustments.map(async row => {
    const scale = 10 ** await decimalsOf(row.currency);
    const paidAmount = row.salaryId ? row.amount : (row.paidMinor || 0) / scale;
    const waivedAmount = (row.waivedMinor || 0) / scale;
    return { ...row, paidAmount, waivedAmount, remainingAmount: row.isCanceled ? 0 : Math.max(0, Math.round((row.amount - paidAmount - waivedAmount) * scale) / scale) };
  }));
  return { employee, adjustments: detailedAdjustments, salaries, accruals: accruals.map(a => ({ ...a,
    openMinor: a.status === 'canceled' ? 0 : a.totalMinor - settlements.filter(s => s.status === 'posted' && String(s.operationId) === String(a._id)).reduce((sum, s) => sum + s.amountMinor, 0),
    settlements: settlements.filter(s => String(s.operationId) === String(a._id)),
  })), limit: 1000 };
}
module.exports = { get, list, lock, save, setActive, addAdjustment, cancelAdjustment, settleCommissionRemainder, preview, commissionPreview, detail };
