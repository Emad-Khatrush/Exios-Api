const { lockWalletOwner } = require('../../../utils/walletLock');
// Salaries (E28), capital / withdrawals / loans (E29), netting with a customer-vendor (E30)
const mongoose = require('mongoose');
const { SalaryPayment, EquityTransaction, Netting, Vendor, SupplierBill } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const Wallet = require('../../../models/wallet');
const UserStatement = require('../../../models/userStatement');
const User = require('../../../models/user');
const { postEntry } = require('../ledger');
const { getBalance } = require('../carrying');
const { lockClaimAllocation } = require('../claims/locks');
const { isDay } = require('../dates');
const { toMinor, fromMinor } = require('../money');
const { walletRole } = require('../roles');
const { logAudit } = require('../audit');
const { apBalance, billKey, lockBillAllocation } = require('./payables');
const {
  fail, currencyOf, getAccount, decimalsOf, toCurrencyMinor, RateBook, valueOut, moneyLine, addFxLine,
  nextDocNumber, findExisting, officeExists, resolveAccount, lockPostingAccounts, isBeforeCashCount,
} = require('./common');

const toId = (value) => new mongoose.Types.ObjectId(String(value));
const MONTH = /^\d{4}-\d{2}$/;

// Gross salary is the expense; a deducted advance reduces what the employee still holds;
// the rest is paid from the cash box (at its average rate if not in USD).
async function createSalary(input, { session, req }) {
  if (input.paymentKind === 'commission') return createCommission(input, { session, req });
  const existing = await findExisting(SalaryPayment, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  if (!MONTH.test(input.month || '')) throw fail('شهر الراتب غير صالح');
  if (!(await officeExists(input.office))) throw fail('اختر المكتب');
  const employees = require('../employees');
  const employee = await employees.lock(input.employeeId, session);
  if (!employee.isActive) throw fail('الموظف مؤرشف؛ أعده إلى القائمة أولًا');
  if (await require('../../models/FinancialOperation').Operation.exists({ kind: 'salary_accrual', employeeId: employee._id, month: input.month, status: 'posted' }).session(session))
    throw fail('يوجد استحقاق راتب لهذا الشهر؛ اصرفه من التسويات والمستحقات حتى لا يتكرر المصروف');
  const cash = await getAccount(input.paidFromAccountId, 'حساب الصرف');
  if (!cash.isCash) throw fail('اختر الخزينة التي صُرف منها الراتب');
  const currency = currencyOf(cash);
  if (input.currency && input.currency !== currency) throw fail(`الخزينة بعملة ${currency}`);

  const rates = new RateBook(session);
  let breakdown = null;
  if (input.structuredSalary) {
    if (employee.salaryCurrency !== currency) throw fail('اختر خزينة بعملة الراتب الأساسي');
    if (await SalaryPayment.exists({ employeeId: employee._id, month: input.month, currency, status: 'posted', paymentKind: { $ne: 'commission' } }).session(session)) throw fail('يوجد راتب مصروف لهذا الشهر؛ ألغِه قبل إعادة التسجيل');
    breakdown = await employees.preview(employee._id, input.month, currency, session, input.day, input.rate, rates);
    const base = await toCurrencyMinor(input.baseSalary, currency);
    input.baseSalary = base / 10 ** await decimalsOf(currency);
    const commission = await toCurrencyMinor(breakdown.commissionAmount, currency);
    const deduction = await toCurrencyMinor(breakdown.salaryDeduction, currency);
    if (deduction > base + commission) throw fail('الخصومات أكبر من الراتب والعمولات');
    input.grossAmount = (base + commission - deduction) / 10 ** await decimalsOf(currency);
  }
  const gross = await toCurrencyMinor(input.grossAmount, currency);
  const deduction = input.advanceDeduction ? await toCurrencyMinor(input.advanceDeduction, currency) : 0;
  if (!gross) throw fail('إجمالي الراتب مطلوب');
  if (deduction > gross) throw fail('الخصم أكبر من الراتب');

  const grossUsd = await rates.toUsd(gross, currency, input.day, input.rate);
  // A loan is taken back from the salary, from the loan in the salary's currency, at the rate it was
  // lent at; custody is settled by expenses (owner's requests 2026-10-04)
  const custody = require('../custody');
  const loans = deduction ? await custody.accountOf('loan', currency) : null;
  if (deduction && !loans) throw fail(`لا يوجد حساب سلف بعملة ${currency}: شغّل الإعداد`);
  if (deduction) {
    const held = await custody.heldMinor(loans, employee._id, session);
    if (deduction > held) throw fail(`الخصم أكبر من رصيد سلفة الموظف بعملة ${currency} (${held / 10 ** await decimalsOf(currency)})`);
  }
  const deductionUsd = deduction ? await valueOut(loans, deduction, { day: input.day, docRate: input.rate, rates, employeeId: employee._id }) : 0;
  const net = gross - deduction;
  if (input.structuredSalary && input.expectedNetAmount !== undefined && await toCurrencyMinor(input.expectedNetAmount, currency) !== net) throw fail('تغير صافي الراتب أو سعر تحويل العمولة؛ أعد مراجعة المعاينة قبل الصرف');
  if (net && !(await isBeforeCashCount(input.day))) {
    await lockPostingAccounts([cash], session);
  }

  const [doc] = await SalaryPayment.create([{
    employeeModel: employee.hasLogin ? 'User' : 'AccountingEmployee', employeeName: `${employee.firstName} ${employee.lastName || ''}`.trim(),
    structuredSalary: !!breakdown,
    paymentKind: 'salary',
    ...(breakdown && { baseSalary: Number(input.baseSalary), commissionAmount: breakdown.commissionAmount, salaryDeduction: breakdown.salaryDeduction, commissionConversions: breakdown.conversions, adjustments: breakdown.adjustments.map(r => r._id) }),
    employeeId: employee._id, month: input.month, day: input.day, office: input.office, currency, rate: input.rate,
    grossAmount: Number(input.grossAmount), advanceDeduction: Number(input.advanceDeduction || 0), paidFromAccountId: cash._id,
    note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('SAL', input.day, session),
  }], { session });
  if (breakdown?.adjustments.length) {
    const { Adjustment } = require('../../models/Employee');
    const claimed = await Adjustment.updateMany({ _id: { $in: doc.adjustments }, salaryId: null, isCanceled: false }, { $set: { salaryId: doc._id } }, { session });
    if (claimed.modifiedCount !== doc.adjustments.length) throw fail('تغيرت العمولات أو الخصومات؛ أعد تحميل بيان الموظف');
  }

  const salaries = await resolveAccount('salaries_expense');
  const name = doc.employeeName;
  const commissionUsd = breakdown ? await rates.toUsd(await toCurrencyMinor(breakdown.commissionAmount, currency), currency, input.day, input.rate) : 0;
  const baseNetUsd = grossUsd - commissionUsd;
  const lines = [];
  if (baseNetUsd) lines.push({ accountId: salaries._id, [baseNetUsd > 0 ? 'debit' : 'credit']: Math.abs(baseNetUsd), office: input.office, employeeId: employee._id, label: `راتب ${name} ${input.month}` });
  if (commissionUsd) {
    const settings = (await require('../config').getConfig()).settings;
    const commissions = settings?.accountRoles?.employee_commission_expense ? await resolveAccount('employee_commission_expense') : salaries;
    lines.push({ accountId: commissions._id, debit: commissionUsd, office: input.office, employeeId: employee._id, label: `عمولات ${name} ${input.month}` });
  }
  if (deduction) lines.push(moneyLine(loans, 'credit', deduction, deductionUsd, { employeeId: employee._id, label: 'خصم سلفة' }));
  if (net) lines.push(moneyLine(cash, 'credit', net, await valueOut(cash, net, { day: input.day, docRate: input.rate, rates }), { label: `صافي راتب ${name}` }));
  await addFxLine(lines, input.office);

  const entry = await postEntry({
    eventType: 'SALARY', eventKey: `SALARY:${doc._id}`, date: input.day,
    description: `راتب ${name} - ${input.month}`, source: { model: 'AccountingSalaryPayment', id: doc._id },
    fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  await logAudit({ req, action: 'salary.post', model: 'AccountingSalaryPayment', docId: doc._id, after: doc }, session);
  return doc;
}

// Installments consume commissions in their source currency and record the payment conversion.
async function createCommission(input, { session, req }) {
  const existing = await findExisting(SalaryPayment, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day) || !MONTH.test(input.month || '')) throw fail('اختر تاريخ الصرف وشهر الاستحقاق');
  if (!(await officeExists(input.office))) throw fail('اختر المكتب');
  const employees = require('../employees');
  const employee = await employees.lock(input.employeeId, session);
  if (!employee.isActive) throw fail('الموظف مؤرشف؛ أعده للقائمة أولًا');
  if (await require('../../models/FinancialOperation').Operation.exists({ kind: 'commission_accrual', employeeId: employee._id, month: input.month, status: 'posted' }).session(session))
    throw fail('يوجد استحقاق عمولة لهذا الشهر؛ اصرفه من التسويات والمستحقات حتى لا يتكرر المصروف');
  const cash = await getAccount(input.paidFromAccountId, 'حساب الصرف');
  const currency = currencyOf(cash);
  if (!cash.isCash || !['USD', 'LYD'].includes(currency)) throw fail('اختر خزينة دولار أو دينار لصرف العمولة');
  const rates = new RateBook(session);
  const preview = await employees.commissionPreview(employee._id, input.month, currency, session, input.day, input.rate, rates);
  if (input.expectedCommissionPreview && input.expectedCommissionPreview !== preview.fingerprint) throw fail('تغير رصيد العمولة أو سعر التحويل؛ أعد فتح الصرف لمراجعة المبلغ');
  const minor = await toCurrencyMinor(input.grossAmount, currency);
  if (!minor || minor > preview.availableMinor) throw fail(`المتاح لصرف العمولة ${preview.availableAmount} ${currency}`);
  if (Number(input.advanceDeduction || 0)) throw fail('خصم السلفة يكون من الراتب الأساسي، لا من صرف العمولة');
  const closeCommissions = input.closeCommissions === true;
  const commissionCloseReason = String(input.commissionCloseReason || '').trim();
  if (closeCommissions && (!commissionCloseReason || commissionCloseReason.length > 1000)) throw fail('اكتب سبب إقفال المتبقي من العمولة (حتى 1000 حرف)');
  const allocations = [];
  const conversions = [];
  const scale = 10 ** await decimalsOf(currency);
  let left = minor;
  for (const row of preview.adjustments) {
    if (!left) break;
    if (!row.paymentMinor) continue;
    const paymentMinor = Math.min(left, row.paymentMinor);
    if (!paymentMinor) break;
    const amountMinor = paymentMinor === row.paymentMinor ? row.remainingMinor : Math.round(row.remainingMinor * paymentMinor / row.paymentMinor);
    if (!amountMinor || (amountMinor === row.remainingMinor && paymentMinor < row.paymentMinor)) throw fail('قيمة الدفعة لا تقابل وحدة صحيحة من العمولة الأصلية؛ عدّل المبلغ أو اختر صرف المتاح بالكامل');
    allocations.push({ adjustmentId: row._id, amountMinor });
    conversions.push({ adjustmentId: row._id, amount: amountMinor / 10 ** row.sourceDecimals, currency: row.currency,
      sourceRate: row.sourceRate, targetRate: row.targetRate, salaryCurrency: currency, salaryAmount: paymentMinor / scale, day: input.day });
    left -= paymentMinor;
  }
  // Adjustments are unposted entitlements; closing the remainder records a waiver,
  // not an additional cash payment or expense. Canceling this payment restores it.
  if (closeCommissions) {
    for (const row of preview.adjustments) {
      let allocation = allocations.find(item => String(item.adjustmentId) === String(row._id));
      if (!allocation) { allocation = { adjustmentId: row._id, amountMinor: 0 }; allocations.push(allocation); }
      allocation.waivedMinor = row.remainingMinor - allocation.amountMinor;
    }
  }
  if (!(await isBeforeCashCount(input.day))) await lockPostingAccounts([cash], session);
  const usd = await rates.toUsd(minor, currency, input.day, input.rate);
  const amount = minor / 10 ** await decimalsOf(currency);
  const name = `${employee.firstName} ${employee.lastName || ''}`.trim();
  const [doc] = await SalaryPayment.create([{
    employeeModel: employee.hasLogin ? 'User' : 'AccountingEmployee', employeeName: name, employeeId: employee._id,
    paymentKind: 'commission', commissionAmount: amount, commissionAllocations: allocations, commissionConversions: conversions,
    closeCommissions, commissionCloseReason: closeCommissions ? commissionCloseReason : undefined,
    month: input.month, day: input.day, office: input.office, currency, rate: input.rate,
    grossAmount: amount, advanceDeduction: 0, paidFromAccountId: cash._id,
    note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('COM', input.day, session),
  }], { session });
  const { Adjustment } = require('../../models/Employee');
  for (const allocation of allocations) {
    const updated = await Adjustment.updateOne({ _id: allocation.adjustmentId, salaryId: null, isCanceled: false }, { $inc: { paidMinor: allocation.amountMinor, waivedMinor: allocation.waivedMinor || 0 } }, { session });
    if (updated.modifiedCount !== 1) throw fail('تغيرت العمولة؛ أعد مراجعة البيان');
  }
  const settings = (await require('../config').getConfig()).settings;
  const expense = await resolveAccount(settings?.accountRoles?.employee_commission_expense ? 'employee_commission_expense' : 'salaries_expense');
  const lines = [
    { accountId: expense._id, debit: usd, office: input.office, employeeId: employee._id, label: `عمولة ${name} ${input.month}` },
    moneyLine(cash, 'credit', minor, await valueOut(cash, minor, { day: input.day, docRate: input.rate, rates }), { label: `صرف عمولة ${name}` }),
  ];
  await addFxLine(lines, input.office);
  const entry = await postEntry({ eventType: 'SALARY', eventKey: `COMMISSION:${doc._id}`, date: input.day,
    description: `صرف عمولة ${name} - ${input.month}`, source: { model: 'AccountingSalaryPayment', id: doc._id }, fallbacks: rates.fallbacks, lines }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id; await doc.save({ session });
  await logAudit({ req, action: 'commission.post', model: 'AccountingSalaryPayment', docId: doc._id, after: doc }, session);
  return doc;
}

const EQUITY_TYPES = {
  capital_in: { role: 'capital', direction: 'in', label: 'إيداع رأس مال' },
  withdrawal: { role: 'partner_withdrawals', direction: 'out', label: 'مسحوبات شريك' },
  loan_in: { role: 'loans', direction: 'in', label: 'استلام قرض' },
  loan_repayment: { role: 'loans', direction: 'out', label: 'سداد قرض' },
};

async function createEquity(input, { session, req }) {
  const existing = await findExisting(EquityTransaction, input.idempotencyKey, session);
  if (existing) return existing;
  const type = EQUITY_TYPES[input.type];
  if (!type) throw fail('نوع العملية غير صالح');
  if (!String(input.partyName || '').trim()) throw fail('اسم الشريك أو الجهة مطلوب');
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const cash = await getAccount(input.accountId, 'الخزينة');
  if (!cash.isCash) throw fail('اختر الخزينة');
  const currency = currencyOf(cash);
  const minor = await toCurrencyMinor(input.amount, currency);
  if (!minor) throw fail('المبلغ مطلوب');

  if (type.direction === 'out' && !(await isBeforeCashCount(input.day))) {
    await lockPostingAccounts([cash], session);
  }

  const [doc] = await EquityTransaction.create([{
    type: input.type, partyName: input.partyName.trim(), day: input.day, accountId: cash._id, amount: Number(input.amount),
    rate: input.rate, note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('EQ', input.day, session),
  }], { session });

  const rates = new RateBook(session);
  const atRate = await rates.toUsd(minor, currency, input.day, input.rate);
  const loanRole = type.role === 'loans' ? input.loanRole || 'loans' : type.role;
  if (type.role === 'loans' && !['loans', 'long_term_loans', 'current_loan_portion'].includes(loanRole)) throw fail('اختر نوع القرض');
  const counter = await resolveAccount(loanRole);
  if (type.role === 'loans') { doc.loanRole = loanRole; }
  if (type.role === 'loans') {
    const { balance: outstanding } = await lockCompanyLoanBalance(session, counter._id);
    if (input.type === 'loan_repayment' && (outstanding.usd >= 0 || atRate > -outstanding.usd)) {
      throw fail('Loan repayment exceeds the outstanding loan balance');
    }
  }
  const label = `${type.label} - ${doc.partyName}`;
  const lines = type.direction === 'in'
    ? [moneyLine(cash, 'debit', minor, atRate, { label }), { accountId: counter._id, credit: atRate, label }]
    : [{ accountId: counter._id, debit: atRate, label }, moneyLine(cash, 'credit', minor, await valueOut(cash, minor, { day: input.day, docRate: input.rate, rates }), { label })];
  await addFxLine(lines, cash.office);

  const entry = await postEntry({
    eventType: 'EQUITY', eventKey: `EQUITY:${doc._id}`, date: input.day, description: `${label}${input.note ? ` - ${input.note}` : ''}`,
    source: { model: 'AccountingEquityTransaction', id: doc._id }, fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  await logAudit({ req, action: 'equity.post', model: 'AccountingEquityTransaction', docId: doc._id, after: doc }, session);
  return doc;
}

// Adds (or with a negative amount takes) money on a customer's wallet the same way the rest of
// the system does: wallet balance + a statement line carrying the running total. The statement is
// marked with its accounting source so it is never posted a second time as a deposit.
async function moveWallet({ userId, currency, amount, description, note, createdBy, source }, session) {
  await lockWalletOwner(userId, session);
  const wallet = await Wallet.findOneAndUpdate({ user: userId, currency }, { $inc: { balance: amount } }, { new: true, session });
  if (!wallet) await Wallet.create([{ user: userId, currency, balance: amount }], { session });
  else await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: Math.round(wallet.balance * 100) / 100 }, { session });
  const [last] = await UserStatement.find({ user: userId, currency }).sort({ _id: -1 }).limit(1).session(session);
  const [statement] = await UserStatement.create([{
    user: userId, createdBy, createdAt: new Date(), description, note,
    amount: Math.abs(amount), currency, total: Math.round(((last?.total || 0) + amount) * 100) / 100,
    paymentType: 'wallet', calculationType: amount >= 0 ? '+' : '-', actionType: 'wallet', accountingSource: source,
  }], { session });
  return statement;
}

// E30: a partner who is both customer and vendor. What we owe them either pays their shipping
// claim (payable_to_ar) or is added to their wallet (payable_to_wallet).
async function createNetting(input, { session, req }) {
  const existing = await findExisting(Netting, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const vendor = await Vendor.findById(input.vendorId).session(session);
  if (!vendor) throw fail('اختر المورد');
  const customer = input.customerId && mongoose.isValidObjectId(input.customerId) && await User.findById(input.customerId).select('firstName lastName').session(session);
  if (!customer) throw fail('اختر العميل');
  const bill = await SupplierBill.findById(input.billId).session(session);
  if (!bill || bill.status !== 'posted' || bill.isCreditNote || String(bill.vendorId) !== String(vendor._id)) throw fail('اختر فاتورة المورد');
  if (bill.yuanPurchaseId) {
    const links = require('../vendorCustomerLink');
    const linkedVendor = await links.lockVendor(vendor._id, session);
    await links.linkedCustomer(linkedVendor, customer._id, session);
    const purchase = await require('../../models/documents').YuanPurchase.findById(bill.yuanPurchaseId).select('customerId').session(session);
    if (purchase?.customerId && String(purchase.customerId) !== String(customer._id)) throw fail('العميل لا يطابق العميل المرتبط بشراء اليوان');
  }
  const amountUsd = Math.round(Number(input.amountUsd));
  if (!(amountUsd > 0)) throw fail('المبلغ مطلوب');
  // Serialize nettings with supplier payments and other nettings against this bill.
  await lockBillAllocation(bill, session);
  if (amountUsd > await apBalance(billKey(bill._id), session)) throw fail('المبلغ أكبر من المتبقي على الفاتورة');

  const [doc] = await Netting.create([{
    vendorId: vendor._id, customerId: customer._id, day: input.day, mode: input.mode, billId: bill._id, amountUsd,
    arKey: input.arKey, walletCurrency: input.walletCurrency, rate: input.rate, note: input.note,
    idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted', number: await nextDocNumber('NET', input.day, session),
  }], { session });

  const lines = [{ accountId: bill.payableAccountId, debit: amountUsd, vendorId: vendor._id, apKey: billKey(bill._id), label: `مقاصة ${doc.number}` }];
  const rates = new RateBook(session);
  if (input.mode === 'payable_to_ar') {
    if (!input.arKey) throw fail('اختر مطالبة العميل');
    // Serialize against nettings using this same claim, even when they use different vendor bills.
    await lockClaimAllocation(input.arKey, session);
    const receivable = await resolveAccount('customer_receivable');
    const [claim] = await JournalEntry.aggregate([
      { $match: { 'lines.arKey': input.arKey } },
      { $unwind: '$lines' },
      { $match: { 'lines.arKey': input.arKey, 'lines.partnerId': customer._id } },
      { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]).session(session);
    if ((claim?.usd || 0) < amountUsd) throw fail('المبلغ أكبر من المتبقي على مطالبة العميل');
    lines.push({ accountId: receivable._id, credit: amountUsd, partnerId: customer._id, arKey: input.arKey, label: `مقاصة مع مستحقات ${vendor.name}` });
  } else if (input.mode === 'payable_to_wallet') {
    const currency = input.walletCurrency;
    const wallet = await resolveAccount(walletRole(currency || ''));
    const decimals = await decimalsOf(currency);
    const rate = currency === 'USD' ? 1 : await rates.rate(currency, input.day, input.rate);
    const foreign = toMinor((amountUsd / 100) * rate, decimals);
    lines.push({ accountId: wallet._id, credit: amountUsd, currency, amountCurrency: -foreign, rate, partnerId: customer._id, label: `مقاصة ${doc.number}` });
    const yuanPurchase = bill.yuanPurchaseId && await require('../../models/documents').YuanPurchase.findById(bill.yuanPurchaseId).select('number').session(session);
    const statement = await moveWallet({
      userId: customer._id, currency, amount: Math.round(fromMinor(foreign, decimals) * 100) / 100,
      description: yuanPurchase ? `باقي مستحق شراء يوان ${yuanPurchase.number} (${vendor.name}) - ${doc.number}` : `مقاصة مع مستحقاتك كمورد (${vendor.name}) - ${doc.number}`, note: doc.number,
      createdBy: req?.user?._id, source: { model: 'AccountingNetting', id: doc._id },
    }, session);
    doc.userStatementId = statement._id;
    doc.rate = rate;
  } else {
    throw fail('اختر نوع المقاصة');
  }

  const entry = await postEntry({
    eventType: 'NETTING', eventKey: `NETTING:${doc._id}`, date: input.day,
    description: `مقاصة ${doc.number}: ${vendor.name} / ${customer.firstName} ${customer.lastName}`,
    source: { model: 'AccountingNetting', id: doc._id }, fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  await logAudit({ req, action: 'netting.post', model: 'AccountingNetting', docId: doc._id, after: doc }, session);
  return doc;
}

async function lockCompanyLoanBalance(session, accountId) {
  const account = accountId ? await getAccount(accountId) : await resolveAccount('loans');
  await require('../../models').Account.updateOne({ _id: account._id }, { $inc: { postingVersion: 1 } }, { session });
  const lockEntry = await JournalEntry.findOne({ 'lines.accountId': account._id }).sort({ _id: 1 }).select('_id').session(session).lean();
  if (lockEntry) await JournalEntry.updateOne({ _id: lockEntry._id }, { $inc: { loanAllocationVersion: 1 } }, { session });
  return { account, balance: await getBalance(account._id, { session }) };
}

module.exports = { createSalary, createEquity, createNetting, moveWallet, lockCompanyLoanBalance };
