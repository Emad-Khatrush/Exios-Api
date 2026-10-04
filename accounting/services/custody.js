// Staff custody and loans (owner's request 2026-10-04). Custody (عهدة) is money given to a staff
// member to spend for the company: it is settled by the expenses they pay from it and by what they
// give back. A loan (سلفة) is money lent to them, taken back from their salary or returned. Both
// are kept in USD per employee, on their own accounts (140100 and 140300).
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const User = require('../../models/user');
const { JournalEntry } = require('../models');
const { resolveAccount } = require('./roles');
const { isOwner } = require('./access');

const KINDS = { custody: 'employee_advances', loan: 'employee_loans' };
const toId = (value) => new mongoose.Types.ObjectId(String(value));

async function accountOf(kind) {
  const role = KINDS[kind];
  if (!role) throw new ErrorHandler(400, 'نوع غير معروف');
  return resolveAccount(role).catch(() => null);
}

// { employeeId: USD cents } on custody or loans
async function balances(kind) {
  const account = await accountOf(kind);
  if (!account) return new Map();
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': account._id } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': account._id } },
    { $group: { _id: '$lines.employeeId', usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.usd]));
}

// What happened on one employee's custody or loan, newest first: given, spent on an expense,
// returned, taken from a salary, or a cancelled operation undone
const KIND_OF = {
  TRANSFER: (debit) => (debit ? 'given' : 'returned'),
  BILL: () => 'spent', VENDOR_PAYMENT: () => 'spent', SALARY: () => 'deducted',
  CANCEL: () => 'canceled', REVERSAL: () => 'canceled',
};
async function movements(employeeId, kind, { limit = 200 } = {}) {
  if (!mongoose.isValidObjectId(employeeId)) throw new ErrorHandler(404, 'الموظف غير موجود');
  const account = await accountOf(kind);
  if (!account) return { balance: 0, given: 0, used: 0, movements: [] };
  const match = { 'lines.accountId': account._id, 'lines.employeeId': toId(employeeId) };
  const entries = await JournalEntry.find(match).select('number day eventType description lines createdAt status reversalOf').sort({ day: -1, createdAt: -1 }).limit(Math.min(Number(limit) || 200, 1000)).lean();
  const rows = entries.map((entry) => {
    const usd = entry.lines.filter((l) => String(l.accountId) === String(account._id) && String(l.employeeId) === String(employeeId))
      .reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0);
    return {
      entryId: entry._id, number: entry.number, day: entry.day, usd, description: entry.description,
      kind: (KIND_OF[entry.eventType] || (() => (usd > 0 ? 'given' : 'other')))(usd > 0), canceled: entry.status === 'reversed',
    };
  });
  const [all] = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' }, { $match: match },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return { balance: (all?.debit || 0) - (all?.credit || 0), given: all?.debit || 0, used: all?.credit || 0, movements: rows };
}

// A staff member's own custody and loan, for their Home page
async function mine(user) {
  const [custody, loan] = await Promise.all([movements(user._id, 'custody', { limit: 30 }), movements(user._id, 'loan', { limit: 30 })]);
  return { custody, loan };
}

// Every staff member holding custody or a loan: the accountant's and admin's overview
async function summary(user) {
  if (!(user?.roles?.isAdmin || user?.roles?.isAccountant || await isOwner(user))) throw new ErrorHandler(403, 'للمدير أو المحاسب فقط');
  const [custody, loans] = await Promise.all([balances('custody'), balances('loan')]);
  const ids = [...new Set([...custody.keys(), ...loans.keys()])].filter((id) => mongoose.isValidObjectId(id));
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName customerId').lean();
  const results = users.map((u) => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim(), custody: custody.get(String(u._id)) || 0, loan: loans.get(String(u._id)) || 0 }))
    .filter((row) => row.custody || row.loan).sort((a, b) => b.custody - a.custody);
  return { results, totals: { custody: results.reduce((s, r) => s + r.custody, 0), loan: results.reduce((s, r) => s + r.loan, 0) } };
}

module.exports = { balances, movements, mine, summary, accountOf };
