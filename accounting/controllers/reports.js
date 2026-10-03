const mongoose = require('mongoose');
const { JournalEntry, Account, CurrencyRate, Currency } = require('../models');
const { handle, badRequest, notFound, isObjectId } = require('./util');
const { visibleMatch } = require('../services/visibility');
const { chartWithTotals, accountTotals } = require('../services/balances');
const { getConfig } = require('../services/config');
const { isDay, today } = require('../services/dates');
const { carryingRate } = require('../services/carrying');
const { isSetupDone } = require('../seed/setup');

const checkPeriod = ({ from, to }) => {
  if (from && !isDay(from)) throw badRequest('تاريخ البداية غير صالح');
  if (to && !isDay(to)) throw badRequest('تاريخ النهاية غير صالح');
};

module.exports.dashboard = handle(async (req, res) => {
  if (!(await isSetupDone())) return res.json({ setupDone: false });
  const { settings, accountsById, currencies } = await getConfig();
  const day = today();

  const cashAccounts = await Account.find({ isCash: true, isGroup: false }).sort({ code: 1 }).lean();
  const totals = await accountTotals({ accountIds: cashAccounts.map((a) => a._id) });
  const cash = cashAccounts.map((account) => {
    const t = totals.get(String(account._id)) || { closingUsd: 0, foreign: 0 };
    const decimals = currencies.get(account.currency)?.decimals ?? 2;
    return {
      _id: account._id, code: account.code, name: account.name, office: account.office, currency: account.currency,
      cashKind: account.cashKind, isActive: account.isActive, usd: t.closingUsd, foreign: t.foreign, decimals,
      carryingRate: account.currency && account.currency !== 'USD' ? carryingRate({ usd: t.closingUsd, foreign: t.foreign }, decimals) : null,
    };
  });

  const roleBalance = async (role) => {
    const id = settings.accountRoles?.[role];
    if (!id) return null;
    const t = (await accountTotals({ accountIds: [new mongoose.Types.ObjectId(String(id))] })).get(String(id));
    const account = accountsById.get(String(id));
    // `foreign` is the balance in the account's own currency (dinars for the dinar wallets)
    return { account: account?.code, usd: t?.closingUsd || 0, foreign: t?.foreign || 0, currency: account?.currency || 'USD', decimals: currencies.get(account?.currency)?.decimals ?? 2 };
  };

  const foreignCurrencies = await Currency.find({ isActive: true, isBase: { $ne: true } }).lean();
  const todayRates = await CurrencyRate.find({ day }).lean();
  // Only the currencies in use (the dinar and those a box holds) need a rate each day; the rest are optional
  const needed = new Set(['LYD', ...cashAccounts.filter((a) => a.isActive !== false && a.currency && a.currency !== 'USD').map((a) => a.currency)]);
  const missingRates = foreignCurrencies.filter((c) => needed.has(c.code) && !todayRates.some((r) => r.currency === c.code)).map((c) => c.code);

  res.json({
    setupDone: true,
    day,
    lockDate: settings.lockDate,
    cash,
    balances: {
      receivables: await roleBalance('customer_receivable'),
      walletsUsd: await roleBalance('wallet_usd'),
      walletsLyd: await roleBalance('wallet_lyd'),
      suspense: await roleBalance('migration_suspense'),
      payableCarriers: await roleBalance('payable_carriers'),
      payableSuppliers: await roleBalance('payable_suppliers'),
    },
    missingRates,
    entriesCount: await JournalEntry.estimatedDocumentCount(),
  });
});

// Opening, debit, credit and closing per account for a period; groups carry the totals of
// their accounts. Unbalanced totals would mean a broken ledger, so they are reported too.
module.exports.trialBalance = handle(async (req, res) => {
  const { from, to } = req.query;
  checkPeriod({ from, to });
  const accounts = await chartWithTotals({ from, to });
  const detail = accounts.filter((account) => !account.isGroup);
  const sum = (field) => detail.reduce((total, account) => total + account.totals[field], 0);
  res.json({
    results: accounts,
    totals: { opening: sum('openingUsd'), debit: sum('debit'), credit: sum('credit'), closing: sum('closingUsd') },
  });
});

// Every movement of one account with a running balance (optionally one customer's)
module.exports.accountLedger = handle(async (req, res) => {
  const { from, to, partnerId, showCanceled } = req.query;
  checkPeriod({ from, to });
  if (!isObjectId(req.params.id)) throw badRequest('الحساب غير صالح');
  const visible = visibleMatch(showCanceled);
  const account = await Account.findById(req.params.id).lean();
  if (!account) throw notFound('الحساب غير موجود');
  const accountId = new mongoose.Types.ObjectId(req.params.id);

  // A group shows the movements of every account under it
  const lineMatch = { 'lines.accountId': accountId };
  const names = new Map();
  if (account.isGroup) {
    const all = await Account.find({}).select('parentId code name isGroup').lean();
    const ids = [];
    const walk = (parentId) => all.filter((a) => String(a.parentId) === String(parentId)).forEach((child) => {
      if (child.isGroup) walk(child._id);
      else { ids.push(child._id); names.set(String(child._id), { code: child.code, name: child.name }); }
    });
    walk(account._id);
    lineMatch['lines.accountId'] = { $in: ids };
  }
  if (isObjectId(partnerId)) lineMatch['lines.partnerId'] = new mongoose.Types.ObjectId(partnerId);

  const opening = from ? (await JournalEntry.aggregate([
    { $match: { ...lineMatch, ...visible, day: { $lt: from } } },
    { $unwind: '$lines' },
    { $match: lineMatch },
    { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } } } },
  ]))[0] : null;

  const dayRange = {};
  if (from) dayRange.$gte = from;
  if (to) dayRange.$lte = to;
  const rows = await JournalEntry.aggregate([
    { $match: { ...lineMatch, ...visible, ...(from || to ? { day: dayRange } : {}) } },
    { $sort: { day: 1, createdAt: 1 } },
    { $limit: 5000 },
    // The operation's amount in its own currency (dinars...), even when this account is kept in dollars
    { $addFields: { original: { $first: { $filter: { input: '$lines', cond: { $and: [{ $ne: [{ $ifNull: ['$$this.currency', 'USD'] }, 'USD'] }, { $ne: [{ $ifNull: ['$$this.amountCurrency', 0] }, 0] }] } } } } } },
    { $unwind: '$lines' },
    { $match: lineMatch },
    { $project: { number: 1, day: 1, description: 1, eventType: 1, status: 1, source: 1, reversalOf: 1, line: '$lines', original: { currency: '$original.currency', amount: { $abs: '$original.amountCurrency' }, rate: '$original.rate' } } },
  ]);

  let usd = opening?.usd || 0;
  let foreign = opening?.foreign || 0;
  const movements = rows.map((row) => {
    usd += row.line.debit - row.line.credit;
    foreign += row.line.amountCurrency || 0;
    return { ...row, balanceUsd: usd, balanceForeign: foreign, account: names.get(String(row.line.accountId)) };
  });

  res.json({
    account,
    opening: { usd: opening?.usd || 0, foreign: opening?.foreign || 0 },
    movements,
    closing: { usd, foreign },
    truncated: rows.length >= 5000,
  });
});
