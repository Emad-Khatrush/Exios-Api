// One dinar rate for the whole system (owner's decision, spec 2.1): the rate kept in the general
// settings (ExchangeRate) is THE rate. Every time it is saved, that day's LYD rate is written to the
// accounting daily rates, so posting (which reads rates by date) and the 0.2 limit on wallet
// payments read the same number, and history keeps the rate of each day.
const ExchangeRate = require('../../models/exchangeRate');
const { CurrencyRate } = require('../models');
const { runInTransaction } = require('./transaction');
const { logAudit } = require('./audit');
const { today } = require('./dates');

const CURRENCY = 'LYD';

// Writes `rate` as today's LYD rate in both places. A rate already used by posted entries is still
// replaced: entries keep the rate they were posted with, and the settings rate may change during
// the day. The change is in the audit log.
async function recordSettingsRate(rate, { req, user, day = today() } = {}) {
  const value = Number(rate);
  if (!(value > 0)) return null;
  const saved = await runInTransaction(async (session) => {
    const existing = await CurrencyRate.findOne({ currency: CURRENCY, day }).session(session);
    if (existing && existing.rate === value) return existing;
    if (existing) {
      const before = existing.toObject();
      existing.rate = value;
      existing.source = 'entered';
      existing.migrationRunId = undefined;
      await existing.save({ session });
      await logAudit({ req, user, action: 'rate.settings', model: 'AccountingCurrencyRate', docId: existing._id, before, after: existing }, session);
      return existing;
    }
    const [created] = await CurrencyRate.create([{ currency: CURRENCY, day, rate: value, createdBy: (user || req?.user)?._id }], { session });
    await logAudit({ req, user, action: 'rate.settings', model: 'AccountingCurrencyRate', docId: created._id, after: created }, session);
    return created;
  });
  // The settings document follows when today's rate was typed in the accounting screen
  if (day === today()) await ExchangeRate.updateOne({ fromCurrency: 'usd' }, { $set: { rate: value } }, { upsert: true });
  return saved;
}

// At start-up: if the settings rate is not the latest daily rate (changed directly, or set before
// accounting existed), today's daily rate is brought in line with it
async function syncSettingsRate() {
  const settings = await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean();
  if (!(settings?.rate > 0)) return null;
  const latest = await CurrencyRate.findOne({ currency: CURRENCY, day: { $lte: today() } }).sort({ day: -1 }).lean();
  if (latest?.rate === settings.rate) return latest;
  return recordSettingsRate(settings.rate);
}

module.exports = { recordSettingsRate, syncSettingsRate };
