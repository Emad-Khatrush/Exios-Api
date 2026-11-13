// The customer Prices page (Exios-Client) and its settings (admin: Settings > Customer prices).
// - GET  /pricing         public: only what is visible, shipping prices merged in from ShipmentPrice
// - GET  /pricing/config  staff with settings_prices: everything, hidden parts included
// - PUT  /pricing/config  same: saves the page and the shipping price of each route
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
  swift: { visible: false, note: '', percent: 0, fixedFee: 0, minFee: 0 },
  fcl: {
    visible: false,
    note: '',
    containers: [
      { key: '20ft', label: "حاوية 20 قدم", route: 'الصين إلى طرابلس', price: 0, duration: '', visible: true },
      { key: '40ft', label: "حاوية 40 قدم", route: 'الصين إلى طرابلس', price: 0, duration: '', visible: true },
      { key: '40hq', label: "حاوية 40 قدم عالية (HQ)", route: 'الصين إلى طرابلس', price: 0, duration: '', visible: true },
    ],
  },
  offices: [
    // cities: the account city values (Exios-Client src/constants/info.ts) this office serves
    { key: 'tripoli', label: 'مكتب طرابلس', whatsapp: '218915643265', cities: ['tripoli', 'misrata', 'zawiya', 'zliten', 'sabratha', 'sabha'] },
    { key: 'benghazi', label: 'مكتب بنغازي', whatsapp: '218919734019', cities: ['benghazi', 'bayda', 'tobruk', 'ajdabiya', 'derna', 'kufra'] },
  ],
};

const routeKey = (price) => `${price.country}-${price.shippingType}`;
const orderOf = (key) => { const i = ROUTE_ORDER.indexOf(key); return i < 0 ? 99 : i; };

async function loadConfig() {
  let config = await PricingConfig.findOne({ key: 'main' }).lean();
  if (!config) {
    await PricingConfig.updateOne({ key: 'main' }, { $setOnInsert: DEFAULTS }, { upsert: true });
    config = await PricingConfig.findOne({ key: 'main' }).lean();
  }
  return config;
}

// Every shipping route there is a price for, with how it is shown
async function shippingRoutes(config) {
  const prices = await ShipmentPrices.find({}).lean();
  const shown = new Map((config.shipping?.routes || []).map((r) => [r.key, r]));
  return prices
    .map((price) => {
      const key = routeKey(price);
      const display = shown.get(key) || {};
      return {
        key,
        country: price.country,
        method: price.shippingType,
        label: `${METHOD_LABELS[price.shippingType] || price.shippingType} من ${COUNTRY_LABELS[price.country] || price.country}`,
        countryLabel: COUNTRY_LABELS[price.country] || price.country,
        unit: price.shippingType === 'sea' ? 'cbm' : 'kg',
        price: Number(price.sellingPrice) || 0,
        visible: display.visible !== false,
        duration: display.duration ?? DEFAULT_DURATIONS[key] ?? '',
        // The free text the office wrote for this route before (ShipmentPrice.priceDescription)
        note: display.note ?? price.priceDescription ?? '',
        minCharge: Number(display.minCharge) || 0,
      };
    })
    .sort((a, b) => orderOf(a.key) - orderOf(b.key));
}

async function currentRate() {
  const rate = await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean();
  return rate ? { rate: rate.rate, updatedAt: rate.updatedAt } : null;
}

module.exports.getPublic = async (req, res, next) => {
  try {
    const config = await loadConfig();
    const routes = (await shippingRoutes(config)).filter((r) => r.visible && r.price > 0);
    const visible = (section) => !!config[section]?.visible;
    res.status(200).json({
      exchangeRate: config.exchangeRate?.visible ? await currentRate() : null,
      shipping: visible('shipping') && routes.length ? {
        note: config.shipping.note || '',
        volumetricDivisor: config.shipping.volumetricDivisor || 6000,
        routes: routes.map(({ visible: _v, ...route }) => route),
      } : null,
      purchase: visible('purchase') ? {
        note: config.purchase.note || '',
        minCommission: config.purchase.minCommission || 0,
        tiers: config.purchase.tiers || [],
        sites: config.purchase.sites || [],
      } : null,
      alipay: visible('alipay') && (config.alipay.tiers || []).some((t) => t.rate > 0) ? {
        note: config.alipay.note || '',
        tiers: (config.alipay.tiers || []).filter((t) => t.rate > 0),
      } : null,
      swift: visible('swift') ? {
        note: config.swift.note || '',
        percent: config.swift.percent || 0,
        fixedFee: config.swift.fixedFee || 0,
        minFee: config.swift.minFee || 0,
      } : null,
      fcl: visible('fcl') && (config.fcl.containers || []).some((c) => c.visible !== false && c.price > 0) ? {
        note: config.fcl.note || '',
        containers: config.fcl.containers.filter((c) => c.visible !== false && c.price > 0),
      } : null,
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
      shipping: { ...config.shipping, routes: await shippingRoutes(config) },
      exchangeRate: { visible: config.exchangeRate?.visible !== false, current: await currentRate() },
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

const digits = (value) => String(value ?? '').replace(/\D/g, '').slice(0, 15);

module.exports.saveConfig = async (req, res, next) => {
  try {
    const body = req.body || {};
    const current = await loadConfig();
    const update = {};

    if (body.exchangeRate) update.exchangeRate = { visible: bool(body.exchangeRate.visible) };

    // Shipping: how each route is shown here, its price in ShipmentPrice
    let priceUpdates = [];
    if (body.shipping) {
      const known = new Set((await ShipmentPrices.find({}).lean()).map(routeKey));
      const routes = (Array.isArray(body.shipping.routes) ? body.shipping.routes : []).filter((r) => known.has(r.key));
      update.shipping = {
        visible: bool(body.shipping.visible),
        note: text(body.shipping.note),
        volumetricDivisor: num(body.shipping.volumetricDivisor, { min: 1000, max: 10000 }) || 6000,
        routes: routes.map((r) => ({ key: r.key, visible: bool(r.visible), duration: text(r.duration, 60), note: text(r.note), minCharge: num(r.minCharge) })),
      };
      priceUpdates = routes.filter((r) => r.price !== undefined).map((r) => {
        const [country, shippingType] = r.key.split('-');
        const price = num(r.price, { max: 100000 });
        if (!(price > 0)) throw fail(`سعر ${r.key} يجب أن يكون أكبر من صفر`);
        return { country, shippingType, price };
      });
    }

    if (body.purchase) {
      const sites = (Array.isArray(body.purchase.sites) ? body.purchase.sites : []).slice(0, 12)
        .map((s, i) => ({ key: text(s.key, 40) || `site-${i + 1}`, label: text(s.label, 40), feePercent: num(s.feePercent, { max: 100 }) }))
        .filter((s) => s.label);
      update.purchase = {
        visible: bool(body.purchase.visible),
        note: text(body.purchase.note),
        minCommission: num(body.purchase.minCommission),
        tiers: cleanTiers(body.purchase.tiers, (t) => ({ type: t.type === 'fixed' ? 'fixed' : 'percent', value: num(t.value, { max: t.type === 'fixed' ? 1e6 : 100 }) }), 'عمولات الشراء'),
        sites,
      };
    }

    if (body.alipay) {
      const tiers = cleanTiers(body.alipay.tiers, (t) => ({ rate: num(t.rate, { max: 100 }), fee: num(t.fee, { max: 1e5 }) }), 'حوالات علي باي');
      if (bool(body.alipay.visible) && tiers.some((t) => !(t.rate > 0))) throw fail('ضع سعر اليوان لكل شريحة في علي باي قبل إظهارها للعملاء');
      update.alipay = { visible: bool(body.alipay.visible), note: text(body.alipay.note), tiers };
    }

    if (body.swift) {
      update.swift = {
        visible: bool(body.swift.visible),
        note: text(body.swift.note),
        percent: num(body.swift.percent, { max: 100 }),
        fixedFee: num(body.swift.fixedFee, { max: 1e5 }),
        minFee: num(body.swift.minFee, { max: 1e5 }),
      };
    }

    if (body.fcl) {
      const containers = (Array.isArray(body.fcl.containers) ? body.fcl.containers : []).slice(0, 12).map((c, i) => ({
        key: text(c.key, 40) || `container-${i + 1}`,
        label: text(c.label, 60),
        route: text(c.route, 80),
        price: num(c.price, { max: 1e6 }),
        duration: text(c.duration, 60),
        visible: bool(c.visible),
      })).filter((c) => c.label);
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
    await PricingConfig.updateOne({ _id: current._id }, { $set: { ...update, updatedBy: req.user?._id } });
    return module.exports.getConfig(req, res, next);
  } catch (error) {
    return next(error.statusCode ? error : new ErrorHandler(500, error.message));
  }
};
