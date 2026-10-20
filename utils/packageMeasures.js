// What a package is charged on (spec v8).
//
// weight.total is always the chargeable weight: the customer's price is weight.total x exiosPrice,
// and the trip's cost is shared over packages by it. A package "charged by volume" (air, in KG) has
// weight.total = CBM x the volumetric factor (167 by default), and the scale's weight is kept in
// weight.actual. Every screen and report that multiplies weight by price follows by itself, and old
// packages (never charged by volume) keep their recorded weight.
//
// Staff may edit package data until delivery. Delivered packages are immutable
// in the general editors, including for administrators and accountants.
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
    const calculatedWeight = round(cbm * factor, 2);
    const hasOverride = volumetric.chargeableWeight !== undefined && volumetric.chargeableWeight !== null && volumetric.chargeableWeight !== '';
    const chargeableWeight = hasOverride ? round(volumetric.chargeableWeight, 2) : calculatedWeight;
    if (hasOverride && (typeof volumetric.chargeableWeight === 'boolean' || !Number.isFinite(chargeableWeight) || chargeableWeight <= 0)) {
      throw new ErrorHandler(400, 'وزن الفوترة المعدّل يجب أن يكون رقمًا أكبر من صفر.');
    }
    details.volumetric = { ...volumetric, enabled: true, cbm: round(cbm, 4), factor, calculatedWeight, chargeableWeight: hasOverride ? chargeableWeight : undefined };
    weight.total = chargeableWeight;
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
  const needsRate = packages.some((p) => !p?.status?.received && FEE_FIELDS.some((field) => p?.deliveredPackages?.[field]?.currency === 'LYD' && !(Number(p.deliveredPackages[field].usd) > 0)));
  const rate = needsRate ? await settingsRate() : null;
  packages.forEach((pkg) => { if (!pkg?.status?.received) normalizeDetails(pkg?.deliveredPackages, { factor, rate }); });
  return packages;
}

async function canEditMeasures(user) {
  if (!user) return false;
  if (user.roles?.isAdmin || user.roles?.isAccountant || user.roles?.isEmployee) return true;
  try {
    return await require('../accounting/services/access').isOwner(user);
  } catch {
    return false;
  }
}

// Compare schema-cast data so harmless numeric strings, object key order and
// populated references do not prevent saving other, undelivered packages.
const snapshot = (order, pkg) => {
  const value = pkg.toObject ? pkg.toObject({ depopulate: true }) : pkg;
  const cast = new order.constructor({ paymentList: [value] }).paymentList[0];
  return JSON.parse(JSON.stringify(cast.toObject({ depopulate: true })));
};

async function guardMeasures(before, packages, user, { partial = false } = {}) {
  if (!before || !Array.isArray(packages)) return;
  const ids = packages.filter(pkg => pkg?._id).map(pkg => String(pkg._id));
  if (new Set(ids).size !== ids.length) throw new ErrorHandler(400, 'لا يمكن تكرار الطرد نفسه في الطلبية.');
  const saved = new Map((before.paymentList || []).map((pkg) => [String(pkg._id), pkg]));
  for (const pkg of packages) {
    const old = saved.get(String(pkg?._id));
    if (old?.freeShippingOffer?.enabled) {
      pkg.freeShippingOffer = old.freeShippingOffer.toObject ? old.freeShippingOffer.toObject() : old.freeShippingOffer;
      if (pkg.deliveredPackages?.exiosPrice !== undefined && Number(pkg.deliveredPackages.exiosPrice) !== 0) {
        throw new ErrorHandler(403, 'هذا الطرد ضمن عرض شحن مجاني معتمد؛ لا يمكن تغيير سعره بالتعديل العادي.');
      }
    } else if (pkg) delete pkg.freeShippingOffer;
  }
  const { isDeepStrictEqual } = require('util');
  for (const [id, old] of saved) {
    if (!old.status?.received) continue;
    const index = packages.findIndex(pkg => String(pkg?._id) === id);
    if (index === -1 && partial) continue;
    if (index === -1 || !isDeepStrictEqual(snapshot(before, old), snapshot(before, packages[index]))) {
      throw new ErrorHandler(403, 'لا يمكن تعديل بيانات الطرد أو حذفه بعد تسليمه، بما في ذلك من حساب المحاسب.');
    }
    // Preserve the exact saved data and historical fee/volumetric conversions.
    packages[index] = old.toObject({ depopulate: true });
  }
}

// 'Received' (handed to the customer) is never ticked by hand (owner's decision 2026-10-04): it is
// set by delivering the packages with their payment (markPackagesAsDelivered) and undone by
// cancelling that delivery invoice. A package keeps what is stored; a new one is not received.
function keepDeliveryState(oldOrder, packages) {
  (packages || []).forEach((pkg) => {
    if (!pkg) return;
    const old = pkg._id && (oldOrder?.paymentList || []).find((p) => String(p._id) === String(pkg._id));
    if (old?.creditDeliveryInvoiceId) pkg.creditDeliveryInvoiceId = old.creditDeliveryInvoiceId;
    else delete pkg.creditDeliveryInvoiceId;
    if (old?.shippingRecognitionFrom) pkg.shippingRecognitionFrom = old.shippingRecognitionFrom;
    else delete pkg.shippingRecognitionFrom;
    if (old?.freeShippingOffer) pkg.freeShippingOffer = old.freeShippingOffer.toObject ? old.freeShippingOffer.toObject() : old.freeShippingOffer;
    else delete pkg.freeShippingOffer;
    if (old?.freeShippingOffer?.enabled && pkg.deliveredPackages) pkg.deliveredPackages.exiosPrice = 0;
    pkg.status = { ...(pkg.status || {}), received: !!old?.status?.received };
  });
  return packages;
}

module.exports = { keepDeliveryState, FEE_FIELDS, normalizePackages, normalizeDetails, guardMeasures, canEditMeasures, volumetricFactor, cbmOf, DEFAULT_FACTOR };
