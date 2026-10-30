const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');
const { ROLE_DEFAULTS } = require('../seed/defaults');

// Wallet roles follow the currency: wallet_usd, wallet_lyd, wallet_eur ...
const walletRole = (currency) => `wallet_${String(currency).toLowerCase()}`;

function allowedTypesFor(role) {
  if (ROLE_DEFAULTS[role]) return ROLE_DEFAULTS[role][1];
  if (role.startsWith('wallet_')) return ['liability'];
  if (role.startsWith('revenue_')) return ['income'];
  if (role.startsWith('cost_')) return ['expense'];
  return null;
}

// Why an account cannot hold a role, or null if it can
function roleProblem(role, account) {
  if (!account) return 'الحساب غير موجود';
  if (account.isGroup) return 'لا يمكن ربط دور بحساب مجموعة';
  if (!account.isActive) return 'الحساب مؤرشف';
  const allowed = allowedTypesFor(role);
  if (allowed && !allowed.includes(account.type)) return `نوع الحساب (${account.type}) لا يناسب هذا الدور`;
  if (role.startsWith('wallet_')) {
    const currency = role.slice('wallet_'.length).toUpperCase();
    if (account.currency !== currency) return `حساب المحفظة يجب أن يكون بعملة ${currency}`;
  }
  return null;
}

async function resolveAccount(role) {
  const { settings, accountsById } = await getConfig();
  const accountId = settings?.accountRoles?.[role];
  const account = accountId && accountsById.get(String(accountId));
  const problem = roleProblem(role, account);
  if (problem) {
    throw new ErrorHandler(400, `الدور "${role}" غير مربوط بحساب صالح: ${problem}`);
  }
  return account;
}

// The cash/bank account of an office for a currency, or null if none is set
async function resolveCashAccount(office, currency) {
  const { settings, accountsById } = await getConfig();
  const accountId = settings?.officeAccounts?.[office]?.[currency];
  const account = accountId && accountsById.get(String(accountId));
  return account && account.isActive ? account : null;
}

// The sub cash box of an office for a currency (spec v8), or null
async function resolveSubCashAccount(office, currency) {
  const { settings, accountsById } = await getConfig();
  const accountId = settings?.subOfficeAccounts?.[office]?.[currency];
  const account = accountId && accountsById.get(String(accountId));
  return account && account.isActive ? account : null;
}

// Where a cash operation made from the system's screens lands: the sub box of the office when it
// has one (after go-live), else the office's box. The historical replay always uses the main box.
async function resolveStaffCashAccount(office, currency, { historical } = {}) {
  if (!office) return null;
  if (!historical) {
    const sub = await resolveSubCashAccount(office, currency);
    if (sub) return sub;
  }
  return resolveCashAccount(office, currency);
}

module.exports = { walletRole, allowedTypesFor, roleProblem, resolveAccount, resolveCashAccount, resolveSubCashAccount, resolveStaffCashAccount };
