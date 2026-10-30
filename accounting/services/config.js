const { Account, Currency, AccountingSettings, AccountingOffice, MigrationRun } = require('../models');

// Settings, currencies, offices and the chart change rarely but are read on every posting.
// Cached, cleared on every change made through the accounting API, and refreshed after a
// minute anyway in case another server instance changed them.
const TTL_MS = 60 * 1000;
let cache = null;
let loadedAt = 0;

async function load() {
  const [settings, currencies, accounts, offices, committed] = await Promise.all([
    AccountingSettings.findOne({ key: 'main' }).lean(),
    Currency.find({}).lean(),
    Account.find({}).lean(),
    AccountingOffice.find({}).lean(),
    MigrationRun.findOne({ status: 'committed' }).sort({ committedAt: -1 }).select('cutoff countAt config.countDay config.openingCounts.accountId').lean(),
  ]);
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  return {
    settings,
    currencies: new Map(currencies.map((currency) => [currency.code, currency])),
    offices: new Map(offices.map((office) => [office.code, office])),
    accountsById: byId,
    accountsByCode: byCode,
    // The opening count of the committed migration: when the boxes were counted and which ones.
    // Money dated before that is already in the counted amount (see ledger.js)
    count: committed ? countOf(committed) : null,
  };
}

// A count on an earlier day stands for the end of that day; a count on the day of the run stands
// for the moment the dry run read the books (older runs: the commit), so what was done later that
// day is not in it
function countOf(run) {
  const { toDay, dayEnd } = require('./dates');
  const at = run.countAt || run.cutoff;
  const day = run.config?.countDay || toDay(at);
  const endOfDay = day < toDay(at);
  return { day, at: endOfDay ? dayEnd(day) : new Date(at), endOfDay, accountIds: new Set((run.config?.openingCounts || []).map((c) => String(c.accountId))) };
}

async function getConfig() {
  if (!cache || Date.now() - loadedAt > TTL_MS) {
    cache = await load();
    loadedAt = Date.now();
  }
  const trial = require('./migration/bankTrial').context();
  if (trial?.session) return { ...cache, count: trial.count };
  // Bank previews must use the same opening-count boundary as trial posting.
  if (trial?.bankRequest && process.env.EXIOS_QA === '1') {
    const run = await MigrationRun.findOne({ status: 'review', bankTrialEnabled: true }).lean();
    if (run) return { ...cache, count: countOf(run) };
  }
  return cache;
}

function invalidateConfig() {
  cache = null;
  // The system's office list is read from the same offices
  require('../../utils/offices').invalidateOffices();
}

async function getDecimals(currencyCode) {
  const { currencies } = await getConfig();
  const currency = currencies.get(currencyCode);
  if (!currency) throw new Error(`Unknown currency ${currencyCode}`);
  return currency.decimals;
}

module.exports = { getConfig, invalidateConfig, getDecimals, countOf };
