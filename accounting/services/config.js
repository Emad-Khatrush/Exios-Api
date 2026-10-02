const { Account, Currency, AccountingSettings, AccountingOffice } = require('../models');

// Settings, currencies, offices and the chart change rarely but are read on every posting.
// Cached, cleared on every change made through the accounting API, and refreshed after a
// minute anyway in case another server instance changed them.
const TTL_MS = 60 * 1000;
let cache = null;
let loadedAt = 0;

async function load() {
  const [settings, currencies, accounts, offices] = await Promise.all([
    AccountingSettings.findOne({ key: 'main' }).lean(),
    Currency.find({}).lean(),
    Account.find({}).lean(),
    AccountingOffice.find({}).lean(),
  ]);
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  return {
    settings,
    currencies: new Map(currencies.map((currency) => [currency.code, currency])),
    offices: new Map(offices.map((office) => [office.code, office])),
    accountsById: byId,
    accountsByCode: byCode,
  };
}

async function getConfig() {
  if (!cache || Date.now() - loadedAt > TTL_MS) {
    cache = await load();
    loadedAt = Date.now();
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

module.exports = { getConfig, invalidateConfig, getDecimals };
