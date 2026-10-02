// Financial statements read straight from the ledger (spec 9): income statement, balance sheet,
// cash flow, cash box movements, exchange differences. All amounts are USD cents unless a field
// says "foreign" (the account's own currency, in its smallest unit).
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { getConfig } = require('../config');
const { chartWithTotals } = require('../balances');
const { carryingRate } = require('../carrying');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const dayRange = ({ from, to }) => (from || to ? { day: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {});

const SECTION_TITLES = {
  revenue: 'الإيرادات', cost: 'تكلفة الإيرادات', expenses: 'المصروفات التشغيلية', depreciation: 'الإهلاك', fx: 'فروقات العملة',
};
const COST_ROLES = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices'];
const FX_ROLES = ['fx_gain_loss', 'rounding'];
const DEPRECIATION_ROLES = ['depreciation_expense', 'asset_disposal'];

// Which part of the income statement an account belongs to. An account added later under the
// same group as the cost (or depreciation, or exchange) accounts lands in that part by itself.
async function sectionResolver() {
  const { settings, accountsById } = await getConfig();
  const groupsOf = (roles) => {
    const ids = new Set();
    roles.forEach((role) => {
      const account = accountsById.get(String(settings.accountRoles?.[role] || ''));
      if (!account) return;
      ids.add(String(account._id));
      if (account.parentId) ids.add(String(account.parentId));
    });
    return ids;
  };
  const cost = groupsOf(COST_ROLES);
  const fx = groupsOf(FX_ROLES);
  const depreciation = groupsOf(DEPRECIATION_ROLES);
  const inSet = (account, set) => set.has(String(account._id)) || (account.parentId && set.has(String(account.parentId)));
  return (account) => {
    if (account.type === 'income') return 'revenue';
    if (account.type !== 'expense') return null;
    if (inSet(account, cost)) return 'cost';
    if (inSet(account, fx)) return 'fx';
    if (inSet(account, depreciation)) return 'depreciation';
    return 'expenses';
  };
}

const COLUMN_EXPR = {
  month: { $substr: ['$day', 0, 7] },
  year: { $substr: ['$day', 0, 4] },
  office: { $ifNull: ['$lines.office', '-'] },
};

// Income statement for a period; `columns` splits it by month, year or office (spec 9: monthly
// comparison, yearly comparison, profit by office). Year-closing entries are left out, so a
// closed year still shows its result.
async function incomeStatement({ from, to, office, columns } = {}) {
  const { accountsById, offices } = await getConfig();
  const sectionOf = await sectionResolver();
  const accountIds = [...accountsById.values()].filter((a) => !a.isGroup && sectionOf(a)).map((a) => a._id);
  const lineMatch = { 'lines.accountId': { $in: accountIds }, ...(office && { 'lines.office': office }) };
  const rows = await JournalEntry.aggregate([
    { $match: { ...dayRange({ from, to }), eventType: { $ne: 'YEAR_CLOSE' }, 'lines.accountId': { $in: accountIds } } },
    { $unwind: '$lines' },
    { $match: lineMatch },
    { $group: { _id: { accountId: '$lines.accountId', column: COLUMN_EXPR[columns] || 'total' }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);

  const columnKeys = [...new Set(rows.map((row) => row._id.column))].sort();
  const columnList = (COLUMN_EXPR[columns] ? columnKeys : ['total']).map((key) => ({
    key, label: columns === 'office' ? (offices.get(key)?.name || (key === '-' ? 'بدون مكتب' : key)) : key === 'total' ? 'المبلغ' : key,
  }));
  const zero = () => Object.fromEntries(columnList.map((column) => [column.key, 0]));
  const sections = Object.fromEntries(Object.keys(SECTION_TITLES).map((key) => [key, { key, title: SECTION_TITLES[key], rows: new Map(), values: zero(), total: 0 }]));

  rows.forEach(({ _id, net }) => {
    const account = accountsById.get(String(_id.accountId));
    const section = sections[sectionOf(account)];
    // Revenue is shown as a positive figure (credit); everything else as a positive cost (debit)
    const amount = section.key === 'revenue' ? -net : net;
    const row = section.rows.get(String(account._id)) || { accountId: account._id, code: account.code, name: account.name, values: zero(), total: 0 };
    row.values[_id.column] = (row.values[_id.column] || 0) + amount;
    row.total += amount;
    section.rows.set(String(account._id), row);
    section.values[_id.column] += amount;
    section.total += amount;
  });

  const list = Object.values(sections).map((section) => ({ ...section, rows: [...section.rows.values()].sort((a, b) => a.code.localeCompare(b.code)) }));
  const line = (title, compute) => ({
    title,
    values: Object.fromEntries(columnList.map(({ key }) => [key, compute((name) => sections[name].values[key])])),
    total: compute((name) => sections[name].total),
  });
  return {
    from: from || null, to: to || null, office: office || null, columns: columnList, sections: list,
    summary: {
      revenue: line('إجمالي الإيرادات', (v) => v('revenue')),
      grossProfit: line('مجمل الربح', (v) => v('revenue') - v('cost')),
      operatingProfit: line('الربح التشغيلي', (v) => v('revenue') - v('cost') - v('expenses') - v('depreciation')),
      netProfit: line('صافي الربح', (v) => v('revenue') - v('cost') - v('expenses') - v('depreciation') - v('fx')),
    },
  };
}

// Balance sheet on a day. The result of periods not yet closed into retained earnings is shown
// as its own equity line, so assets always equal liabilities plus equity.
async function balanceSheet({ asOf } = {}) {
  const accounts = await chartWithTotals({ to: asOf });
  const byType = (type) => accounts.filter((account) => account.type === type).sort((a, b) => a.code.localeCompare(b.code));
  const depthOf = (account) => {
    let depth = 0;
    let parent = account.parentId && accounts.find((a) => String(a._id) === String(account.parentId));
    while (parent) { depth++; parent = parent.parentId && accounts.find((a) => String(a._id) === String(parent.parentId)); }
    return depth;
  };
  // Assets are debit balances; liabilities and equity are shown as positive credit balances
  const rowsOf = (type, sign) => byType(type).filter((account) => account.totals.closingUsd !== 0).map((account) => ({
    accountId: account._id, code: account.code, name: account.name, isGroup: account.isGroup, depth: depthOf(account),
    amount: sign * account.totals.closingUsd, currency: account.currency || null,
    foreign: !account.isGroup && account.currency && account.currency !== 'USD' ? sign * account.totals.foreign : null,
  }));
  const sumOf = (type) => accounts.filter((a) => a.type === type && !a.isGroup).reduce((sum, a) => sum + a.totals.closingUsd, 0);
  const assets = sumOf('asset');
  const liabilities = 0 - sumOf('liability');
  const equity = 0 - sumOf('equity');
  const unclosedEarnings = 0 - (sumOf('income') + sumOf('expense'));
  // This fiscal year's result, apart from earlier years not closed yet (closing them moves them
  // into retained earnings; until then they are shown on their own line)
  const { fiscalYear } = require('../closing');
  const day = asOf || require('../dates').today();
  let { start } = await fiscalYear(day.slice(0, 4));
  if (start > day) start = (await fiscalYear(String(Number(day.slice(0, 4)) - 1))).start;
  const resultIds = accounts.filter((a) => !a.isGroup && ['income', 'expense'].includes(a.type)).map((a) => a._id);
  const [thisYear] = await JournalEntry.aggregate([
    { $match: { day: { $gte: start, $lte: day }, eventType: { $ne: 'YEAR_CLOSE' }, 'lines.accountId': { $in: resultIds } } },
    { $unwind: '$lines' }, { $match: { 'lines.accountId': { $in: resultIds } } },
    { $group: { _id: null, net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]);
  const currentYearEarnings = thisYear?.net || 0;
  return {
    asOf: asOf || null,
    assets: { rows: rowsOf('asset', 1), total: assets },
    liabilities: { rows: rowsOf('liability', -1), total: liabilities },
    equity: {
      rows: rowsOf('equity', -1), total: equity, unclosedEarnings, totalWithEarnings: equity + unclosedEarnings,
      currentYearEarnings, priorUnclosedEarnings: unclosedEarnings - currentYearEarnings, yearStart: start,
    },
    balanced: assets === liabilities + equity + unclosedEarnings,
    difference: assets - (liabilities + equity + unclosedEarnings),
  };
}

const CASH_FLOW_TITLES = { operating: 'الأنشطة التشغيلية', investing: 'الأنشطة الاستثمارية', financing: 'الأنشطة التمويلية' };

// Cash flow: every entry that moved a cash box, bank or e-wallet, classified by the accounts on
// its other side (fixed assets = investing; capital, withdrawals, loans = financing).
async function cashFlow({ from, to } = {}) {
  const { accountsById } = await getConfig();
  const cashIds = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup).map((a) => a._id);
  const rows = await JournalEntry.aggregate([
    { $match: { ...dayRange({ from, to }), 'lines.accountId': { $in: cashIds } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $nin: cashIds } } },
    { $group: { _id: '$lines.accountId', flow: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]);
  const balanceAt = async (match) => (await JournalEntry.aggregate([
    { $match: { ...match, 'lines.accountId': { $in: cashIds } } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': { $in: cashIds } } },
    { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]))[0]?.usd || 0;
  const opening = from ? await balanceAt({ day: { $lt: from } }) : 0;
  const closing = await balanceAt(to ? { day: { $lte: to } } : {});

  const categories = Object.fromEntries(Object.keys(CASH_FLOW_TITLES).map((key) => [key, { key, title: CASH_FLOW_TITLES[key], rows: [], total: 0 }]));
  rows.filter((row) => row.flow !== 0).forEach((row) => {
    const account = accountsById.get(String(row._id));
    const category = categories[account?.cashFlowCategory] || categories.operating;
    category.rows.push({ accountId: row._id, code: account?.code, name: account?.name, amount: row.flow });
    category.total += row.flow;
  });
  const list = Object.values(categories).map((c) => ({ ...c, rows: c.rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)) }));
  const net = list.reduce((sum, c) => sum + c.total, 0);
  return { from: from || null, to: to || null, categories: list, net, opening, closing, unexplained: closing - opening - net };
}

// Every cash box, bank and e-wallet over a period, in its own currency and in dollars
async function cashMovements({ from, to } = {}) {
  const { accountsById, currencies } = await getConfig();
  const cash = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup).sort((a, b) => a.code.localeCompare(b.code));
  const inPeriod = from ? { $gte: ['$day', from] } : true;
  const amount = { $ifNull: ['$lines.amountCurrency', 0] };
  const usd = { $subtract: ['$lines.debit', '$lines.credit'] };
  const rows = await JournalEntry.aggregate([
    { $match: { ...(to && { day: { $lte: to } }), 'lines.accountId': { $in: cash.map((a) => a._id) } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: cash.map((a) => a._id) } } },
    {
      $group: {
        _id: '$lines.accountId',
        openingForeign: { $sum: { $cond: [inPeriod, 0, amount] } },
        openingUsd: { $sum: { $cond: [inPeriod, 0, usd] } },
        inForeign: { $sum: { $cond: [{ $and: [inPeriod, { $gt: [amount, 0] }] }, amount, 0] } },
        outForeign: { $sum: { $cond: [{ $and: [inPeriod, { $lt: [amount, 0] }] }, { $abs: amount }, 0] } },
        inUsd: { $sum: { $cond: [inPeriod, '$lines.debit', 0] } },
        outUsd: { $sum: { $cond: [inPeriod, '$lines.credit', 0] } },
        movements: { $sum: { $cond: [inPeriod, 1, 0] } },
      },
    },
  ]);
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  const results = cash.map((account) => {
    const row = byId.get(String(account._id)) || { openingForeign: 0, openingUsd: 0, inForeign: 0, outForeign: 0, inUsd: 0, outUsd: 0, movements: 0 };
    const currency = account.currency || 'USD';
    const decimals = currencies.get(currency)?.decimals ?? 2;
    const closingForeign = row.openingForeign + row.inForeign - row.outForeign;
    const closingUsd = row.openingUsd + row.inUsd - row.outUsd;
    return {
      accountId: account._id, code: account.code, name: account.name, office: account.office, cashKind: account.cashKind, isActive: account.isActive,
      currency, decimals, ...row, _id: undefined, closingForeign, closingUsd,
      carryingRate: currency !== 'USD' ? carryingRate({ usd: closingUsd, foreign: closingForeign }, decimals) : null,
    };
  }).filter((row) => row.isActive || row.movements || row.closingUsd || row.openingUsd);
  return {
    from: from || null, to: to || null, results,
    totals: { openingUsd: results.reduce((s, r) => s + r.openingUsd, 0), inUsd: results.reduce((s, r) => s + r.inUsd, 0), outUsd: results.reduce((s, r) => s + r.outUsd, 0), closingUsd: results.reduce((s, r) => s + r.closingUsd, 0) },
  };
}

// Realised exchange gains and losses by the kind of operation that produced them, per month
async function fxReport({ from, to } = {}) {
  const { settings } = await getConfig();
  const fxId = settings.accountRoles?.fx_gain_loss && oid(settings.accountRoles.fx_gain_loss);
  if (!fxId) return { byEvent: [], byMonth: [], total: 0 };
  const base = [
    { $match: { ...dayRange({ from, to }), eventType: { $ne: 'YEAR_CLOSE' }, 'lines.accountId': fxId } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': fxId } },
  ];
  // Positive = gain (credit), negative = loss
  const gain = { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } };
  const [byEvent, byMonth] = await Promise.all([
    JournalEntry.aggregate([...base, { $group: { _id: '$eventType', amount: gain, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    JournalEntry.aggregate([...base, { $group: { _id: { $substr: ['$day', 0, 7] }, amount: gain, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  return {
    accountId: fxId,
    byEvent: byEvent.map((row) => ({ eventType: row._id, amount: row.amount, count: row.count })),
    byMonth: byMonth.map((row) => ({ month: row._id, amount: row.amount, count: row.count })),
    total: byEvent.reduce((sum, row) => sum + row.amount, 0),
  };
}

module.exports = { incomeStatement, balanceSheet, cashFlow, cashMovements, fxReport, sectionResolver };
