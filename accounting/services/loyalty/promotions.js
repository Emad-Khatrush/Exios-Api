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


// ---- Staff: create, change, end, delete; and the lists ----
const ErrorHandler = require('../../../utils/errorHandler');
const { isDay } = require('../dates');
const KINDS = ['shipping', 'purchase', 'remittance'];
const COUNTRIES = ['china', 'uae', 'turkey', 'usa', 'uk'];
const bad = (message) => new ErrorHandler(400, message);

const stateOf = (p, now) => (now < new Date(p.startsAt) ? 'upcoming' : now < new Date(p.endsAt) ? 'active' : 'ended');

// The offer a staff form describes, checked (Arabic messages for the admin)
function fromBody(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw bad('اكتب اسم العرض.');
  if (name.length > 60) throw bad('اسم العرض 60 حرفاً على الأكثر.');
  const multiplierPct = Number(body.multiplierPct);
  if (!Number.isInteger(multiplierPct) || multiplierPct < 110 || multiplierPct > 500 || multiplierPct % 10) throw bad('المضاعفة من ×1.1 إلى ×5، بخطوة 0.1.');
  if (!isDay(body.fromDay) || !isDay(body.toDay)) throw bad('حدد تاريخ بداية العرض ونهايته.');
  if (body.toDay < body.fromDay) throw bad('تاريخ نهاية العرض قبل بدايته.');
  const list = (value, allowed, what) => {
    const items = [...new Set((Array.isArray(value) ? value : []).map(String))];
    if (items.some((item) => !allowed.includes(item))) throw bad(`${what} غير معروفة.`);
    return items;
  };
  // The announcement day: optional, on or before the first day
  const announceDay = String(body.announceDay || '').trim();
  if (announceDay && !isDay(announceDay)) throw bad('تاريخ الإعلان غير صحيح.');
  if (announceDay && announceDay > body.fromDay) throw bad('تاريخ الإعلان يجب أن يكون قبل بداية العرض أو في يومها.');
  const kinds = list(body.kinds, KINDS, 'أنواع الطلبيات');
  if (!kinds.length) throw bad('اختر نوعاً واحداً على الأقل: الشحن، فواتير الشراء أو الحوالات.');
  return {
    name, multiplierPct, ...dayRange(body.fromDay, body.toDay), kinds,
    announceAt: announceDay ? dayRange(announceDay, announceDay).startsAt : undefined,
    methods: list(body.methods, METHODS, 'طرق الشحن'), countries: list(body.countries, COUNTRIES, 'الدول'),
    notify: body.notify !== false,
  };
}

async function findOr404(id, session) {
  const p = require('mongoose').isValidObjectId(id) ? await LoyaltyPromotion.findById(id).session(session || null) : null;
  if (!p) throw new ErrorHandler(404, 'العرض غير موجود');
  return p;
}

async function create(body, { user, now = new Date(), session } = {}) {
  const data = fromBody(body);
  if (data.endsAt <= now) throw bad('تاريخ نهاية العرض مضى.');
  if (!data.announceAt) delete data.announceAt;
  const [p] = await LoyaltyPromotion.create([{ ...data, createdBy: user?._id || user }], { session });
  return p.toObject();
}

// Before it starts anything changes; once started only the name and notify (points already promised
// to orders created in it must not move); after it ended nothing
async function update(id, body, { now = new Date(), session } = {}) {
  const p = await findOr404(id, session);
  const state = stateOf(p, now);
  if (state === 'ended') throw bad('انتهى هذا العرض ولا يمكن تعديله.');
  const data = fromBody(body);
  if (state === 'active') {
    const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
    const locked = data.multiplierPct !== p.multiplierPct || +data.startsAt !== +p.startsAt || +data.endsAt !== +p.endsAt
      || !same(data.kinds, p.kinds) || !same(data.methods, p.methods) || !same(data.countries, p.countries);
    if (locked) throw bad('لا يمكن تعديل عرض بدأ إلا اسمه وإبلاغ العملاء. لإيقافه استعمل «إنهاء العرض الآن».');
    Object.assign(p, { name: data.name, notify: data.notify });
  } else {
    if (data.endsAt <= now) throw bad('تاريخ نهاية العرض مضى.');
    Object.assign(p, data);
  }
  await p.save({ session });
  return p.toObject();
}

async function endNow(id, { now = new Date(), session } = {}) {
  const p = await findOr404(id, session);
  if (stateOf(p, now) !== 'active') throw bad('يمكن إنهاء عرض جارٍ فقط.');
  Object.assign(p, { endsAt: now, endedEarlyAt: now });
  await p.save({ session });
  return p.toObject();
}

async function remove(id, { now = new Date(), session } = {}) {
  const p = await findOr404(id, session);
  if (stateOf(p, now) !== 'upcoming') throw bad('لا يمكن حذف عرض بدأ. يمكنك إنهاؤه.');
  await LoyaltyPromotion.deleteOne({ _id: p._id }).session(session || null);
}

// Every offer for the staff page, newest first, with what each brought: orders and the points it
// added above what the level alone would have given
async function listForStaff({ now = new Date() } = {}) {
  const LoyaltyPoint = require('../../../models/loyaltyPoint');
  const tiers = require('./tiers');
  const list = await LoyaltyPromotion.find().sort({ startsAt: -1, _id: -1 }).lean();
  const earns = await LoyaltyPoint.find({ kind: 'earn', 'promotion.id': { $in: list.map((p) => p._id) } }).select('points basePoints tier promotion.id').lean();
  return list.map((p) => {
    const mine = earns.filter((e) => String(e.promotion.id) === String(p._id));
    return {
      ...p, state: stateOf(p, now), orders: mine.length,
      bonusPoints: mine.reduce((sum, e) => sum + e.points - tiers.multiplied(e.basePoints, e.tier), 0),
    };
  });
}

// Running offers, and the coming ones whose announcement day has come, for the client app
async function activeForCustomers({ now = new Date() } = {}) {
  const list = await LoyaltyPromotion.find({ endsAt: { $gt: now }, $or: [{ startsAt: { $lte: now } }, { announceAt: { $lte: now } }] })
    .sort({ startsAt: 1, _id: 1 }).lean();
  return list.map((p) => ({
    id: String(p._id), name: p.name, multiplierPct: p.multiplierPct, startsAt: p.startsAt, endsAt: p.endsAt, announceAt: p.announceAt || null,
    kinds: p.kinds, methods: p.methods, countries: p.countries, state: stateOf(p, now),
  }));
}

// Offers to tell customers about: one whose announcement day came (before it starts), and one that
// started. Each claimed atomically (announcedAt / notifiedAt), so the hourly job and a staff change
// running together send it once.
async function announceStarted({ now = new Date() } = {}) {
  const coming = await LoyaltyPromotion.find({ notify: true, announcedAt: { $exists: false }, announceAt: { $lte: now }, startsAt: { $gt: now } }).select('_id').lean();
  let teased = 0;
  for (const { _id } of coming) {
    const p = await LoyaltyPromotion.findOneAndUpdate({ _id, announcedAt: { $exists: false } }, { $set: { announcedAt: now } }, { new: true }).lean();
    if (!p) continue;
    teased += 1;
    await require('../../../utils/customerPush').promotionAnnounced(p);
  }
  const due = await LoyaltyPromotion.find({ notify: true, notifiedAt: { $exists: false }, startsAt: { $lte: now }, endsAt: { $gt: now } }).select('_id').lean();
  let announced = 0;
  for (const { _id } of due) {
    const p = await LoyaltyPromotion.findOneAndUpdate({ _id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: now } }, { new: true }).lean();
    if (!p) continue;
    announced += 1;
    await require('../../../utils/customerPush').promotionStarted(p);
  }
  return { announced, teased };
}

module.exports = {
  announceStarted,
  countryKey, claimScope, matches, bestPromotion, promotionsAround, dayRange, multiplierFor, pointsWith,
  stateOf, create, update, endNow, remove, listForStaff, activeForCustomers,
};
