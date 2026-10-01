// Amounts inside the ledger are integers in the smallest unit of their currency
// (USD cents, LYD dirhams (3 decimals), ...). Floats only exist at the edges (API input/output).

const USD = 'USD';
const USD_DECIMALS = 2;

// Math.round rounds -2.5 to -2; money rounds half away from zero on both sides
const roundHalfAway = (value) => Math.sign(value) * Math.round(Math.abs(value));

// Shifting with an exponent string avoids 1.005 * 100 = 100.49999
function toMinor(amount, decimals) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error(`Invalid amount: ${amount}`);
  const shifted = Number(`${Math.abs(value)}e${decimals}`);
  return Math.sign(value) * Math.round(shifted);
}

function fromMinor(minor, decimals) {
  return Number(`${minor}e-${decimals}`);
}

// rate = units of the foreign currency for 1 USD
function convertToUsdMinor(foreignMinor, foreignDecimals, rate) {
  if (!(rate > 0)) throw new Error('A positive exchange rate is required');
  return roundHalfAway((foreignMinor * 10 ** USD_DECIMALS) / (10 ** foreignDecimals) / rate);
}

module.exports = { USD, USD_DECIMALS, roundHalfAway, toMinor, fromMinor, convertToUsdMinor };
