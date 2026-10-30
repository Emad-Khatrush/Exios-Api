const { JournalEntry, Account } = require('../models');

// Per-account totals from the ledger. `from`/`to` are Libya days (YYYY-MM-DD, inclusive).
// opening = everything before `from`; debit/credit = movements inside the period.
async function accountTotals({ from, to, accountIds } = {}) {
  const match = {};
  if (to) match.day = { $lte: to };
  const lineMatch = accountIds ? { 'lines.accountId': { $in: accountIds } } : {};

  const rows = await JournalEntry.aggregate([
    { $match: { ...match, ...lineMatch } },
    { $unwind: '$lines' },
    ...(accountIds ? [{ $match: lineMatch }] : []),
    {
      $group: {
        _id: '$lines.accountId',
        openingUsd: { $sum: from ? { $cond: [{ $lt: ['$day', from] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } : 0 },
        debit: { $sum: !from ? '$lines.debit' : { $cond: [{ $gte: ['$day', from] }, '$lines.debit', 0] } },
        credit: { $sum: !from ? '$lines.credit' : { $cond: [{ $gte: ['$day', from] }, '$lines.credit', 0] } },
        foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } },
      },
    },
  ]);

  return new Map(rows.map((row) => [String(row._id), {
    openingUsd: row.openingUsd,
    debit: row.debit,
    credit: row.credit,
    closingUsd: row.openingUsd + row.debit - row.credit,
    foreign: row.foreign,
  }]));
}

// The chart with totals on every account and rolled up into its groups (USD only:
// foreign amounts of different currencies cannot be added up).
async function chartWithTotals(options = {}) {
  const [accounts, totals] = await Promise.all([
    Account.find({}).sort({ code: 1 }).lean(),
    accountTotals(options),
  ]);
  const empty = () => ({ openingUsd: 0, debit: 0, credit: 0, closingUsd: 0, foreign: 0 });
  const byId = new Map(accounts.map((account) => [String(account._id), { ...account, totals: totals.get(String(account._id)) || empty() }]));

  byId.forEach((account) => {
    if (account.isGroup) return;
    const { totals: own } = account;
    let parent = account.parentId && byId.get(String(account.parentId));
    const seen = new Set();
    while (parent && !seen.has(String(parent._id))) {
      seen.add(String(parent._id));
      ['openingUsd', 'debit', 'credit', 'closingUsd'].forEach((field) => { parent.totals[field] += own[field]; });
      parent = parent.parentId && byId.get(String(parent.parentId));
    }
  });
  return [...byId.values()];
}

module.exports = { accountTotals, chartWithTotals };
