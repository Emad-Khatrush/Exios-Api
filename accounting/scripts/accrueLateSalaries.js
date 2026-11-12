// node accounting/scripts/accrueLateSalaries.js [--number SAL/2026/0007] [--apply]
//
// Salaries of a past month paid later (October's salary paid on 8 November) recorded before the fix
// in posting/people.js: their whole expense sits on the payment day. The owner (2026-11-12) wants
// the expense in its month without cancelling the salary, because its payment is matched to a
// statement line.
//
// For each one, two entries are added under the salary itself; nothing existing is touched:
//   last day of the salary's month: Dr the salary's expense lines / Cr salaries payable
//   the payment day:                Dr salaries payable / Cr the same expense lines
// The payment entry, its cash line and its bank match stay as they are. The month gets the expense,
// the payment month nets to zero, and salaries payable is zero after the payment day. Cancelling the
// salary later reverses all three entries together (they share its source).
// A closed month is refused, never moved. Without --apply it only lists.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
if (process.env.NODE_ENV !== 'production') require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SalaryPayment } = require('../models/documents');
const { postEntry } = require('../services/ledger');
const { runInTransaction } = require('../services/transaction');
const { resolveAccount } = require('../services/roles');
const { getConfig } = require('../services/config');
const { logAudit } = require('../services/audit');
const { toCurrencyMinor, moneyLine } = require('../services/posting/common');

const usd = (cents) => (cents / 100).toFixed(2);
const monthEndOf = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

// A salary and a commission paid on its own differ only in their keys, payable and words
const kindOf = (salary) => salary.paymentKind === 'commission'
  ? { paid: 'COMMISSION', accrual: 'COMMISSION_ACCRUAL', payable: 'commission_payable', word: 'عمولة' }
  : { paid: 'SALARY', accrual: 'SALARY_ACCRUAL', payable: 'salary_payable', word: 'راتب' };

// What would be posted for one salary or commission, or why it is skipped
async function plan(salary, session) {
  const k = kindOf(salary);
  if (!(salary.month < salary.day.slice(0, 7))) return { skip: `${k.word} صُرف في شهره` };
  if (await JournalEntry.exists({ eventKey: `${k.accrual}:${salary._id}` }).session(session)) return { skip: 'مستحق مسبقًا' };
  const entry = await JournalEntry.findOne({ eventKey: `${k.paid}:${salary._id}`, status: 'posted' }).session(session);
  if (!entry) return { skip: 'قيد الصرف غير موجود أو مُلغى' };
  const { settings } = await getConfig();
  const expenseIds = new Set([String((await resolveAccount('salaries_expense'))._id)]);
  if (settings?.accountRoles?.employee_commission_expense) expenseIds.add(String((await resolveAccount('employee_commission_expense'))._id));
  const expenses = entry.lines.filter(l => expenseIds.has(String(l.accountId)) && (l.debit || l.credit));
  const expenseUsd = expenses.reduce((s, l) => s + l.debit - l.credit, 0);
  if (!expenses.length || expenseUsd <= 0) return { skip: `لا مصروف ${k.word} في قيد الصرف` };
  const payable = await resolveAccount(`${k.payable}_${salary.currency.toLowerCase()}`);
  const grossMinor = await toCurrencyMinor(salary.grossAmount, salary.currency);
  const dims = { office: expenses[0].office || salary.office, employeeId: salary.employeeId };
  const copy = (l, flip) => ({ accountId: l.accountId, debit: flip ? l.credit : l.debit, credit: flip ? l.debit : l.credit,
    ...(l.office && { office: l.office }), ...(l.employeeId && { employeeId: l.employeeId }), label: l.label });
  return {
    k, entry, expenseUsd, monthEnd: monthEndOf(salary.month),
    accrual: [...expenses.map(l => copy(l, false)), moneyLine(payable, 'credit', grossMinor, expenseUsd, { ...dims, label: `${k.word} مستحق ${salary.employeeName} ${salary.month}` })],
    settle: [moneyLine(payable, 'debit', grossMinor, expenseUsd, { ...dims, label: `سداد ${k.word} مستحق ${salary.employeeName} ${salary.month}` }), ...expenses.map(l => copy(l, true))],
  };
}

async function accrue(salaryId, { session, user }) {
  const salary = await SalaryPayment.findOne({ _id: salaryId, status: 'posted' }).session(session);
  if (!salary) throw new Error('الراتب غير موجود أو مُلغى');
  const p = await plan(salary, session);
  if (p.skip) throw new Error(p.skip);
  const source = { model: 'AccountingSalaryPayment', id: salary._id };
  // 'reject': a closed month fails instead of sliding into the payment month
  const accrual = await postEntry({ eventType: 'SALARY_ACCRUAL', eventKey: `${p.k.accrual}:${salary._id}`, date: p.monthEnd,
    description: `استحقاق ${p.k.word} ${salary.employeeName} - ${salary.month} (تصحيح: صُرف ${salary.day})`, source, lines: p.accrual }, { session, user, onLocked: 'reject' });
  const settle = await postEntry({ eventType: 'SALARY_ACCRUAL', eventKey: `${p.k.accrual}_SETTLE:${salary._id}`, date: p.entry.day,
    description: `سداد ${p.k.word} مستحق ${salary.employeeName} - ${salary.month} بقيد الصرف ${p.entry.number}`, source, lines: p.settle }, { session, user, onLocked: 'reject' });
  await logAudit({ req: user && { user }, action: 'salary.lateAccrual', model: 'AccountingSalaryPayment', docId: salary._id,
    after: { accrualEntryId: accrual._id, settleEntryId: settle._id, paymentEntryId: p.entry._id, amountUsd: p.expenseUsd } }, session);
  return { accrual, settle, amountUsd: p.expenseUsd };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const at = process.argv.indexOf('--number');
  const number = at > 0 ? process.argv[at + 1] : null;
  await mongoose.connect(process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL);
  console.log(`Database: ${mongoose.connection.db.databaseName}${apply ? '' : '  (dry run: add --apply to correct)'}`);
  const salaries = await SalaryPayment.find({ status: 'posted', ...(number && { number }) }).sort({ day: 1 });
  let done = 0, total = 0;
  for (const salary of salaries) {
    const p = await plan(salary, null);
    if (p.skip) { if (number) console.log(`skip ${salary.number}: ${p.skip}`); continue; }
    console.log(`${apply ? 'correct' : 'would correct'}  ${salary.number}  ${salary.employeeName}  month ${salary.month}  paid ${salary.day} (${p.entry.number})  $${usd(p.expenseUsd)}  → expense on ${p.monthEnd}, payable settled on ${p.entry.day}`);
    total += p.expenseUsd;
    if (!apply) continue;
    const r = await runInTransaction(session => accrue(salary._id, { session }));
    console.log(`   posted ${r.accrual.number} (${r.accrual.day}) and ${r.settle.number} (${r.settle.day})`);
    done++;
  }
  console.log(`\n${apply ? `Corrected ${done}` : 'Would correct'}: $${usd(total)}`);
}

if (require.main === module) main().then(() => mongoose.disconnect()).catch(e => { console.error(e.message); return mongoose.disconnect().then(() => process.exit(1)); });
module.exports = { plan, accrue };
