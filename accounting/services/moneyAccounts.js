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

// Where a cash or bank deposit in `currency` can go (owner's request 2026-10-03): the offices and
// the banks of the deposit screen that have an active box in that currency, so a dinar deposit is
// never put in an office that only keeps dollars (it would wait for a box that does not exist)
async function depositPlaces(currency) {
  const { settings, accountsById, offices } = await getConfig();
  const { STATEMENT_OFFICE_ALIASES } = require('../seed/defaults');
  const places = [];
  Object.entries(settings?.officeAccounts || {}).forEach(([place, byCurrency]) => {
    const account = accountsById.get(String(byCurrency?.[currency] || ''));
    if (!account?.isActive) return;
    const office = offices.get(place);
    if (office) {
      if (office.isActive !== false) places.push({ value: place, label: `مكتب ${office.name}`, kind: 'office' });
    } else if (STATEMENT_OFFICE_ALIASES[place]) {
      places.push({ value: place, label: account.name, kind: 'bank' });
    }
  });
  return places;
}

// A deposit of real money names a place with a box in its currency (once accounting is set up)
async function assertDepositPlace(place, currency, actionType) {
  if (!place || !['cash', 'bank', undefined, null, ''].includes(actionType)) return;
  const { settings } = await getConfig();
  if (!Object.keys(settings?.officeAccounts || {}).length) return;
  const places = await depositPlaces(currency);
  if (!places.some((p) => p.value === place)) {
    throw new ErrorHandler(400, `لا توجد خزينة ${currency} في «${place}». اختر من: ${places.map((p) => p.label).join('، ') || '—'}`);
  }
}

module.exports = { listMoneyAccounts, moneyAccount, debtSource, depositPlaces, assertDepositPlace, KIND_LABELS };
