// Points offers (spec 2026-11-19-loyalty-promotions-design.md): which offer, if any, a claim of an
// order gets. The order's creation date decides, so an order created during an offer keeps it
// however late it is paid. Pure functions, plus the one query that loads the offers around dates.
const moment = require('moment-timezone');
const { parseKey } = require('../claims/keys');
const { TZ } = require('../dates');
const LoyaltyPromotion = require('../../../models/loyaltyPromotion');

// The office writes the origin in Arabic (with or without hamza), in English or as a code
const COUNTRY_ALIASES = [
  [/^(china|cn|الصين)$/i, 'china'],
  [/^(uae|ae|dubai|ال[اإ]مارات|دبي)$/i, 'uae'],
  [/^(turkey|tr|تركيا)$/i, 'turkey'],
  [/^(usa|us|[اأ]مريكا)$/i, 'usa'],
  [/^(uk|gb|بريطانيا)$/i, 'uk'],
];
const countryKey = (text) => {
  const t = String(text || '').trim();
  return COUNTRY_ALIASES.find(([re]) => re.test(t))?.[1] || '';
};

const METHODS = ['air', 'sea'];
const methodOf = (value) => (METHODS.includes(value) ? value : '');

// What a claim is, for matching: its kind, and for shipping its method and origin. null for the
// fees beside a package (transport, customs), which never earn.
function claimScope(arKey, order) {
  const key = parseKey(arKey);
  if (key.kind === 'purchase') return { kind: order?.isRemittance ? 'remittance' : 'purchase', method: '', country: '' };
  if (key.kind !== 'shipment' || key.domesticFee || key.customsFee) return null;
  const pkg = (order?.paymentList || []).find((p) => String(p._id) === String(key.packageId));
  return {
    kind: 'shipping',
    method: methodOf(pkg?.deliveredPackages?.shipmentMethod) || methodOf(order?.shipment?.method),
    country: countryKey(order?.shipment?.fromWhere),
  };
}

const inList = (list, value) => !list?.length || (!!value && list.includes(value));

function matches(promotion, scope, createdAt) {
  if (!promotion || !scope || !createdAt) return false;
  const time = new Date(createdAt).getTime();
  if (!(new Date(promotion.startsAt).getTime() <= time && time < new Date(promotion.endsAt).getTime())) return false;
  if (!(promotion.kinds || []).includes(scope.kind)) return false;
  if (scope.kind !== 'shipping') return true;
  return inList(promotion.methods, scope.method) && inList(promotion.countries, scope.country);
}

// The offer a claim gets: the highest multiplier, then the earliest start
function bestPromotion(promotions, scope, createdAt) {
  return (promotions || []).filter((p) => matches(p, scope, createdAt))
    .sort((a, b) => (b.multiplierPct - a.multiplierPct) || (new Date(a.startsAt) - new Date(b.startsAt)))[0] || null;
}

// Every offer that could cover any of these dates
async function promotionsAround(dates, session) {
  const times = (dates || []).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  if (!times.length) return [];
  return LoyaltyPromotion.find({ startsAt: { $lte: new Date(Math.max(...times)) }, endsAt: { $gt: new Date(Math.min(...times)) } })
    .session(session || null).lean();
}

// From the first day's midnight to the midnight after the last day, Libya time
function dayRange(fromDay, toDay) {
  return {
    startsAt: moment.tz(fromDay, 'YYYY-MM-DD', true, TZ).startOf('day').toDate(),
    endsAt: moment.tz(toDay, 'YYYY-MM-DD', true, TZ).add(1, 'day').startOf('day').toDate(),
  };
}

// The higher of the level's multiplier and the offer's, never both (owner, 2026-11-19). The offer
// is named only when it is what decided the multiplier.
function multiplierFor(levelKey, promo) {
  const levelPct = require('./tiers').tierOf(levelKey).multiplierPct;
  if (promo && promo.multiplierPct > levelPct) {
    return { pct: promo.multiplierPct, promotion: { id: promo._id, name: promo.name, multiplierPct: promo.multiplierPct } };
  }
  return { pct: levelPct, promotion: null };
}

// Points of a claim of `order`: its base points under the best offer the claim gets, or the level
const pointsWith = (basePoints, levelKey, arKey, order, promotions) => {
  const { pct, promotion } = multiplierFor(levelKey, bestPromotion(promotions, claimScope(arKey, order), order?.createdAt));
  return { points: Math.floor((basePoints * pct) / 100), promotion };
};

module.exports = { countryKey, claimScope, matches, bestPromotion, promotionsAround, dayRange, multiplierFor, pointsWith };
