// The customer Prices page (Exios-Client) and its settings (admin: Settings > Customer prices).
// - GET  /pricing         public: only what is visible, shipping prices merged in from ShipmentPrice.
//                          ?parts=shipping,fcl sends only those sections (each prices page asks for its own)
// - GET  /pricing/config  staff with settings_prices: everything, hidden parts included
// - PUT  /pricing/config  same: saves the page, the shipping price of each route, the text of the
//                          "arrived at the warehouse" message of each route, and the customers'
//                          dollar rate (only shown to customers; the accounting rate is not touched).
// Since 2026-11-24 this is the only prices page in the admin (the old Pricing page was merged in).
const PricingConfig = require('../models/pricingConfig');
const ShipmentPrices = require('../models/shipmentPrices');
const ExchangeRate = require('../models/exchangeRate');
const ErrorHandler = require('../utils/errorHandler');

const COUNTRY_LABELS = { china: 'الصين', uae: 'الإمارات', turkey: 'تركيا', usa: 'أمريكا', uk: 'بريطانيا' };
const METHOD_LABELS = { air: 'شحن جوي', sea: 'شحن بحري' };
// Shown first, in this order; anything else after
const ROUTE_ORDER = ['china-air', 'china-sea', 'uae-air', 'turkey-air', 'usa-air', 'uk-air'];
const DEFAULT_DURATIONS = {
  'china-air': '15 - 20 يوماً', 'china-sea': '45 - 60 يوماً', 'uae-air': '5 - 7 أيام',
  'turkey-air': '5 - 10 أيام', 'usa-air': '18 - 32 يوماً', 'uk-air': '18 - 32 يوماً',
};

// First use: what the app showed until now (purchase brackets were written in the client's code)
const DEFAULTS = {
  key: 'main',
  exchangeRate: { visible: true },
  shipping: { visible: true, note: '', volumetricDivisor: 6000, routes: [] },
  purchase: {
    visible: true,
    note: 'قيمة تقريبية، قد يُضاف شحن داخلي في الصين حسب المورد.',
    minCommission: 10,
    tiers: [
      { upTo: 200, type: 'fixed', value: 10 },
      { upTo: 1000, type: 'percent', value: 5 },
      { upTo: 3000, type: 'percent', value: 4 },
      { upTo: 7000, type: 'percent', value: 3 },
      { upTo: null, type: 'percent', value: 1.5 },
    ],
    sites: [
      { key: 'alibaba', label: 'علي بابا', feePercent: 3 },
      { key: 'others', label: 'مواقع أخرى', feePercent: 0 },
    ],
  },
  // Hidden until the office enters its real numbers
  alipay: { visible: false, note: '', tiers: [{ upTo: 5000, rate: 0, fee: 0 }, { upTo: null, rate: 0, fee: 0 }] },
  swift: { visible: false, note: '', tiers: [{ upTo: 10000, type: 'percent', value: 0 }, { upTo: null, type: 'percent', value: 0 }], fixedFee: 0, minFee: 0 },
  fcl: {
    visible: false,
    note: '',
    containers: [
      { key: '20ft', label: "حاوية 20 قدم", carrier: '', fromPort: 'شنغهاي', toPort: 'طرابلس', route: '', price: 0, duration: '', visible: true },
      { key: '40ft', label: "حاوية 40 قدم", carrier: '', fromPort: 'شنغهاي', toPort: 'طرابلس', route: '', price: 0, duration: '', visible: true },
      { key: '40hq', label: "حاوية 40 قدم عالية (HQ)", carrier: '', fromPort: 'شنغهاي', toPort: 'طرابلس', route: '', price: 0, duration: '', visible: true },
    ],
  },
  offices: [
    // cities: the account city values (Exios-Client src/constants/info.ts) this office serves
    { key: 'tripoli', label: 'مكتب طرابلس', whatsapp: '218915643265', cities: ['tripoli', 'misrata', 'zawiya', 'zliten', 'sabratha', 'sabha'] },
    { key: 'benghazi', label: 'مكتب بنغازي', whatsapp: '218919734019', cities: ['benghazi', 'bayda', 'tobruk', 'ajdabiya', 'derna', 'kufra'] },
  ],
};

// The kinds of goods China routes are priced by; other routes start with one price. The office
// can rename, add or remove them; a kind without a price is not shown.
const CHINA_CATEGORIES = [
  { key: 'normal', label: 'بضائع عادية' },
  { key: 'cosmetics', label: 'تجميل وصحة وماركات', price: 0 },
  { key: 'medical', label: 'بضائع طبية', price: 0 },
];
const BASE_CATEGORY = [{ key: 'normal', label: 'بضائع عادية' }];

// Notes written in the old Pricing page were HTML-ish (<br/>): keep the line breaks, drop tags
const cleanNote = (value) => String(value ?? '')
  .replace(/<\s*\/?\s*br\s*\/?\s*>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const routeKey = (price) => `${price.country}-${price.shippingType}`;

// SWIFT brackets; an older single-rate setting becomes one open bracket
const swiftTiers = (swift) => (swift?.tiers?.length ? swift.tiers : [{ upTo: null, type: 'percent', value: Number(swift?.percent) || 0 }]);
const orderOf = (key) => { const i = ROUTE_ORDER.indexOf(key); return i < 0 ? 99 : i; };

// The later of two dates, either may be missing
const latest = (...dates) => dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()))
  .sort((a, b) => b - a)[0] || null;

// JSON with object keys sorted, so a saved value and a cleaned one compare equal whatever their key order
const canon = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
  : v));

// A shopping site as the app reads it; sites saved before their own commission existed use the brackets
const SITE_COMMISSIONS = ['default', 'none', 'percent', 'fixed'];
const siteOf = (s) => ({
  key: s.key, label: s.label, feePercent: Number(s.feePercent) || 0,
  commission: SITE_COMMISSIONS.includes(s.commission) ? s.commission : 'default',
  commissionValue: Number(s.commissionValue) || 0,
  freeShipping: !!s.freeShipping,
});

// The qirsh per dollar added by where the customer pays (Libya / Turkey); missing = 0
const deliveryOf = (s) => ({ libya: Number(s?.delivery?.libya) || 0, turkey: Number(s?.delivery?.turkey) || 0 });

// What counts as a price change, per part: notes, durations and visibility do not
const PRICE_FIELDS = {
  purchase: (s) => ({ minCommission: s?.minCommission ?? 0, tiers: s?.tiers || [], sites: (s?.sites || []).map(siteOf), delivery: deliveryOf(s) }),
  alipay: (s) => ({ tiers: s?.tiers || [], delivery: deliveryOf(s) }),
  swift: (s) => ({ tiers: swiftTiers(s), fixedFee: s?.fixedFee ?? 0, minFee: s?.minFee ?? 0, delivery: deliveryOf(s) }),
};
// A route's base price lives in ShipmentPrice (its own updatedAt), so only the other kinds, the
// minimum and the carrier (a new line usually means a new price) here
const routePrices = (r) => ({
  minCharge: Number(r?.minCharge) || 0,
  minWeight: Number(r?.minWeight) || 0,
  carrier: r?.carrier || '',
  kinds: (r?.categories || []).map((c, i) => ({ label: c.label || '', price: i === 0 ? 0 : Number(c.price) || 0 })),
});
const containerPrices = (c) => ({
  label: c?.label || '', carrier: c?.carrier || '', fromPort: c?.fromPort || '', toPort: c?.toPort || '', route: c?.route || '', price: Number(c?.price) || 0,
});

async function loadConfig() {
  let config = await PricingConfig.findOne({ key: 'main' }).lean();
  if (!config) {
    await PricingConfig.updateOne({ key: 'main' }, { $setOnInsert: DEFAULTS }, { upsert: true });
    config = await PricingConfig.findOne({ key: 'main' }).lean();
  }
  return config;
}

// Every shipping route there is a price for, with how it is shown. The prices can be passed in when
// they were read alongside the config.
async function shippingRoutes(config, prices = null) {
  prices = prices || await ShipmentPrices.find({}).lean();
  const shown = new Map((config.shipping?.routes || []).map((r) => [r.key, r]));
  return prices
    .map((price) => {
      const key = routeKey(price);
      const display = shown.get(key) || {};
      const base = Number(price.sellingPrice) || 0;
      const saved = display.categories?.length ? display.categories : (price.country === 'china' ? CHINA_CATEGORIES : BASE_CATEGORY);
      // The first kind's price is always the route price invoices use
      const categories = saved.map((c, i) => ({ key: c.key, label: c.label, price: i === 0 ? base : Number(c.price) || 0 }));
      return {
        key,
        country: price.country,
        method: price.shippingType,
        label: `${METHOD_LABELS[price.shippingType] || price.shippingType} من ${COUNTRY_LABELS[price.country] || price.country}`,
        countryLabel: COUNTRY_LABELS[price.country] || price.country,
        unit: price.shippingType === 'sea' ? 'cbm' : 'kg',
        price: base,
        categories,
        visible: display.visible !== false,
        duration: display.duration ?? DEFAULT_DURATIONS[key] ?? '',
        // The free text the office wrote for this route before (ShipmentPrice.priceDescription)
        note: cleanNote(display.note ?? price.priceDescription ?? ''),
        minCharge: Number(display.minCharge) || 0,
        minWeight: Number(display.minWeight) || 0,
        // The route's part of the "arrived at the warehouse" message staff send (ShipmentPrice.priceDescription)
        message: cleanNote(price.priceDescription || ''),
        carrier: display.carrier || '',
        // The last time any price of the route changed, for "updated on" in the app
        updatedAt: latest(price.updatedAt, display.pricesUpdatedAt),
      };
    })
    .sort((a, b) => orderOf(a.key) - orderOf(b.key));
}

// The rate customers see: the one set on this page, else the accounting rate
function customerRate(config, accounting) {
  const own = Number(config.exchangeRate?.rate) || 0;
  return own > 0 ? { rate: own, updatedAt: config.exchangeRate.rateUpdatedAt || config.updatedAt || null } : accounting;
}

async function currentRate() {
  const rate = await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean();
  return rate ? { rate: rate.rate, updatedAt: rate.updatedAt } : null;
}

const PARTS = ['shipping', 'fcl', 'purchase', 'alipay', 'swift'];

module.exports.getPublic = async (req, res, next) => {
  try {
    // Only the sections asked for (all of them when none are named). A section left out is absent
    // from the answer; a section the office hides is null, as before.
    const asked = String(req.query.parts || '').split(',').map((p) => p.trim()).filter((p) => PARTS.includes(p));
    const want = (part) => !asked.length || asked.includes(part);

    // The reads don't depend on each other: one round trip to the database instead of three in a row
    const [config, prices, rate] = await Promise.all([
      loadConfig(),
      want('shipping') ? ShipmentPrices.find({}).lean() : null,
      currentRate(),
    ]);
    const routes = want('shipping') ? (await shippingRoutes(config, prices)).filter((r) => r.visible && r.price > 0) : [];
    const visible = (section) => !!config[section]?.visible;
    // Parts saved before change times were kept show the time the settings were last saved
    const updated = (value) => latest(value) || config.updatedAt || null;
    const section = (part, build) => (want(part) ? { [part]: build() } : {});
    res.status(200).json({
      exchangeRate: config.exchangeRate?.visible ? customerRate(config, rate) : null,
      ...section('shipping', () => (visible('shipping') && routes.length ? {
        note: config.shipping.note || '',
        delivery: deliveryOf(config.shipping),
        volumetricDivisor: config.shipping.volumetricDivisor || 6000,
        routes: routes.map(({ visible: _v, message: _m, ...route }) => ({ ...route, updatedAt: updated(route.updatedAt), categories: route.categories.filter((c) => c.price > 0) })),
        updatedAt: updated(latest(...routes.map((r) => r.updatedAt))),
      } : null)),
      ...section('purchase', () => (visible('purchase') ? {
        updatedAt: updated(config.purchase.pricesUpdatedAt),
        note: config.purchase.note || '',
        delivery: deliveryOf(config.purchase),
        minCommission: config.purchase.minCommission || 0,
        tiers: config.purchase.tiers || [],
        sites: (config.purchase.sites || []).map(siteOf),
      } : null)),
      ...section('alipay', () => (visible('alipay') && (config.alipay.tiers || []).some((t) => t.rate > 0) ? {
        updatedAt: updated(config.alipay.pricesUpdatedAt),
        note: config.alipay.note || '',
        delivery: deliveryOf(config.alipay),
        tiers: (config.alipay.tiers || []).filter((t) => t.rate > 0),
      } : null)),
      ...section('swift', () => (visible('swift') ? {
        updatedAt: updated(config.swift.pricesUpdatedAt),
        note: config.swift.note || '',
        delivery: deliveryOf(config.swift),
        tiers: swiftTiers(config.swift),
        fixedFee: config.swift.fixedFee || 0,
        minFee: config.swift.minFee || 0,
      } : null)),
      ...section('fcl', () => (visible('fcl') && (config.fcl.containers || []).some((c) => c.visible !== false && c.price > 0) ? {
        note: config.fcl.note || '',
        containers: config.fcl.containers.filter((c) => c.visible !== false && c.price > 0)
          .map(({ visible: _v, pricesUpdatedAt, ...c }) => ({
            carrier: '', fromPort: '', toPort: '', route: '', duration: '', ...c, updatedAt: updated(pricesUpdatedAt),
          })),
        updatedAt: updated(latest(...config.fcl.containers.filter((c) => c.visible !== false && c.price > 0).map((c) => c.pricesUpdatedAt))),
      } : null)),
      offices: (config.offices || []).filter((o) => o.whatsapp),
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.getConfig = async (req, res, next) => {
  try {
    const config = await loadConfig();
    res.status(200).json({
      ...config,
      shipping: { ...config.shipping, delivery: deliveryOf(config.shipping), routes: await shippingRoutes(config) },
      swift: { ...config.swift, delivery: deliveryOf(config.swift), tiers: swiftTiers(config.swift) },
      purchase: { ...config.purchase, delivery: deliveryOf(config.purchase), sites: (config.purchase?.sites || []).map(siteOf) },
      alipay: { ...config.alipay, delivery: deliveryOf(config.alipay) },
      // Rows saved before shipping lines and ports existed get them empty
      fcl: { ...config.fcl, containers: (config.fcl?.containers || []).map((c) => ({ carrier: '', fromPort: '', toPort: '', route: '', duration: '', ...c })) },
      exchangeRate: await (async () => {
        const accounting = await currentRate();
        // current: what customers see; own: whether this page set it; accounting: for reference only
        return { visible: config.exchangeRate?.visible !== false, current: customerRate(config, accounting), own: Number(config.exchangeRate?.rate) > 0, accounting };
      })(),
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// ---- Saving: everything is cleaned here, the admin form is not trusted
const num = (value, { min = 0, max = 1e9 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
};
const text = (value, max = 400) => String(value ?? '').trim().slice(0, max);
const bool = (value) => value === true || value === 'true';
const fail = (message) => new ErrorHandler(400, message);

// Brackets sorted by upTo, exactly one open-ended (null) bracket, and it comes last
function cleanTiers(list, clean, label) {
  if (!Array.isArray(list) || !list.length) throw fail(`أضف شريحة واحدة على الأقل في ${label}`);
  if (list.length > 20) throw fail(`عدد الشرائح في ${label} كبير جداً`);
  const tiers = list.map((t) => ({ upTo: t.upTo === null || t.upTo === '' || t.upTo === undefined ? null : num(t.upTo, { min: 0.01 }), ...clean(t) }));
  const open = tiers.filter((t) => t.upTo === null);
  if (open.length !== 1) throw fail(`في ${label} يجب أن تكون آخر شريحة «فما فوق» (بدون حد أعلى)، وواحدة فقط`);
  const bounded = tiers.filter((t) => t.upTo !== null).sort((a, b) => a.upTo - b.upTo);
  if (new Set(bounded.map((t) => t.upTo)).size !== bounded.length) throw fail(`في ${label} شريحتان بنفس الحد الأعلى`);
  return [...bounded, open[0]];
}

// Qirsh per dollar, by where the customer pays: at most 1000 (10 LYD a dollar)
const cleanDelivery = (value) => ({ libya: num(value?.libya, { max: 1000 }), turkey: num(value?.turkey, { max: 1000 }) });

const digits = (value) => String(value ?? '').replace(/\D/g, '').slice(0, 15);

// A commission bracket: a percentage of the amount or a fixed amount (purchases, SWIFT)
const commissionTier = (t) => ({ type: t.type === 'fixed' ? 'fixed' : 'percent', value: num(t.value, { max: t.type === 'fixed' ? 1e6 : 100 }) });

// A route's kinds of goods: named, at most 8; the first keeps its place as the base price
function cleanCategories(route) {
  if (!Array.isArray(route.categories) || !route.categories.length) return [];
  return route.categories.slice(0, 8)
    .map((c, i) => ({ key: text(c.key, 40) || `kind-${i + 1}`, label: text(c.label, 60), price: num(c.price, { max: 100000 }) }))
    .filter((c, i) => i === 0 || c.label);
}

module.exports.saveConfig = async (req, res, next) => {
  try {
    const body = req.body || {};
    const current = await loadConfig();
    const update = {};
    const now = new Date();
    // A part whose prices changed gets now; otherwise it keeps its time. A part saved before times
    // were kept gets the previous save time, so later saves of other parts do not move it.
    const stamp = (before, after, previous) => (canon(before) !== canon(after) ? now : (previous || current.updatedAt || now));

    // The customers' rate. Sent unchanged while none was set (the accounting rate is shown), it is
    // not stored, so the page keeps following accounting until the office types its own.
    if (body.exchangeRate) {
      const before = current.exchangeRate || {};
      let rate = Number(before.rate) || 0;
      let rateUpdatedAt = before.rateUpdatedAt || null;
      if (body.exchangeRate.rate !== undefined && body.exchangeRate.rate !== null) {
        const typed = Number(body.exchangeRate.rate);
        if (!(typed > 0 && typed < 1000)) throw fail('سعر الصرف يجب أن يكون أكبر من صفر');
        const shown = customerRate(current, await currentRate());
        if (typed !== Number(shown?.rate)) { rate = typed; rateUpdatedAt = now; }
      }
      update.exchangeRate = { visible: bool(body.exchangeRate.visible), rate, rateUpdatedAt };
    }

    // Shipping: how each route is shown here, its price in ShipmentPrice
    let priceUpdates = [];
    let messageUpdates = [];
    if (body.shipping) {
      const known = new Map((await ShipmentPrices.find({}).lean()).map((p) => [routeKey(p), p]));
      const before = new Map((current.shipping?.routes || []).map((r) => [r.key, r]));
      const routes = (Array.isArray(body.shipping.routes) ? body.shipping.routes : []).filter((r) => known.has(r.key));
      update.shipping = {
        visible: bool(body.shipping.visible),
        note: text(body.shipping.note),
        delivery: cleanDelivery(body.shipping.delivery),
        volumetricDivisor: num(body.shipping.volumetricDivisor, { min: 1000, max: 10000 }) || 6000,
        routes: routes.map((r) => {
          const route = {
            key: r.key, visible: bool(r.visible), duration: text(r.duration, 60), note: text(r.note, 1500), minCharge: num(r.minCharge), minWeight: num(r.minWeight, { max: 100000 }), carrier: text(r.carrier, 60),
            categories: cleanCategories(r),
          };
          const old = before.get(r.key);
          // A route first saved here has no kinds of its own yet: compare with nothing, but keep no stamp
          route.pricesUpdatedAt = old ? stamp(routePrices(old), routePrices(route), old.pricesUpdatedAt) : null;
          return route;
        }),
      };
      // The first kind's price is the route price invoices read (ShipmentPrice). Only written
      // when it changed, so ShipmentPrice.updatedAt is the time the price really changed.
      priceUpdates = routes.map((r) => {
        const [country, shippingType] = r.key.split('-');
        const categories = cleanCategories(r);
        const price = categories.length ? categories[0].price : num(r.price, { max: 100000 });
        if (!(price > 0)) throw fail(`ضع سعر «${categories[0]?.label || 'البضائع العادية'}» لخط ${r.label || r.key}: هو السعر الذي تقرؤه الفواتير`);
        return { country, shippingType, price };
      }).filter((p) => Number(known.get(`${p.country}-${p.shippingType}`)?.sellingPrice) !== p.price);
      // The message text: written only when it was edited, so an untouched older text keeps its form
      messageUpdates = routes
        .filter((r) => typeof r.message === 'string')
        .map((r) => ({ key: r.key, message: text(r.message, 2000) }))
        .filter((m) => m.message !== cleanNote(known.get(m.key)?.priceDescription || ''));
    }

    if (body.purchase) {
      const sites = (Array.isArray(body.purchase.sites) ? body.purchase.sites : []).slice(0, 12)
        .map((s, i) => {
          const commission = SITE_COMMISSIONS.includes(s.commission) ? s.commission : 'default';
          return {
            key: text(s.key, 40) || `site-${i + 1}`, label: text(s.label, 40), feePercent: num(s.feePercent, { max: 100 }),
            commission,
            commissionValue: commission === 'percent' ? num(s.commissionValue, { max: 100 }) : commission === 'fixed' ? num(s.commissionValue, { max: 1e5 }) : 0,
            freeShipping: bool(s.freeShipping),
          };
        })
        .filter((s) => s.label);
      update.purchase = {
        visible: bool(body.purchase.visible),
        note: text(body.purchase.note),
        delivery: cleanDelivery(body.purchase.delivery),
        minCommission: num(body.purchase.minCommission),
        tiers: cleanTiers(body.purchase.tiers, commissionTier, 'عمولات الشراء'),
        sites,
      };
      update.purchase.pricesUpdatedAt = stamp(PRICE_FIELDS.purchase(current.purchase), PRICE_FIELDS.purchase(update.purchase), current.purchase?.pricesUpdatedAt);
    }

    if (body.alipay) {
      const tiers = cleanTiers(body.alipay.tiers, (t) => ({ rate: num(t.rate, { max: 100 }), fee: num(t.fee, { max: 1e5 }) }), 'حوالات علي باي');
      if (bool(body.alipay.visible) && tiers.some((t) => !(t.rate > 0))) throw fail('ضع سعر اليوان لكل شريحة في علي باي قبل إظهارها للعملاء');
      update.alipay = { visible: bool(body.alipay.visible), note: text(body.alipay.note), delivery: cleanDelivery(body.alipay.delivery), tiers };
      update.alipay.pricesUpdatedAt = stamp(PRICE_FIELDS.alipay(current.alipay), PRICE_FIELDS.alipay(update.alipay), current.alipay?.pricesUpdatedAt);
    }

    if (body.swift) {
      update.swift = {
        visible: bool(body.swift.visible),
        note: text(body.swift.note),
        delivery: cleanDelivery(body.swift.delivery),
        tiers: cleanTiers(body.swift.tiers, commissionTier, 'حوالات سويفت'),
        fixedFee: num(body.swift.fixedFee, { max: 1e5 }),
        minFee: num(body.swift.minFee, { max: 1e5 }),
      };
      update.swift.pricesUpdatedAt = stamp(PRICE_FIELDS.swift(current.swift), PRICE_FIELDS.swift(update.swift), current.swift?.pricesUpdatedAt);
    }

    if (body.fcl) {
      const before = new Map((current.fcl?.containers || []).map((c) => [c.key, c]));
      // Several shipping lines per container type and route, so room for more rows than before
      const containers = (Array.isArray(body.fcl.containers) ? body.fcl.containers : []).slice(0, 40).map((c, i) => {
        const row = {
          key: text(c.key, 40) || `container-${i + 1}`,
          label: text(c.label, 60),
          carrier: text(c.carrier, 60),
          fromPort: text(c.fromPort, 60),
          toPort: text(c.toPort, 60),
          route: text(c.route, 80),
          price: num(c.price, { max: 1e6 }),
          duration: text(c.duration, 60),
          visible: bool(c.visible),
        };
        const old = before.get(row.key);
        row.pricesUpdatedAt = old ? stamp(containerPrices(old), containerPrices(row), old.pricesUpdatedAt) : now;
        return row;
      }).filter((c) => c.label);
      if (new Set(containers.map((c) => c.key)).size !== containers.length) throw fail('حاويتان بنفس المعرّف، أعد تحميل الصفحة ثم احفظ');
      update.fcl = { visible: bool(body.fcl.visible), note: text(body.fcl.note), containers };
    }

    if (body.offices) {
      const offices = (Array.isArray(body.offices) ? body.offices : []).slice(0, 6).map((o, i) => ({
        key: text(o.key, 40) || `office-${i + 1}`,
        label: text(o.label, 60),
        whatsapp: digits(o.whatsapp),
        cities: (Array.isArray(o.cities) ? o.cities : String(o.cities || '').split(',')).map((c) => text(c, 40)).filter(Boolean).slice(0, 10),
      })).filter((o) => o.label);
      if (offices.some((o) => o.whatsapp.length < 9)) throw fail('رقم واتساب غير صالح: اكتبه بالصيغة الدولية مثل 218915643265');
      update.offices = offices;
    }

    for (const p of priceUpdates) {
      await ShipmentPrices.updateOne({ country: p.country, shippingType: p.shippingType }, { $set: { sellingPrice: p.price } });
    }
    for (const m of messageUpdates) {
      const [country, shippingType] = m.key.split('-');
      await ShipmentPrices.updateOne({ country, shippingType }, { $set: { priceDescription: m.message } });
    }
    await PricingConfig.updateOne({ _id: current._id }, { $set: { ...update, updatedBy: req.user?._id } });
    return module.exports.getConfig(req, res, next);
  } catch (error) {
    return next(error.statusCode ? error : new ErrorHandler(500, error.message));
  }
};
