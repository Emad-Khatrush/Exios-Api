const ErrorHandler = require('../../utils/errorHandler');
const { CurrencyRate } = require('../models');
const { USD } = require('./money');
const { toDay } = require('./dates');
const { getConfig } = require('./config');

// The rate to use for an operation (units of `currency` for 1 USD):
// 1. the rate entered on the document, 2. that day's rate, 3. the last rate before it,
// 4. (setting rateFallbackNext, on by default) the first rate after it: old operations of a
// currency whose rates were only entered later. The entry records which rate it used.
async function getRate(currency, date, { docRate, session } = {}) {
  if (currency === USD) return { rate: 1, source: 'base' };
  if (Number(docRate) > 0) return { rate: Number(docRate), source: 'document' };

  const day = toDay(date);
  const found = await CurrencyRate.findOne({ currency, day: { $lte: day } })
    .sort({ day: -1 })
    .session(session || null)
    .lean();
  if (!found && (await getConfig()).settings?.rateFallbackNext !== false) {
    const next = await CurrencyRate.findOne({ currency, day: { $gt: day } }).sort({ day: 1 }).session(session || null).lean();
    if (next) return { rate: next.rate, source: 'next', day: next.day, rateId: next._id };
  }
  if (!found) {
    throw new ErrorHandler(400, `لا يوجد سعر صرف لعملة ${currency} في ${day} أو قبله. أدخل السعر من شاشة الأسعار اليومية.`);
  }
  return { rate: found.rate, source: found.day === day ? 'daily' : 'previous', day: found.day, rateId: found._id };
}

// Once a posted entry used a daily rate it cannot be changed; corrections are made with entries
async function markRateUsed(rateId, session) {
  if (!rateId) return;
  await CurrencyRate.updateOne({ _id: rateId, isUsed: false }, { $set: { isUsed: true } }, { session });
}

module.exports = { getRate, markRateUsed };
