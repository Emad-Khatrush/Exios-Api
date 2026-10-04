// Staff custody and loans (owner's request 2026-10-04). Custody (عهدة) is money given to a staff
// member to spend for the company: it is settled by the expenses they pay from it and by what they
// give back. A loan (سلفة) is money lent to them, taken back from their salary or returned.
// Each is kept per employee in its own currency, on its own account (custody 140100 USD / 140110
// LYD, loans 140300 USD / 140310 LYD): what is given in dinars is settled in dinars, at the rate it
// was given at, so closing it leaves no exchange difference (owner's request 2026-10-04).
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const User = require('../../models/user');
const { JournalEntry } = require('../models');
const { resolveAccount } = require('./roles');
const { isOwner } = require('./access');
const { getBalance } = require('./carrying');
const { currencyOf, isForeign, decimalsOf } = require('./posting/common');
const { getConfig } = require('./config');

const CURRENCIES = ['USD', 'LYD'];
const ROLES = {
  custody: { USD: 'employee_advances', LYD: 'employee_advances_lyd' },
  loan: { USD: 'employee_loans', LYD: 'employee_loans_lyd' },
};
const toId = (value) => new mongoose.Types.ObjectId(String(value));
const zero = () => ({ USD: 0, LYD: 0 });

async function accountOf(kind, currency = 'USD') {
  if (!ROLES[kind]) throw new ErrorHandler(400, 'نوع غير معروف');
  const role = ROLES[kind][currency];
  return role ? resolveAccount(role).catch(() => null) : null;
}

// [{ currency, account }] of custody or loans, for the currencies set up
async function accountsOf(kind) {
  const found = await Promise.all(CURRENCIES.map(async (currency) => ({ currency, account: await accountOf(kind, currency) })));
  return found.filter((row) => row.account);
}

// { kind, currency, account } when the account is a custody or loan account, else null
async function staffAccountKind(accountId) {
  for (const kind of Object.keys(ROLES)) {
    for (const { currency, account } of await accountsOf(kind)) {
      if (String(account._id) === String(accountId)) return { kind, currency, account };
    }
  }
  return null;
}

// What one employee holds on one custody or loan account, in its currency's minor units
async function heldMinor(account, employeeId, session) {
  const balance = await getBalance(account._id, { employeeId, session });
  return isForeign(account) ? balance.foreign : balance.usd;
}

const lineAmount = (line, account) => (isForeign(account) ? line.amountCurrency || 0 : (line.debit || 0) - (line.credit || 0));

// { employeeId: { USD, LYD } } held on custody or loans, in units of each currency
async function balances(kind) {
  const result = new Map();
  for (const { currency, account } of await accountsOf(kind)) {
    const decimals = await decimalsOf(currencyOf(account));
    const rows = await JournalEntry.aggregate([
      { $match: { 'lines.accountId': account._id } }, { $unwind: '$lines' },
      { $match: { 'lines.accountId': account._id } },
      {
        $group: {
          _id: '$lines.employeeId',
          usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
          foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } },
        },
      },
    ]);
    rows.forEach((row) => {
      const key = String(row._id);
      if (!result.has(key)) result.set(key, zero());
      result.get(key)[currency] = (isForeign(account) ? row.foreign : row.usd) / 10 ** decimals;
    });
  }
  return result;
}

// What happened on one employee's custody or loan, newest first: given, spent on an expense,
// returned, taken from a salary, or a cancelled operation undone. Amounts in each line's currency.
const KIND_OF = {
  TRANSFER: (debit) => (debit ? 'given' : 'returned'),
  BILL: () => 'spent', VENDOR_PAYMENT: () => 'spent', SALARY: () => 'deducted',
  CANCEL: () => 'canceled', REVERSAL: () => 'canceled',
};
// The box or bank the money came from or went to, in its own currency (500 LYD from the dinar box)
async function cashSide(entry, account, accountsById) {
  const line = entry.lines.find((l) => String(l.accountId) !== String(account._id) && accountsById.get(String(l.accountId))?.isCash);
  if (!line) return null;
  const currency = line.currency || 'USD';
  const minor = line.currency ? Math.abs(line.amountCurrency || 0) : Math.abs((line.debit || 0) - (line.credit || 0));
  return { currency, amount: minor / 10 ** await decimalsOf(currency), name: accountsById.get(String(line.accountId)).name };
}

async function movements(employeeId, kind, { limit = 200 } = {}) {
  if (!mongoose.isValidObjectId(employeeId)) throw new ErrorHandler(404, 'الموظف غير موجود');
  const max = Math.min(Number(limit) || 200, 1000);
  const balance = zero();
  const given = zero();
  const used = zero();
  const rows = [];
  for (const { currency, account } of await accountsOf(kind)) {
    const decimals = await decimalsOf(currencyOf(account));
    const match = { 'lines.accountId': account._id, 'lines.employeeId': toId(employeeId) };
    const entries = await JournalEntry.find(match).select('number day eventType description lines createdAt status').sort({ day: -1, createdAt: -1 }).limit(max).lean();
    const { accountsById } = await getConfig();
    for (const entry of entries) {
      const mine = entry.lines.filter((l) => String(l.accountId) === String(account._id) && String(l.employeeId) === String(employeeId));
      const amount = mine.reduce((sum, l) => sum + lineAmount(l, account), 0) / 10 ** decimals;
      rows.push({
        entryId: entry._id, number: entry.number, day: entry.day, createdAt: entry.createdAt, currency, amount,
        usd: mine.reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0), description: entry.description,
        kind: (KIND_OF[entry.eventType] || (() => (amount > 0 ? 'given' : 'other')))(amount > 0), canceled: entry.status === 'reversed',
        cash: await cashSide(entry, account, accountsById),
      });
    }
    const [all] = await JournalEntry.aggregate([
      { $match: match }, { $unwind: '$lines' }, { $match: match },
      {
        $group: {
          _id: null,
          debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' },
          inForeign: { $sum: { $cond: [{ $gt: ['$lines.amountCurrency', 0] }, '$lines.amountCurrency', 0] } },
          outForeign: { $sum: { $cond: [{ $lt: ['$lines.amountCurrency', 0] }, '$lines.amountCurrency', 0] } },
        },
      },
    ]);
    const into = isForeign(account) ? all?.inForeign || 0 : all?.debit || 0;
    const out = isForeign(account) ? -(all?.outForeign || 0) : all?.credit || 0;
    given[currency] = into / 10 ** decimals;
    used[currency] = out / 10 ** decimals;
    balance[currency] = (into - out) / 10 ** decimals;
  }
  rows.sort((a, b) => (a.day === b.day ? new Date(b.createdAt) - new Date(a.createdAt) : a.day < b.day ? 1 : -1));
  const shown = rows.slice(0, max);
  await addDetails(shown);
  return { balance, given, used, movements: shown };
}

// What each movement was for, for the custody papers: the expense paid (its bill's lines, number
// and receipts) or the note typed on the transfer that gave or took the money back
async function addDetails(rows) {
  const { SupplierPayment, SupplierBill, TreasuryTransfer } = require('../models/documents');
  const entries = await JournalEntry.find({ _id: { $in: rows.map((r) => r.entryId) } }).select('source').lean();
  const sourceOf = new Map(entries.map((e) => [String(e._id), e.source || {}]));
  for (const row of rows) {
    const source = sourceOf.get(String(row.entryId)) || {};
    if (source.model === 'AccountingSupplierPayment') {
      const payment = await SupplierPayment.findById(source.id).select('allocations note').lean();
      const bills = await SupplierBill.find({ _id: { $in: (payment?.allocations || []).map((a) => a.billId) } }).select('number lines.description note attachments').lean();
      row.detail = bills.map((b) => b.lines.map((l) => l.description).join('، ')).join(' / ') || payment?.note || '';
      row.reference = bills.map((b) => b.number).join('، ');
      row.receipts = bills.reduce((sum, b) => sum + (b.attachments || []).length, 0);
    } else if (source.model === 'AccountingTreasuryTransfer') {
      const transfer = await TreasuryTransfer.findById(source.id).select('number note').lean();
      row.detail = transfer?.note || '';
      row.reference = transfer?.number;
    }
  }
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
  const any = (value) => CURRENCIES.some((c) => Math.abs(value[c]) > 0.0001);
  const results = users.map((u) => ({
    _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim(), custody: custody.get(String(u._id)) || zero(), loan: loans.get(String(u._id)) || zero(),
  })).filter((row) => any(row.custody) || any(row.loan)).sort((a, b) => b.custody.USD - a.custody.USD || b.custody.LYD - a.custody.LYD);
  const totals = { custody: zero(), loan: zero() };
  results.forEach((row) => CURRENCIES.forEach((c) => { totals.custody[c] += row.custody[c]; totals.loan[c] += row.loan[c]; }));
  return { results, totals };
}

module.exports = { CURRENCIES, balances, movements, mine, summary, accountOf, accountsOf, staffAccountKind, heldMinor };
