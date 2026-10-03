// What a package is charged on (spec v8).
//
// weight.total is always the chargeable weight: the customer's price is weight.total x exiosPrice,
// and the trip's cost is shared over packages by it. A package "charged by volume" (air, in KG) has
// weight.total = CBM x the volumetric factor (167 by default), and the scale's weight is kept in
// weight.actual. Every screen and report that multiplies weight by price follows by itself, and old
// packages (never charged by volume) keep their recorded weight.
//
// Once a package has a weight, only an admin, an accountant or the owner changes its weight,
// volume or volumetric choice; other staff see them.
const ErrorHandler = require('./errorHandler');

const DEFAULT_FACTOR = 167;
// Fees charged on a package beside its shipping: transport to another office, customs clearance
const FEE_FIELDS = ['domesticFee', 'customsFee'];
const FEE_NAMES = { domesticFee: 'transport fee', customsFee: 'customs clearance fee' };
const round = (value, places) => Math.round(Number(value) * 10 ** places) / 10 ** places;

async function volumetricFactor() {
  try {
    const { getConfig } = require('../accounting/services/config');
    return Number((await getConfig()).settings?.volumetricFactor) || DEFAULT_FACTOR;
  } catch {
    return DEFAULT_FACTOR;
  }
}

// The dinar rate of the system's settings, for a transport fee typed in dinars
async function settingsRate() {
  try {
    const ExchangeRate = require('../models/exchangeRate');
    return Number((await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean())?.rate) || null;
  } catch {
    return null;
  }
}

// CBM typed, or length x width x height in centimetres
const cbmOf = (volumetric = {}) => {
  if (Number(volumetric.cbm) > 0) return Number(volumetric.cbm);
  const dims = [volumetric.length, volumetric.width, volumetric.height].map(Number);
  return dims.every((d) => d > 0) ? (dims[0] * dims[1] * dims[2]) / 1e6 : 0;
};

// Works out weight.total (and the transport fee in dollars) on one package's details, in place
function normalizeDetails(details, { factor, rate }) {
  if (!details) return details;
  const weight = details.weight && typeof details.weight === 'object' ? details.weight : { total: details.weight };
  details.weight = weight;
  const volumetric = details.volumetric || {};
  const unit = String(weight.measureUnit || '').toUpperCase();
  if (volumetric.enabled && unit !== 'CBM') {
    const cbm = cbmOf(volumetric);
    if (!(cbm > 0)) throw new ErrorHandler(400, `Package ${details.trackingNumber || ''}: type the volume in CBM or its three dimensions (cm) to charge it by volume`);
    if (weight.actual === undefined || weight.actual === null || weight.actual === '') weight.actual = Number(weight.total) || 0;
    details.volumetric = { ...volumetric, enabled: true, cbm: round(cbm, 4), factor };
    weight.total = round(cbm * factor, 2);
  } else if (volumetric.enabled) {
    // A sea package is already measured in CBM: nothing to convert
    details.volumetric = { ...volumetric, enabled: false };
  }
  FEE_FIELDS.forEach((field) => {
    const fee = details[field];
    if (fee && Number(fee.amount) > 0) {
      const currency = fee.currency === 'LYD' ? 'LYD' : 'USD';
      let usd = Number(fee.usd);
      if (currency === 'USD') usd = Number(fee.amount);
      else if (!(usd > 0)) {
        if (!rate) throw new ErrorHandler(400, `No dinar rate in the settings to price the ${FEE_NAMES[field]}`);
        usd = Number(fee.amount) / rate;
      }
      details[field] = { amount: Number(fee.amount), currency, usd: round(usd, 2) };
    } else if (fee) {
      details[field] = undefined;
    }
  });
  return details;
}

async function normalizePackages(packages) {
  if (!Array.isArray(packages) || !packages.length) return packages;
  const factor = await volumetricFactor();
  const needsRate = packages.some((p) => FEE_FIELDS.some((field) => p?.deliveredPackages?.[field]?.currency === 'LYD' && !(Number(p.deliveredPackages[field].usd) > 0)));
  const rate = needsRate ? await settingsRate() : null;
  packages.forEach((pkg) => normalizeDetails(pkg?.deliveredPackages, { factor, rate }));
  return packages;
}

async function canEditMeasures(user) {
  if (!user) return false;
  if (user.roles?.isAdmin || user.roles?.isAccountant) return true;
  try {
    return await require('../accounting/services/access').isOwner(user);
  } catch {
    return false;
  }
}

const measuresOf = (pkg) => {
  const d = pkg?.deliveredPackages || {};
  const v = d.volumetric || {};
  return JSON.stringify([
    Number(d.weight?.total ?? d.weight) || 0, Number(d.weight?.actual) || 0, String(d.weight?.measureUnit || ''),
    !!v.enabled, Number(v.cbm) || 0, Number(v.length) || 0, Number(v.width) || 0, Number(v.height) || 0,
  ]);
};

// Refuses a change of weight, volume or volumetric choice on a package that already had a weight,
// unless the user may make it. `before` is the order as saved.
async function guardMeasures(before, packages, user) {
  if (!before || !Array.isArray(packages)) return;
  const saved = new Map((before.paymentList || []).map((pkg) => [String(pkg._id), pkg]));
  const changed = packages.filter((pkg) => {
    const old = pkg?._id && saved.get(String(pkg._id));
    return old && Number(old.deliveredPackages?.weight?.total) > 0 && measuresOf(old) !== measuresOf(pkg);
  });
  if (changed.length && !(await canEditMeasures(user))) {
    const names = changed.map((pkg) => pkg.deliveredPackages?.trackingNumber || pkg._id).join(', ');
    throw new ErrorHandler(403, `Only an admin or the accountant can change a saved weight or volume (${names})`);
  }
}

// 'Received' (handed to the customer) is never ticked by hand (owner's decision 2026-10-04): it is
// set by delivering the packages with their payment (markPackagesAsDelivered) and undone by
// cancelling that delivery invoice. A package keeps what is stored; a new one is not received.
function keepDeliveryState(oldOrder, packages) {
  (packages || []).forEach((pkg) => {
    if (!pkg) return;
    const old = pkg._id && (oldOrder?.paymentList || []).find((p) => String(p._id) === String(pkg._id));
    pkg.status = { ...(pkg.status || {}), received: !!old?.status?.received };
  });
  return packages;
}

module.exports = { keepDeliveryState, FEE_FIELDS, normalizePackages, normalizeDetails, guardMeasures, canEditMeasures, volumetricFactor, cbmOf, DEFAULT_FACTOR };
