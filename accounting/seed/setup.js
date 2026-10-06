const {
  Account, Journal, AccountingOffice, Currency, AccountingSettings,
} = require('../models');
const { Vendor, ExpenseType, BankRule } = require('../models/documents');
const UserStatement = require('../../models/userStatement');
const defaults = require('./defaults');
const { invalidateConfig } = require('../services/config');

const CASH_JOURNAL_TYPES = { cash: 'cash', bank: 'bank', ewallet: 'ewallet', current: 'bank' };
const JOURNAL_KIND_PREFIX = { cash: 'CASH', bank: 'BANK', ewallet: 'EWAL', current: 'CUR' };

const officeShort = (code) => defaults.OFFICES.find((office) => office.code === code)?.short
  || String(code || 'GEN').slice(0, 3).toUpperCase();

// Next free 6-digit code under a group (1101 -> 110109 after 110108)
async function nextChildCode(groupCode) {
  const siblings = await Account.find({ code: new RegExp(`^${groupCode}\\d{2}$`) }).select('code').lean();
  const max = siblings.reduce((top, { code }) => Math.max(top, Number(code.slice(groupCode.length))), 0);
  return `${groupCode}${String(max + 1).padStart(2, '0')}`;
}

// Creates whatever is missing and never changes or deletes anything that already exists,
// so it is safe to run any number of times, also after the admin edited the defaults.
async function runSetup({ user } = {}) {
  const report = { created: [], existing: 0 };
  const created = (what) => report.created.push(what);

  for (const currency of defaults.CURRENCIES) {
    if (await Currency.exists({ code: currency.code })) report.existing++;
    else { await Currency.create(currency); created(`currency ${currency.code}`); }
  }

  for (const { short, ...office } of defaults.OFFICES) {
    if (await AccountingOffice.exists({ code: office.code })) report.existing++;
    else { await AccountingOffice.create(office); created(`office ${office.code}`); }
  }

  // seedKey (the default code) finds an account even if its code was changed since
  const bySeedKey = new Map();
  for (const { parent, ...account } of defaults.ACCOUNTS) {
    let doc = await Account.findOne({ seedKey: account.code });
    if (!doc) {
      doc = await Account.findOne({ code: account.code });
      if (doc && !doc.seedKey) { doc.seedKey = account.code; await doc.save(); }
    }
    if (doc) {
      report.existing++;
    } else {
      const parentDoc = parent ? bySeedKey.get(parent) : null;
      doc = await Account.create({
        ...account,
        parentId: parentDoc?._id || null,
        seedKey: account.code,
        sortOrder: defaults.ACCOUNTS.findIndex((item) => item.code === account.code),
      });
      created(`account ${account.code} ${account.name}`);
    }
    bySeedKey.set(account.code, doc);
  }

  // A cash box for every office/currency pair that already appears in customer deposits
  const pairs = await UserStatement.aggregate([
    { $match: { office: { $nin: [null, ''] } } },
    { $group: { _id: { office: '$office', currency: '$currency' } } },
  ]);
  for (const { _id: { office: statementOffice, currency } } of pairs) {
    const alias = defaults.STATEMENT_OFFICE_ALIASES[statementOffice];
    const office = alias ? alias.office : statementOffice;
    const seedKey = `cash:${statementOffice}:${currency}`;
    if (await Account.exists({ seedKey })) { report.existing++; continue; }

    const isDefault = alias
      ? statementOffice === 'almutahidaTrBank' && currency === 'USD' // the default bank account 110201
      : await Account.exists({ isCash: true, cashKind: 'cash', office, currency, seedKey: { $not: /^cash:/ } });
    if (isDefault) continue;

    const groupCode = alias ? alias.groupCode : '1101';
    const group = bySeedKey.get(groupCode);
    const officeName = defaults.OFFICES.find((item) => item.code === office)?.name || office;
    await Account.create({
      code: await nextChildCode(group.code),
      name: alias ? `${alias.name} - ${currency}` : `خزينة ${officeName} - ${currency}`,
      nameEn: alias ? `${alias.nameEn} - ${currency}` : `${office} cash - ${currency}`,
      type: 'asset',
      parentId: group._id,
      currency,
      isCash: true,
      cashKind: alias ? alias.kind : 'cash',
      office,
      seedKey,
    });
    created(`cash account ${statementOffice} ${currency} (found in customer deposits)`);
  }

  for (const journal of defaults.JOURNALS) {
    if (await Journal.exists({ code: journal.code })) report.existing++;
    else { await Journal.create(journal); created(`journal ${journal.code}`); }
  }

  // Every cash, bank and e-wallet account gets its own journal and numbering
  const cashAccounts = await Account.find({ isCash: true, isGroup: false }).sort({ code: 1 });
  for (const account of cashAccounts) {
    if (await Journal.exists({ defaultAccountId: account._id })) { report.existing++; continue; }
    const base = `${JOURNAL_KIND_PREFIX[account.cashKind] || 'CASH'}-${officeShort(account.office)}-${account.currency || 'USD'}`;
    let code = base;
    for (let n = 2; await Journal.exists({ code }); n++) code = `${base}-${n}`;
    await Journal.create({
      code,
      name: account.name,
      type: CASH_JOURNAL_TYPES[account.cashKind] || 'cash',
      defaultAccountId: account._id,
      office: account.office,
      sequencePrefix: code,
    });
    created(`journal ${code}`);
  }

  for (const vendor of defaults.VENDORS) {
    const result = await require('./merchantSetup').ensureVendor(vendor);
    if (result.created) created(`vendor ${vendor.name}`);
    else report.existing++;
  }

  for (const [index, type] of defaults.EXPENSE_TYPES.entries()) {
    const account = bySeedKey.get(type.accountCode);
    if (await ExpenseType.exists({ seedKey: type.seedKey })) report.existing++;
    else if (account) {
      await ExpenseType.create({ seedKey: type.seedKey, name: type.name, nameEn: type.nameEn, accountId: account._id, sortOrder: index });
      created(`expense type ${type.name}`);
    }
  }

  for (const rule of defaults.BANK_RULES) {
    const account = bySeedKey.get(rule.accountCode);
    const bank = rule.bankCode ? bySeedKey.get(rule.bankCode) : null;
    if (await BankRule.exists({ seedKey: rule.seedKey })) report.existing++;
    else if (account && (!rule.bankCode || bank)) {
      // The same rule typed by hand before it was a default is adopted, not doubled
      const typed = await BankRule.findOne({ seedKey: null, keyword: rule.keyword, accountId: bank?._id || null });
      const fields = { seedKey: rule.seedKey, keyword: rule.keyword, direction: rule.direction, counterAccountId: account._id, accountId: bank?._id || null, priority: rule.priority || 0, vendorName: rule.vendorName };
      if (typed) { Object.assign(typed, fields); await typed.save(); } else await BankRule.create(fields);
      created(`bank rule ${rule.bankCode ? `${rule.bankCode} ` : ''}${rule.keyword}`);
    }
  }
  // Rules seeded before the vendor was known get it (the owner's own choice is never overwritten)
  for (const rule of defaults.BANK_RULES.filter((item) => item.vendorName)) {
    await BankRule.updateOne({ seedKey: rule.seedKey, vendorName: null }, { $set: { vendorName: rule.vendorName } });
  }
  // Default rules that were taken out of the defaults are removed (rules typed by hand are kept)
  const retired = await BankRule.deleteMany({ seedKey: { $regex: /^bank-rule:/, $nin: defaults.BANK_RULES.map((rule) => rule.seedKey) } });
  if (retired.deletedCount) created(`${retired.deletedCount} retired bank rule(s) removed`);

  let settings = await AccountingSettings.findOne({ key: 'main' });
  if (!settings) {
    settings = new AccountingSettings({ key: 'main', ...defaults.SETTINGS });
    created('settings');
  }

  const roles = { ...(settings.accountRoles || {}) };
  Object.entries(defaults.ROLE_DEFAULTS).forEach(([role, [code]]) => {
    if (!roles[role] && bySeedKey.get(code)) {
      roles[role] = bySeedKey.get(code)._id;
      created(`role ${role} -> ${code}`);
    }
  });
  settings.accountRoles = roles;

  const officeAccounts = JSON.parse(JSON.stringify(settings.officeAccounts || {}));
  const aliases = { ...(settings.officeAliases || {}) };
  // Plain cash boxes first, so an office maps to its cash box before a bank of the same currency.
  // Sub boxes are not the office's box: they get their own mapping below.
  const ordered = [...cashAccounts].filter((a) => !a.subBox).sort((a, b) => (a.cashKind === 'cash' ? 0 : 1) - (b.cashKind === 'cash' ? 0 : 1));
  for (const account of ordered) {
    const aliasKey = Object.keys(defaults.STATEMENT_OFFICE_ALIASES).find((key) => (
      account.seedKey === '110201' ? key === 'almutahidaTrBank' : account.seedKey?.startsWith(`cash:${key}:`)
    ));
    const key = aliasKey || (account.cashKind === 'cash' ? account.office : null);
    if (!key || !account.currency) continue;
    if (aliasKey) aliases[aliasKey] = defaults.STATEMENT_OFFICE_ALIASES[aliasKey].office;
    officeAccounts[key] = officeAccounts[key] || {};
    if (!officeAccounts[key][account.currency]) {
      officeAccounts[key][account.currency] = account._id;
      created(`cash mapping ${key}/${account.currency} -> ${account.code}`);
    }
  }
  settings.officeAccounts = officeAccounts;
  settings.officeAliases = aliases;

  const subOfficeAccounts = JSON.parse(JSON.stringify(settings.subOfficeAccounts || {}));
  for (const account of cashAccounts.filter((a) => a.subBox && a.office && a.currency)) {
    subOfficeAccounts[account.office] = subOfficeAccounts[account.office] || {};
    if (!subOfficeAccounts[account.office][account.currency]) {
      subOfficeAccounts[account.office][account.currency] = account._id;
      created(`sub cash box ${account.office}/${account.currency} -> ${account.code}`);
    }
  }
  settings.subOfficeAccounts = subOfficeAccounts;
  settings.markModified('subOfficeAccounts');

  const eventJournals = { ...(settings.eventJournals || {}) };
  Object.entries(defaults.EVENT_JOURNALS).forEach(([event, journal]) => {
    if (!eventJournals[event]) eventJournals[event] = journal;
  });
  settings.eventJournals = eventJournals;

  if (!settings.setupCompletedAt) settings.setupCompletedAt = new Date();
  settings.markModified('accountRoles');
  settings.markModified('officeAccounts');
  settings.markModified('officeAliases');
  settings.markModified('eventJournals');
  await settings.save();

  invalidateConfig();
  // Every package already on a trip gets its trip links (they did not exist before)
  const links = await require('../services/tripLinks').backfillTripLinks();
  if (links.updated) created(`trip links on ${links.updated} package(s)`);
  report.ranBy = user?._id;
  return report;
}

async function isSetupDone() {
  return !!(await AccountingSettings.exists({ key: 'main', setupCompletedAt: { $ne: null } }));
}

module.exports = { runSetup, isSetupDone };
