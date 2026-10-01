// The accounts money can come from or go to, as the operations screens show them: cash boxes,
// banks, e-wallets and partners' current accounts, by name only (staff never see account codes
// or debit/credit, spec 19.1). The screens send back the account id; it is checked here.
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');

const KIND_LABELS = { cash: 'خزينة', bank: 'بنك', ewallet: 'محفظة إلكترونية', current: 'حساب جارٍ' };

const view = (account) => ({
  _id: account._id,
  name: account.name,
  currency: account.currency || 'USD',
  office: account.office || null,
  kind: account.cashKind || 'cash',
  kindLabel: KIND_LABELS[account.cashKind] || KIND_LABELS.cash,
});

// { currency, office, kinds: ['cash', ...] } narrow the list
async function listMoneyAccounts({ currency, office, kinds } = {}) {
  const { accountsById } = await getConfig();
  return [...accountsById.values()]
    .filter((a) => a.isCash && !a.isGroup && a.isActive)
    .filter((a) => !currency || (a.currency || 'USD') === currency)
    .filter((a) => !office || a.office === office)
    .filter((a) => !kinds || kinds.includes(a.cashKind || 'cash'))
    .sort((x, y) => String(x.code).localeCompare(String(y.code)))
    .map(view);
}

async function moneyAccount(accountId, { currency, what = 'الحساب' } = {}) {
  const { accountsById } = await getConfig();
  const account = accountId && mongoose.isValidObjectId(String(accountId)) && accountsById.get(String(accountId));
  if (!account || !account.isCash || account.isGroup) throw new ErrorHandler(400, `${what}: اختر خزينة أو بنكاً أو حساباً جارياً`);
  if (!account.isActive) throw new ErrorHandler(400, `${what}: الحساب «${account.name}» مؤرشف`);
  if (currency && (account.currency || 'USD') !== currency) throw new ErrorHandler(400, `${what}: «${account.name}» بعملة ${account.currency || 'USD'} وليس ${currency}`);
  return account;
}

// Where a new debt's money came from (spec 19.8). A debt that reminds of an order's own claim
// needs nothing; any other debt names the cash box or partner account the money left.
async function debtSource({ accountId, currency, orderLinked }) {
  if (orderLinked) return { kind: 'order' };
  const account = await moneyAccount(accountId, { currency, what: 'مصدر الدين' });
  return { kind: account.cashKind === 'current' ? 'partner' : 'cash', accountId: account._id };
}

module.exports = { listMoneyAccounts, moneyAccount, debtSource, KIND_LABELS };
