const Inventory = require('../models/inventory');
const { TripNumberingRule: Rule, TripNumberReservation: Reservation } = require('../models/tripNumbering');
const ErrorHandler = require('./errorHandler');

const TOKEN = '{number}';
// Keep existing saved templates compatible without renaming trips or resetting counters.
const normalizeTemplate = value => String(value || '').split('{الرقم}').join(TOKEN);
const MAX_NUMBER = 999999999;
const COUNTRY_NAMES = { CN: 'China', UAE: 'UAE', SA: 'Saudi Arabia', TR: 'Turkey', USA: 'USA', UK: 'UK', LY: 'Libya' };
const KINDS = [
  { value: 'air', label: 'Air freight', template: `Air shipment ${TOKEN}` },
  { value: 'FCL', label: 'Sea freight — FCL', template: `FCL shipment ${TOKEN}` },
  { value: 'LCL', label: 'Sea freight — LCL', template: `LCL shipment ${TOKEN}` },
  { value: 'domestic', label: 'Domestic transport', template: `Domestic shipment ${TOKEN}` },
];
const digits = value => String(value ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const periodOf = rule => rule.format === 'number-year' ? `year:${rule.year}` : 'number';
const inSession = (query, session) => session ? query.session(session) : query;

function scope(country, shippingType, seaLoadType) {
  if (!Inventory.schema.path('shippedCountry').enumValues.includes(country)) throw new ErrorHandler(400, 'Select a valid shipping country.');
  if (shippingType === 'sea' && !['FCL', 'LCL'].includes(seaLoadType)) throw new ErrorHandler(400, 'Select FCL or LCL for sea freight.');
  const kind = shippingType === 'sea' ? seaLoadType : shippingType;
  if (!KINDS.some(item => item.value === kind) || (shippingType !== 'sea' && !['air', 'domestic'].includes(shippingType))) {
    throw new ErrorHandler(400, 'Select a valid shipping type.');
  }
  return { _id: `${country}:${kind}`, country, kind };
}

function scopeFromKind(country, kind) {
  return scope(country, ['FCL', 'LCL', 'sea'].includes(kind) ? 'sea' : kind, ['FCL', 'LCL'].includes(kind) ? kind : null);
}

function defaults(input) {
  return { ...input, enabled: false, format: 'number-year', year: String(new Date().getUTCFullYear()),
    nameTemplate: KINDS.find(item => item.value === input.kind).template, nextNumber: 1, version: 0, mutationVersion: 0 };
}

function render(rule, number) {
  const identifier = rule.format === 'number-year' ? `${number}-${rule.year}` : String(number);
  return normalizeTemplate(rule.nameTemplate).replace(TOKEN, identifier);
}

function validate(input, identity) {
  if (typeof input.enabled !== 'boolean') throw new ErrorHandler(400, 'Choose whether automatic numbering is enabled.');
  if (!['number', 'number-year'].includes(input.format)) throw new ErrorHandler(400, 'Select a valid number format.');
  const year = digits(input.year).trim();
  if (!/^\d{1,12}$/.test(year)) throw new ErrorHandler(400, 'Enter a numeric year or period code, up to 12 digits.');
  const nameTemplate = normalizeTemplate(input.nameTemplate).trim();
  if (nameTemplate.length > 160 || nameTemplate.split(TOKEN).length !== 2 || /[{}]/.test(nameTemplate.replace(TOKEN, '')) || /[\r\n\u0000-\u001f]/.test(nameTemplate)) {
    throw new ErrorHandler(400, `The name template must contain ${TOKEN} exactly once and be no longer than 160 characters.`);
  }
  const nextNumber = Number(digits(input.nextNumber));
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1 || nextNumber > MAX_NUMBER) throw new ErrorHandler(400, `The next number must be a whole number from 1 to ${MAX_NUMBER}.`);
  return { ...identity, enabled: input.enabled, format: input.format, year, nameTemplate, nextNumber };
}

function inventoryFilter(rule) {
  const sea = ['FCL', 'LCL', 'sea'].includes(rule.kind);
  return { inventoryType: 'inventoryGoods', shippedCountry: rule.country, shippingType: sea ? 'sea' : rule.kind,
    ...(sea && { seaLoadType: rule.kind === 'sea' ? { $in: [null, ''] } : rule.kind }) };
}

// Read matching legacy names too. Only the exact configured template/period is parsed;
// unrelated dates, container sizes and arbitrary numbers never advance a sequence.
async function nextAvailable(rule, session) {
  const period = periodOf(rule);
  const last = await inSession(Reservation.findOne({ ruleId: rule._id, period }).sort({ number: -1 }).lean(), session);
  const [prefix, suffix] = normalizeTemplate(rule.nameTemplate).split(TOKEN);
  const year = rule.format === 'number-year' ? `-${escape(rule.year)}` : '';
  const pattern = new RegExp(`^${escape(prefix)}([0-9٠-٩۰-۹]+)${year}${escape(suffix)}$`);
  const legacy = await inSession(Inventory.find({ ...inventoryFilter(rule), voyage: pattern }).select('voyage').lean(), session);
  let highestNumber = last?.number || 0;
  for (const trip of legacy) {
    const match = String(trip.voyage).match(pattern);
    const value = match && Number(digits(match[1]));
    if (Number.isSafeInteger(value) && value <= MAX_NUMBER) highestNumber = Math.max(highestNumber, value);
  }
  const nextNumber = Math.max(rule.nextNumber, highestNumber + 1);
  if (nextNumber > MAX_NUMBER) throw new ErrorHandler(400, 'This sequence has reached its limit. Choose a new numbering period.');
  return { nextNumber, highestNumber, voyage: render(rule, nextNumber) };
}

async function preview(identity, session) {
  const stored = await inSession(Rule.findById(identity._id).lean(), session);
  const rule = stored || defaults(identity);
  return { ...rule, ...(await nextAvailable(rule, session)) };
}

// Ensure a stable lock document before entering the inventory transaction. This does not
// allocate a number. Both admin configuration and trip creation then contend on this row.
async function ensureRule(identity) {
  try {
    await Rule.updateOne({ _id: identity._id }, { $setOnInsert: defaults(identity) }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

async function allocate(identity, inventoryId, user, session) {
  const rule = await Rule.findOneAndUpdate({ _id: identity._id }, { $inc: { mutationVersion: 1 } }, { new: true, session }).lean();
  if (!rule) throw new ErrorHandler(409, 'Refresh the trip details and try again.');
  if (!rule.enabled) return null;
  const next = await nextAvailable(rule, session);
  const period = periodOf(rule);
  await Reservation.create([{
    _id: `${rule._id}:${period}:${next.nextNumber}`, ruleId: rule._id, period, number: next.nextNumber,
    voyage: next.voyage, inventoryId, createdBy: user._id,
  }], { session });
  await Rule.updateOne({ _id: rule._id }, { $set: { nextNumber: next.nextNumber + 1 } }, { session });
  return { voyage: next.voyage, tripNumbering: { ruleId: rule._id, period, number: next.nextNumber, year: rule.format === 'number-year' ? rule.year : null, nameTemplate: rule.nameTemplate } };
}

module.exports = { COUNTRY_NAMES, KINDS, TOKEN, MAX_NUMBER, normalizeTemplate, scope, scopeFromKind, defaults, render, validate, periodOf, preview, nextAvailable, ensureRule, allocate };
