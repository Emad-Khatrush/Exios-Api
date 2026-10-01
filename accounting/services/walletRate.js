// The dinar rate a wallet payment on an order may use. The accountant's daily rate is the
// reference; a payment may be counted at a rate a little below it (so a small rounding gap
// can be closed by the rate) but never lower than that.
const { CurrencyRate } = require('../models');
const { toDay } = require('./dates');

// How far below the accountant's rate a payment may be counted (dinars per dollar)
const RATE_TOLERANCE = 0.2;

const round4 = (value) => Math.round(value * 10000) / 10000;

// The accountant's LYD rate on `date` (or the last one before it) and the lowest rate allowed.
// null when no rate has been entered yet, in which case nothing is enforced.
async function lydRateLimits(date) {
  let day;
  try {
    day = toDay(date || new Date());
  } catch {
    day = toDay(new Date());
  }
  const found = await CurrencyRate.findOne({ currency: 'LYD', day: { $lte: day } }).sort({ day: -1 }).lean();
  if (!found) return null;
  return { rate: found.rate, minimum: round4(Math.max(0, found.rate - RATE_TOLERANCE)), tolerance: RATE_TOLERANCE, day: found.day };
}

module.exports = { lydRateLimits, RATE_TOLERANCE };
