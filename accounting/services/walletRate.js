// The dinar rate a wallet payment on an order may use (owner's decision 2026-10-03, like the
// delivery of packages): the rate is typed by whoever takes the payment, and it may not be lower
// than the system's own rate (the one set in the system's settings) by more than the tolerance.
const ExchangeRate = require('../../models/exchangeRate');

// How far below the system's rate a payment may be counted (dinars per dollar)
const RATE_TOLERANCE = 0.2;

const round4 = (value) => Math.round(value * 10000) / 10000;

// The system's LYD rate and the lowest rate allowed. null when no rate is set, in which case
// nothing is enforced. The system keeps one current rate, so the payment date does not change it.
async function lydRateLimits() {
  const found = await ExchangeRate.findOne({ fromCurrency: 'usd' }).sort({ updatedAt: -1 }).lean();
  const rate = Number(found?.rate);
  if (!(rate > 0)) return null;
  return { rate, minimum: round4(Math.max(0, rate - RATE_TOLERANCE)), tolerance: RATE_TOLERANCE };
}

module.exports = { lydRateLimits, RATE_TOLERANCE };
