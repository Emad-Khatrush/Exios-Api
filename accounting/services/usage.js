const { Account, JournalEntry, Journal, CurrencyRate, AccountingSettings } = require('../models');
const { getBalance } = require('./carrying');
const UserStatement = require('../../models/userStatement');
const Wallet = require('../../models/wallet');

const sameId = (a, b) => a && b && String(a) === String(b);

// Where a settings item is referenced. `items` lists every place (shown to the admin before any
// delete/archive); `blocking` is what prevents deleting it.
async function accountUsage(account) {
  const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
  const items = [];

  const entries = await JournalEntry.countDocuments({ 'lines.accountId': account._id });
  if (entries) items.push({ kind: 'entries', count: entries, label: `${entries} قيداً` });

  const roles = Object.entries(settings?.accountRoles || {}).filter(([, id]) => sameId(id, account._id)).map(([role]) => role);
  if (roles.length) items.push({ kind: 'roles', roles, label: `دور: ${roles.join('، ')}` });

  const cashMappings = [];
  Object.entries(settings?.officeAccounts || {}).forEach(([office, map]) => {
    Object.entries(map || {}).forEach(([currency, id]) => {
      if (sameId(id, account._id)) cashMappings.push(`${office}/${currency}`);
    });
  });
  if (cashMappings.length) items.push({ kind: 'officeAccounts', mappings: cashMappings, label: `خزينة المكتب: ${cashMappings.join('، ')}` });

  const journals = await Journal.find({ defaultAccountId: account._id }).select('code isActive').lean();
  if (journals.length) items.push({ kind: 'journals', journals: journals.map((j) => j.code), label: `دفتر: ${journals.map((j) => j.code).join('، ')}` });

  const children = await Account.find({ parentId: account._id }).select('isActive').lean();
  if (children.length) items.push({ kind: 'children', count: children.length, active: children.filter((c) => c.isActive).length, label: `${children.length} حساباً فرعياً` });

  const balance = account.isGroup ? { usd: 0, foreign: 0 } : await getBalance(account._id);
  return { items, balance, roles, cashMappings, journals, children, entries };
}

// A cash account's own journal can only have entries if the account has them too, so an empty
// journal never blocks: it is deleted together with the account.
async function canDeleteAccount(account) {
  const usage = await accountUsage(account);
  const reasons = usage.items.filter((item) => item.kind !== 'journals').map((item) => item.label);
  return { allowed: reasons.length === 0, reasons, usage };
}

async function canArchiveAccount(account) {
  const usage = await accountUsage(account);
  const reasons = [];
  if (usage.balance.usd !== 0 || usage.balance.foreign !== 0) reasons.push('رصيد الحساب ليس صفراً؛ حوّل الرصيد أولاً');
  if (usage.roles.length) reasons.push(`مربوط بدور (${usage.roles.join('، ')})؛ انقل الدور لحساب آخر أولاً`);
  if (usage.cashMappings.length) reasons.push(`مربوط كخزينة مكتب (${usage.cashMappings.join('، ')})؛ غيّر الربط أولاً`);
  if (usage.children.some((child) => child.isActive)) reasons.push('فيه حسابات فرعية نشطة؛ أرشفها أولاً');
  return { allowed: reasons.length === 0, reasons, usage };
}

async function currencyUsage(code) {
  const [accounts, entries, rates, wallets, statements] = await Promise.all([
    Account.countDocuments({ currency: code }),
    JournalEntry.countDocuments({ 'lines.currency': code }),
    CurrencyRate.countDocuments({ currency: code }),
    Wallet.countDocuments({ currency: code }),
    UserStatement.countDocuments({ currency: code }),
  ]);
  const activeAccounts = await Account.countDocuments({ currency: code, isActive: true });
  const walletsWithBalance = await Wallet.countDocuments({ currency: code, balance: { $ne: 0 } });
  return { accounts, activeAccounts, entries, rates, wallets, walletsWithBalance, statements };
}

async function officeUsage(code, aliases = {}) {
  const values = [code, ...Object.entries(aliases).filter(([, office]) => office === code).map(([alias]) => alias)];
  const [accounts, activeAccounts, entries, statements, journals] = await Promise.all([
    Account.find({ office: code }).select('_id isActive').lean(),
    Account.countDocuments({ office: code, isActive: true }),
    JournalEntry.countDocuments({ 'lines.office': code }),
    UserStatement.countDocuments({ office: { $in: values } }),
    Journal.countDocuments({ office: code }),
  ]);
  return { accounts: accounts.length, activeAccounts, accountIds: accounts.map((a) => a._id), entries, statements, journals };
}

async function journalUsage(journal) {
  const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
  const entries = await JournalEntry.countDocuments({ journalId: journal._id });
  const events = Object.entries(settings?.eventJournals || {}).filter(([, code]) => code === journal.code).map(([event]) => event);
  return { entries, events };
}

module.exports = { accountUsage, canDeleteAccount, canArchiveAccount, currencyUsage, officeUsage, journalUsage };
