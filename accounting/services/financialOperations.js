const mongoose = require('mongoose');
const { Operation, Action } = require('../models/FinancialOperation');
const { postEntry } = require('./ledger');
const { getBalance } = require('./carrying');
const { isDay, today } = require('./dates');
const { logAudit } = require('./audit');
const { getConfig } = require('./config');
const {
  fail, currencyOf, getAccount, toCurrencyMinor, moneyLine, resolveAccount, nextDocNumber,
  RateBook, valueOut, addFxLine, lockPostingAccounts, isBeforeCashCount,
} = require('./posting/common');
const TYPES = {
  mistaken_transfer: { name: 'حوالة خاطئة قيد الاسترداد', permission: 'treasury', monetary: true },
  transfer_in_transit: { name: 'تحويل بين الحسابات بانتظار الوصول', permission: 'treasury', monetary: true },
  refundable_deposit: { name: 'تأمين مكتب أو مخزن مسترد', permission: 'assets', monetary: true },
  salary_accrual: { name: 'راتب مستحق قبل الصرف', permission: 'payroll', employee: true },
  commission_accrual: { name: 'عمولة موظف مستحقة قبل الصرف', permission: 'payroll', employee: true },
  receivables_allowance: { name: 'مخصص خسائر ذمم عميل', permission: 'entries', allowance: true },
  inventory_allowance: { name: 'مخصص انخفاض قيمة مخزون الشركة', permission: 'entries', allowance: true },
  company_stock: { name: 'شراء بضائع تملكها الشركة', permission: 'purchases', stock: true },
  loan_current_portion: { name: 'نقل أقساط قرض إلى المستحق خلال سنة', permission: 'assets', reclass: true },
  fx_revaluation: { name: 'فرق إعادة تقييم عملة', permission: 'entries', valuation: true },
};
function permit(req, type, cancel = false) {
  if (!req.access?.isOwner && !req.access?.permissions?.includes(cancel ? 'cancel' : type.permission)) throw fail('ليس لديك صلاحية هذا الإجراء');
}
function date(day) { if (!isDay(day) || day > today()) throw fail('اختر تاريخًا صالحًا لا يكون في المستقبل'); }
function key(input) { if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 160) throw fail('مفتاح العملية مطلوب'); }
const dimensions = doc => ({ office: doc.office, employeeId: doc.employeeId, partnerId: doc.partnerId, label: doc.description });

async function remaining(doc, session) {
  const rows = await Action.find({ operationId: doc._id, status: 'posted' }).session(session || null).lean();
  return { minor: doc.totalMinor - rows.reduce((s, a) => s + a.amountMinor, 0), usd: doc.usd - rows.reduce((s, a) => s + a.usd, 0), actions: rows };
}
async function catalog(req) {
  return { kinds: Object.entries(TYPES).filter(([, t]) => req.access?.isOwner || req.access?.permissions?.includes(t.permission)).map(([value, t]) => ({ value, ...t })),
    employees: req.access?.isOwner || req.access?.permissions?.includes('payroll') ? await require('./employees').list() : [] };
}
async function list(req, query = {}) {
  const kinds = Object.keys(TYPES).filter(k => req.access?.isOwner || req.access?.permissions?.some(p => [TYPES[k].permission, 'reports'].includes(p)));
  const filter = { kind: { $in: kinds }, ...(query.kind && kinds.includes(query.kind) && { kind: query.kind }), ...(query.status !== 'all' && { status: 'posted' }) };
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50)), page = Math.max(1, Number(query.page) || 1);
  const [docs, total] = await Promise.all([Operation.find(filter).sort({ day: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
    .populate('fromAccountId', 'name currency').populate('counterAccountId', 'name currency').lean(), Operation.countDocuments(filter)]);
  const actions = await Action.find({ operationId: { $in: docs.map(d => d._id) } }).sort({ day: -1 }).populate('accountId', 'name currency').lean();
  return { total, page, limit, results: docs.map(doc => {
    const related = actions.filter(a => String(a.operationId) === String(doc._id));
    const active = related.filter(a => a.status === 'posted');
    return { ...doc, name: TYPES[doc.kind]?.name, openMinor: doc.totalMinor - active.reduce((s, a) => s + a.amountMinor, 0),
      openUsd: doc.usd - active.reduce((s, a) => s + a.usd, 0), actions: related };
  }) };
}
async function create(input, { session, req }) {
  const type = TYPES[input.kind]; if (!type) throw fail('نوع العملية غير صالح'); permit(req, type); key(input); date(input.day);
  const existing = await Operation.findOne({ idempotencyKey: input.idempotencyKey }).session(session); if (existing) return existing;
  const { offices, settings } = await getConfig();
  if (!offices.has(input.office)) throw fail('اختر المكتب');
  const description = String(input.description || '').trim(); if (!description || description.length > 500) throw fail('اكتب بيان العملية');
  const currency = type.allowance || type.reclass || type.valuation ? 'USD' : String(input.currency || 'USD').toUpperCase();
  const rates = new RateBook(session); const minor = await toCurrencyMinor(input.amount, currency); if (!minor) throw fail('المبلغ مطلوب');
  let usd, counter, expense, from; let employeeId, partnerId, employeeName = '', totalMinor = minor;
  const dims = { office: input.office, label: description };
  let lines;
  if (type.monetary || type.stock) {
    from = await getAccount(input.fromAccountId, 'الحساب الدافع');
    if (!from.isCash || currencyOf(from) !== currency) throw fail('اختر خزينة أو بنكًا بعملة العملية');
    if (!(await isBeforeCashCount(input.day))) await lockPostingAccounts([from], session);
    usd = await valueOut(from, minor, { day: input.day, rates, docRate: input.rate });
    counter = await resolveAccount(type.stock ? 'company_inventory' : `${input.kind}_${currency.toLowerCase()}`);
    if (type.stock) {
      const q = Number(input.quantity); if (!(q > 0) || !Number.isFinite(q) || Math.abs(q * 1000 - Math.round(q * 1000)) > 0.000001) throw fail('اكتب كمية موجبة بحد أقصى 3 منازل عشرية');
      totalMinor = Math.round(q * 1000);
      if (!input.confirmCompanyOwned) throw fail('أكد أن هذه بضائع تملكها الشركة');
    }
    lines = [type.stock ? { accountId: counter._id, debit: usd, ...dims } : moneyLine(counter, 'debit', minor, usd, dims), moneyLine(from, 'credit', minor, usd, dims)];
  } else if (type.employee) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month || '')) throw fail('اختر شهر الاستحقاق');
    if (input.month > input.day.slice(0, 7)) throw fail('شهر الاستحقاق لا يكون في المستقبل');
    const employee = await require('./employees').lock(input.employeeId, session); if (!employee.isActive) throw fail('الموظف مؤرشف');
    employeeId = employee._id; dims.employeeId = employeeId;
    employeeName = `${employee.firstName} ${employee.lastName || ''}`.trim();
    if (await Operation.exists({ kind: input.kind, employeeId, month: input.month, status: 'posted' }).session(session)) throw fail('هذا الاستحقاق مسجل للموظف في الشهر نفسه');
    const paidKind = input.kind === 'salary_accrual' ? { paymentKind: { $ne: 'commission' } }
      : { $or: [{ paymentKind: 'commission' }, { commissionAmount: { $gt: 0 } }] };
    if (await require('../models/documents').SalaryPayment.exists({ employeeId, month: input.month, status: 'posted', ...paidKind }).session(session)) throw fail('يوجد صرف لهذا النوع من المستحق في الشهر؛ راجع بيان الموظف قبل تسجيل استحقاق آخر');
    usd = await rates.toUsd(minor, currency, input.day, input.rate);
    counter = await resolveAccount(`${input.kind === 'salary_accrual' ? 'salary_payable' : 'commission_payable'}_${currency.toLowerCase()}`);
    expense = await resolveAccount(input.kind === 'salary_accrual' ? 'salaries_expense' : 'employee_commission_expense');
    const grossUsd = usd;
    const deduction = await toCurrencyMinor(input.advanceDeduction || 0, currency);
    if (deduction && input.kind !== 'salary_accrual') throw fail('خصم السلفة يتم من استحقاق الراتب');
    if (deduction >= minor) throw fail('خصم السلفة يجب أن يكون أقل من الراتب؛ للتسوية الكاملة بالسلفة استخدم نموذج الراتب المعتاد');
    totalMinor = minor - deduction;
    usd = await rates.toUsd(totalMinor, currency, input.day, input.rate);
    lines = [{ accountId: expense._id, debit: grossUsd, ...dims }, moneyLine(counter, 'credit', totalMinor, usd, dims)];
    if (deduction) {
      const custody = require('./custody');
      const loan = await custody.accountOf('loan', currency);
      if (!loan || deduction > await custody.heldMinor(loan, employeeId, session)) throw fail('الخصم أكبر من سلفة الموظف المتاحة بهذه العملة');
      const loanUsd = await valueOut(loan, deduction, { day: input.day, rates, docRate: input.rate, employeeId });
      lines.push(moneyLine(loan, 'credit', deduction, loanUsd, dims));
      await addFxLine(lines, input.office);
    }
  } else if (type.allowance) {
    usd = minor;
    counter = await resolveAccount(input.kind);
    expense = await resolveAccount(input.kind === 'receivables_allowance' ? 'receivables_allowance_expense' : 'inventory_impairment_expense');
    if (input.kind === 'receivables_allowance') {
      if (!mongoose.isValidObjectId(input.partnerId) || !await require('../../models/user').exists({ _id: input.partnerId }).session(session)) throw fail('اختر العميل');
      partnerId = input.partnerId; dims.partnerId = partnerId;
    }
    const source = await resolveAccount(input.kind === 'receivables_allowance' ? 'customer_receivable' : 'company_inventory');
    await require('../models').Account.updateOne({ _id: counter._id }, { $inc: { postingVersion: 1 } }, { session });
    const original = await getBalance(source._id, { session, partnerId });
    const reserved = await getBalance(counter._id, { session, partnerId });
    if (usd > original.usd + Math.min(reserved.usd, 0)) throw fail('المخصص أكبر من صافي الرصيد المتاح');
    lines = [{ accountId: expense._id, debit: usd, ...dims }, { accountId: counter._id, credit: usd, ...dims }];
  } else if (type.reclass) {
    usd = minor; counter = await resolveAccount('current_loan_portion');
    from = await getAccount(input.fromAccountId, 'حساب القرض');
    const valid = ['loans', 'long_term_loans'].map(r => String(settings.accountRoles?.[r]));
    if (!valid.includes(String(from._id)) || (from.currency && from.currency !== 'USD')) throw fail('اختر حساب قرض بالدولار');
    await require('../models').Account.updateOne({ _id: from._id }, { $inc: { postingVersion: 1 } }, { session });
    if (usd > -(await getBalance(from._id, { session })).usd) throw fail('المبلغ أكبر من رصيد القرض');
    lines = [{ accountId: from._id, debit: usd, ...dims }, { accountId: counter._id, credit: usd, ...dims }];
  } else if (type.valuation) {
    usd = minor; from = await getAccount(input.fromAccountId, 'حساب العملة');
    if (!from.isCash || !from.currency || from.currency === 'USD' || !['asset', 'liability'].includes(from.type)) throw fail('اختر حساب خزينة أو بنك أو محفظة بعملة أجنبية');
    counter = await resolveAccount(input.gain === true ? 'fx_unrealized_gain' : 'fx_unrealized_loss');
    const asset = from.type === 'asset', gain = input.gain === true;
    const side = asset === gain ? 'debit' : 'credit';
    lines = [moneyLine(from, side, 0, usd, dims), { accountId: counter._id, [gain ? 'credit' : 'debit']: usd, ...dims }];
  }
  if (!(usd > 0)) throw fail('تعذر تحديد قيمة العملية بالدولار');
  const [doc] = await Operation.create([{ kind: input.kind, day: input.day, office: input.office, description, currency, totalMinor, usd,
    ...(type.stock && { quantity: Number(input.quantity) }), month: input.month, employeeId, partnerId,
    ...(type.employee && { grossAmount: Number(input.amount), advanceDeduction: Number(input.advanceDeduction || 0) }),
    partyName: String(input.partyName || employeeName).trim(), fromAccountId: from?._id, counterAccountId: counter._id, expenseAccountId: expense?._id,
    idempotencyKey: input.idempotencyKey, createdBy: req.user._id, number: await nextDocNumber('FOP', input.day, session) }], { session });
  if (from?.isCash && (currencyOf(from) === 'CNY' || input.transactionReference)) await require('./posting/alipayReconciliation').beforeRecording(from._id, -minor, input.day, input.transactionReference, session);
  const entry = await postEntry({ eventType: 'FINANCIAL_OPERATION', eventKey: `FINANCIAL_OPERATION:${doc._id}`, date: input.day,
    description: `${type.name} ${doc.number}: ${description}`, source: { model: 'AccountingFinancialOperation', id: doc._id }, lines, fallbacks: rates.fallbacks }, { session, user: req.user });
  doc.entryId = entry._id; await doc.save({ session }); await rates.lock();
  if (from?.isCash && input.transactionReference) await require('./posting/alipayReconciliation').afterRecording(entry._id, from._id, input.transactionReference, { session, req });
  await logAudit({ req, action: 'financial-operation.create', model: 'AccountingFinancialOperation', docId: doc._id, after: doc }, session);
  return doc;
}

async function settle(id, input, { session, req }) {
  key(input); date(input.day);
  const doc = await Operation.findOneAndUpdate({ _id: id, status: 'posted' }, { $inc: { postingVersion: 1 } }, { new: true, session });
  if (!doc) throw fail('العملية غير متاحة'); const type = TYPES[doc.kind]; permit(req, type);
  if (type.valuation) throw fail('صحح إعادة التقييم بإلغاء القيد وتسجيل القيمة الصحيحة');
  if (input.day < doc.day) throw fail('تاريخ التسوية لا يسبق العملية');
  const old = await Action.findOne({ idempotencyKey: input.idempotencyKey }).session(session);
  if (old) { if (String(old.operationId) !== String(doc._id)) throw fail('مفتاح السداد مستخدم لعملية أخرى'); return old; }
  const open = await remaining(doc, session);
  const minor = type.stock ? Math.round(Number(input.quantity) * 1000) : await toCurrencyMinor(input.amount, doc.currency);
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > open.minor) throw fail('المبلغ أو الكمية أكبر من المتبقي أو غير صالح');
  const usd = minor === open.minor ? open.usd : Math.round(open.usd * minor / open.minor);
  const counter = await getAccount(doc.counterAccountId); const dims = dimensions(doc); const rates = new RateBook(session);
  let lines, account, receivedAmount; const mode = input.mode || 'settle';
  if (type.allowance) {
    if (mode !== 'release') throw fail('اختر تخفيض المخصص');
    lines = [{ accountId: counter._id, debit: usd, ...dims }, { accountId: doc.expenseAccountId, credit: usd, ...dims }];
  } else if (mode === 'writeoff') {
    if (!['mistaken_transfer', 'refundable_deposit'].includes(doc.kind)) throw fail('الشطب غير متاح لهذه العملية');
    if (String(input.reason || '').trim().length < 10) throw fail('اكتب سببًا واضحًا للشطب');
    const expense = await resolveAccount(doc.kind === 'mistaken_transfer' ? 'mistaken_transfer_loss' : 'general_expense');
    lines = [{ accountId: expense._id, debit: usd, ...dims }, moneyLine(counter, 'credit', minor, usd, dims)];
  } else {
    if (mode !== 'settle') throw fail('نوع التسوية غير صالح');
    account = await getAccount(input.accountId, 'حساب الاستلام أو الصرف');
    if (!account.isCash) throw fail('اختر خزينة أو بنكًا');
    if ((type.employee || doc.kind === 'mistaken_transfer' || doc.kind === 'refundable_deposit') && currencyOf(account) !== doc.currency) throw fail('اختر حسابًا بعملة العملية');
    if (type.employee || type.reclass) {
      if (type.reclass && currencyOf(account) !== 'USD') throw fail('اختر حساب دولار');
      if (!(await isBeforeCashCount(input.day))) await lockPostingAccounts([account], session);
      const out = await valueOut(account, minor, { day: input.day, rates, docRate: input.rate });
      lines = [moneyLine(counter, 'debit', minor, usd, dims), moneyLine(account, 'credit', minor, out, dims)];
      await addFxLine(lines, doc.office);
    } else if (type.stock) {
      const sale = await toCurrencyMinor(input.receivedAmount, currencyOf(account)); if (!sale) throw fail('أدخل ثمن البيع');
      const saleUsd = await rates.toUsd(sale, currencyOf(account), input.day, input.rate);
      receivedAmount = Number(input.receivedAmount);
      lines = [moneyLine(account, 'debit', sale, saleUsd, dims), { accountId: (await resolveAccount('company_inventory_revenue'))._id, credit: saleUsd, ...dims },
        { accountId: (await resolveAccount('company_inventory_cost'))._id, debit: usd, ...dims }, { accountId: counter._id, credit: usd, ...dims }];
    } else {
      const nativeReceived = currencyOf(account) === doc.currency ? minor : await toCurrencyMinor(input.receivedAmount, currencyOf(account));
      if (!nativeReceived) throw fail('أدخل المبلغ الواصل بعملة الحساب المستلم');
      receivedAmount = currencyOf(account) === doc.currency ? Number(input.amount) : Number(input.receivedAmount);
      lines = [moneyLine(account, 'debit', nativeReceived, usd, dims), moneyLine(counter, 'credit', minor, usd, dims)];
    }
  }
  const [action] = await Action.create([{ operationId: doc._id, day: input.day, mode, amountMinor: minor, usd, receivedAmount, accountId: account?._id,
    description: String(input.reason || '').trim(), idempotencyKey: input.idempotencyKey, createdBy: req.user._id, number: await nextDocNumber('FOS', input.day, session) }], { session });
  if (account && (currencyOf(account) === 'CNY' || input.transactionReference)) {
    const cashLine = lines.find(l => String(l.accountId) === String(account._id));
    const signed = currencyOf(account) === 'USD' ? Number(cashLine.debit || 0) - Number(cashLine.credit || 0) : cashLine.amountCurrency;
    await require('./posting/alipayReconciliation').beforeRecording(account._id, signed, input.day, input.transactionReference, session);
  }
  const entry = await postEntry({ eventType: 'FINANCIAL_SETTLEMENT', eventKey: `FINANCIAL_SETTLEMENT:${action._id}`, date: input.day,
    description: `${type.name} ${doc.number}: ${mode === 'writeoff' ? 'شطب فرق غير مسترد' : 'تسوية'} ${action.number}`,
    source: { model: 'AccountingFinancialOperationAction', id: action._id }, lines, fallbacks: rates.fallbacks }, { session, user: req.user });
  action.entryId = entry._id; await action.save({ session }); await rates.lock();
  if (account && input.transactionReference) await require('./posting/alipayReconciliation').afterRecording(entry._id, account._id, input.transactionReference, { session, req });
  await logAudit({ req, action: 'financial-operation.settle', model: 'AccountingFinancialOperationAction', docId: action._id, after: action }, session);
  return action;
}

async function bankOptions(lineId, req) {
  const line = await require('../models/documents').BankStatementLine.findById(lineId).lean();
  if (!line) throw fail('سطر الكشف غير موجود');
  const kinds = line.amount > 0 ? ['mistaken_transfer', 'transfer_in_transit', 'refundable_deposit'] : ['salary_accrual', 'commission_accrual', 'loan_current_portion'];
  const allowed = kinds.filter(k => req.access?.isOwner || req.access?.permissions?.includes(TYPES[k].permission));
  const docs = await Operation.find({ kind: { $in: allowed }, status: 'posted', day: { $lte: line.day } }).sort({ day: -1 }).limit(100).lean();
  const actions = await Action.find({ operationId: { $in: docs.map(d => d._id) }, status: 'posted' }).lean();
  return { results: docs.map(d => ({ ...d, name: TYPES[d.kind].name,
    openMinor: d.totalMinor - actions.filter(a => String(a.operationId) === String(d._id)).reduce((s, a) => s + a.amountMinor, 0),
  })).filter(d => d.openMinor > 0) };
}
async function settleBank(lineId, input, { session, req }) {
  const { BankStatementLine } = require('../models/documents');
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched') throw fail('اختر سطر كشف غير مرحل');
  require('./posting/bankEvidence').assertReviewed(line);
  require('./posting/alipayReconciliation').assertWallet(line);
  if (await isBeforeCashCount(line.day)) throw fail('السطر قبل الجرد؛ راجع الأرصدة الافتتاحية والتسوية التاريخية قبل تسجيل حركة نقدية جديدة');
  const operation = await Operation.findById(input.operationId).session(session);
  if (!operation) throw fail('اختر العملية الأصلية');
  const incoming = ['mistaken_transfer', 'transfer_in_transit', 'refundable_deposit'].includes(operation.kind);
  if (incoming !== (line.amount > 0)) throw fail('اتجاه الكشف لا يناسب هذه التسوية');
  const account = await getAccount(line.accountId); const currency = currencyOf(account);
  const amount = Math.abs(line.amount) / 10 ** await require('./posting/common').decimalsOf(currency);
  const action = await settle(operation._id, { day: line.day, mode: 'settle', accountId: account._id,
    amount: currency === operation.currency ? amount : input.originalAmount, receivedAmount: amount, rate: input.rate,
    transactionReference: line.sourceTransactionId || line.reference,
    idempotencyKey: `FOS:BANK:${line._id}:${line.postingAttempt || 0}`,
  }, { session, req });
  const current = await BankStatementLine.findById(line._id).session(session);
  if (current.lineStatus === 'unmatched') await require('./posting/bank').manualMatch(line._id, [action.entryId], { session, req });
  await BankStatementLine.updateOne({ _id: line._id }, { $set: { lineStatus: 'created_entry', entryId: action.entryId, financialActionId: action._id } }, { session });
  return action;
}
async function checkCashCancellation(model, docId, { session, confirmNegative }) {
  const { accountsById } = await getConfig();
  const entries = await require('../models').JournalEntry.find({ 'source.model': model, 'source.id': docId, status: 'posted', reversalOf: { $exists: false } }).session(session).lean();
  const debits = new Map();
  for (const entry of entries) for (const line of entry.lines) if (accountsById.get(String(line.accountId))?.isCash && line.debit > 0) {
    debits.set(String(line.accountId), (debits.get(String(line.accountId)) || 0) + line.amountCurrency);
  }
  const accounts = [...debits.keys()].map(id => accountsById.get(id));
  if (accounts.length) await lockPostingAccounts(accounts, session);
  for (const account of accounts) if ((await getBalance(account._id, { session })).foreign < debits.get(String(account._id)) && !confirmNegative) throw fail(`الحساب ${account.name} سيصبح سالبًا بعد الإلغاء؛ راجع المبالغ التي صُرفت منه`);
}
module.exports = { TYPES, catalog, list, create, settle, remaining, bankOptions, settleBank, checkCashCancellation };
