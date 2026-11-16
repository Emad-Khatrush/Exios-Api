// Loyalty points rules (spec 2026-11-16). One point is one cent, so points and cents are the
// same integer and every rule here is integer math.

const EXPIRY_DAYS = 365;
const SOON_DAYS = 30;

// 10 points per $20 (shipping, purchase invoices, SWIFT); 5 points per $20 for an Alipay transfer.
// Proportional and rounded down: $30 shipping = 15 points, $30 Alipay = 7 points.
function earnPoints(cents, isRemittance) {
  const amount = Math.trunc(Number(cents) || 0);
  if (amount <= 0) return 0;
  return Math.floor(amount / (isRemittance ? 400 : 200));
}

// Points pay at most 20% of an invoice, less what was already used on it
function redeemCap(billedCents, alreadyRedeemed) {
  const cap = Math.floor(Math.max(Math.trunc(Number(billedCents) || 0), 0) / 5);
  return Math.max(cap - Math.max(Math.trunc(Number(alreadyRedeemed) || 0), 0), 0);
}

// Which lots pay `points`, the ones expiring first used first. Throws when they are not enough.
function takeOldest(lots, points) {
  const sorted = [...lots].filter((lot) => lot.remaining > 0)
    .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
  let rest = points;
  const taken = [];
  for (const lot of sorted) {
    if (rest <= 0) break;
    const take = Math.min(lot.remaining, rest);
    taken.push({ lotId: lot._id, points: take });
    rest -= take;
  }
  if (rest > 0) throw new Error(`Not enough points: short by ${rest}`);
  return taken;
}

module.exports = { EXPIRY_DAYS, SOON_DAYS, earnPoints, redeemCap, takeOldest };
