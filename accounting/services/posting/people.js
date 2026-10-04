// Salaries (E28), capital / withdrawals / loans (E29), netting with a customer-vendor (E30)
const mongoose = require('mongoose');
const { SalaryPayment, EquityTransaction, Netting, Vendor, SupplierBill } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const Wallet = require('../../../models/wallet');
const UserStatement = require('../../../models/userStatement');
const User = require('../../../models/user');
const { postEntry } = require('../ledger');
const { isDay } = require('../dates');
const { toMinor, fromMinor } = require('../money');
const { walletRole } = require('../roles');
const { logAudit } = require('../audit');
const { apBalance, billKey } = require('./payables');
const {
  fail, currencyOf, getAccount, decimalsOf, toCurrencyMinor, RateBook, valueOut, moneyLine, addFxLine,
  nextDocNumber, findExisting, officeExists, resolveAccount,
} = require('./common');

const toId = (value) => new mongoose.Types.ObjectId(String(value));
const MONTH = /^\d{4}-\d{2}$/;

// What a staff member holds on one of their accounts (custody or loan), in USD cents
async function employeeAdvanceBalance(employeeId, session, role = 'employee_advances') {
  const advances = await resolveAccount(role);
  const [row] = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': advances._id, 'lines.employeeId': toId(employeeId) } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': advances._id, 'lines.employeeId': toId(employeeId) } },
    { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]).session(session || null);
  return row?.usd || 0;
}

// Gross salary is the expense; a deducted advance reduces what the employee still holds;
// the rest is paid from the cash box (at its average rate if not in USD).
async function createSalary(input, { session, req }) {
  const existing = await findExisting(SalaryPayment, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  if (!MONTH.test(input.month || '')) throw fail('شهر الراتب غير صالح');
  if (!(await officeExists(input.office))) throw fail('اختر المكتب');
  const employee = input.employeeId && mongoose.isValidObjectId(input.employeeId) && await User.findById(input.employeeId).select('firstName lastName').session(session);
  if (!employee) throw fail('اختر الموظف');
  const cash = await getAccount(input.paidFromAccountId, 'حساب الصرف');
  if (!cash.isCash) throw fail('اختر الخزينة التي صُرف منها الراتب');
  const currency = currencyOf(cash);
  if (input.currency && input.currency !== currency) throw fail(`الخزينة بعملة ${currency}`);

  const gross = await toCurrencyMinor(input.grossAmount, currency);
  const deduction = input.advanceDeduction ? await toCurrencyMinor(input.advanceDeduction, currency) : 0;
  if (!gross) throw fail('إجمالي الراتب مطلوب');
  if (deduction > gross) throw fail('الخصم أكبر من الراتب');

  const rates = new RateBook(session);
  const grossUsd = await rates.toUsd(gross, currency, input.day, input.rate);
  const deductionUsd = deduction ? await rates.toUsd(deduction, currency, input.day, input.rate) : 0;
  // A loan is taken back from the salary; custody is settled by expenses (owner's request 2026-10-04)
  if (deductionUsd > await employeeAdvanceBalance(employee._id, session, 'employee_loans')) throw fail('الخصم أكبر من رصيد سلفة الموظف');
  const net = gross - deduction;

  const [doc] = await SalaryPayment.create([{
    employeeId: employee._id, month: input.month, day: input.day, office: input.office, currency, rate: input.rate,
    grossAmount: Number(input.grossAmount), advanceDeduction: Number(input.advanceDeduction || 0), paidFromAccountId: cash._id,
    note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('SAL', input.day, session),
  }], { session });

  const [salaries, advances] = await Promise.all([resolveAccount('salaries_expense'), resolveAccount('employee_loans')]);
  const name = `${employee.firstName} ${employee.lastName}`;
  const lines = [{ accountId: salaries._id, debit: grossUsd, office: input.office, employeeId: employee._id, label: `راتب ${name} ${input.month}` }];
  if (deductionUsd) lines.push({ accountId: advances._id, credit: deductionUsd, employeeId: employee._id, label: 'خصم سلفة' });
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

  const [doc] = await EquityTransaction.create([{
    type: input.type, partyName: input.partyName.trim(), day: input.day, accountId: cash._id, amount: Number(input.amount),
    rate: input.rate, note: input.note, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('EQ', input.day, session),
  }], { session });

  const rates = new RateBook(session);
  const atRate = await rates.toUsd(minor, currency, input.day, input.rate);
  const counter = await resolveAccount(type.role);
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
  const amountUsd = Math.round(Number(input.amountUsd));
  if (!(amountUsd > 0)) throw fail('المبلغ مطلوب');
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
    const statement = await moveWallet({
      userId: customer._id, currency, amount: Math.round(fromMinor(foreign, decimals) * 100) / 100,
      description: `مقاصة مع مستحقاتك كمورد (${vendor.name}) - ${doc.number}`, note: doc.number,
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

module.exports = { createSalary, createEquity, createNetting, moveWallet, employeeAdvanceBalance };
