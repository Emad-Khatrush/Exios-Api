const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Everything the customer Prices page shows, set in the admin (Settings > Customer prices). One
// document. The shipping price of each route is NOT stored here: it stays in ShipmentPrice, which
// invoices also read, so there is one price per route; this only says how the route is shown.
// Amounts are USD. Each section can be hidden from customers.
// A price bracket. upTo is its upper bound (inclusive), null = and above; brackets are kept sorted.
// Purchase brackets use type + value, Alipay brackets use rate + fee.
const tier = new Schema({
  upTo: { type: Number, default: null },
  type: { type: String, enum: ['fixed', 'percent'] },
  value: Number,
  rate: Number,
  fee: Number,
}, { _id: false });

// What a customer pays on top, in Libyan qirsh (1/100 dinar) for each dollar of the total, by where
// they pay: at the office in Libya or in Turkey (owner 2026-11-25). E.g. a $100 invoice at 10 qirsh
// = $100 + 10 LYD. Each section has its own two; 0 = nothing added.
const delivery = new Schema({
  libya: { type: Number, default: 0 },
  turkey: { type: Number, default: 0 },
}, { _id: false });

const pricingConfigSchema = new Schema({
  key: { type: String, default: 'main', unique: true },

  // The dollar rate customers see on the Prices page (owner 2026-11-24: for customers only; the
  // accounting rate is set in accounting and is not touched from here). Until one is set, the
  // accounting rate (ExchangeRate) is shown.
  exchangeRate: {
    visible: { type: Boolean, default: true },
    rate: { type: Number, default: 0 },
    rateUpdatedAt: Date,
  },

  shipping: {
    visible: { type: Boolean, default: true },
    note: { type: String, default: '' },
    delivery: { type: delivery, default: () => ({}) },
    // Air volumetric weight = L x W x H (cm) / divisor. 6000 is CBM x 167, as accounting bills it
    volumetricDivisor: { type: Number, default: 6000 },
    routes: [{
      _id: false,
      key: String, // `${country}-${method}`, matches a ShipmentPrice
      visible: { type: Boolean, default: true },
      duration: { type: String, default: '' },
      note: { type: String, default: '' },
      // Who carries this shared (consolidated) shipping: the shipping line or airline, e.g. COSCO
      carrier: { type: String, default: '' },
      minCharge: { type: Number, default: 0 },
      // The least weight (kg, air) or volume (CBM, sea) billed for a shipment; 0 = none
      minWeight: { type: Number, default: 0 },
      // When a price of this route (a kind's price or the minimum charge) last changed. The base
      // price's own change time is ShipmentPrice.updatedAt; customers see the later of the two.
      pricesUpdatedAt: Date,
      // Price by kind of goods (regular, cosmetics and brands, medical...). The first is the
      // route's base price: it is read from and saved to ShipmentPrice, the one invoices use.
      // A category without a price is not shown to customers.
      categories: [{ _id: false, key: String, label: String, price: { type: Number, default: 0 } }],
    }],
  },

  purchase: {
    visible: { type: Boolean, default: true },
    note: { type: String, default: '' },
    delivery: { type: delivery, default: () => ({}) },
    minCommission: { type: Number, default: 10 },
    // When its prices (not the note or visibility) last changed, shown to customers. Same in
    // alipay and swift.
    pricesUpdatedAt: Date,
    // { upTo, type: 'fixed' | 'percent', value }
    tiers: { type: [tier], default: undefined },
    // Fees the shopping site itself adds, e.g. Alibaba 3%. A site can also have its own commission
    // in place of the brackets (owner's request 2026-11-24, e.g. Shein: no commission, free shipping):
    // 'default' = the brackets, 'none' = no commission, 'percent' / 'fixed' = commissionValue.
    // freeShipping is shown to customers beside the site.
    sites: [{
      _id: false, key: String, label: String, feePercent: { type: Number, default: 0 },
      commission: { type: String, enum: ['default', 'none', 'percent', 'fixed'], default: 'default' },
      commissionValue: { type: Number, default: 0 },
      freeShipping: { type: Boolean, default: false },
    }],
  },

  alipay: {
    visible: { type: Boolean, default: false },
    note: { type: String, default: '' },
    delivery: { type: delivery, default: () => ({}) },
    // { upTo (yuan), rate (yuan for 1 USD), fee (USD added to the transfer) }
    tiers: { type: [tier], default: undefined },
    pricesUpdatedAt: Date,
  },

  swift: {
    visible: { type: Boolean, default: false },
    note: { type: String, default: '' },
    delivery: { type: delivery, default: () => ({}) },
    // Commission by transfer amount (USD): { upTo, type: 'fixed' | 'percent', value }, like purchases
    tiers: { type: [tier], default: undefined },
    // Older single-rate form, read only to build the first tiers
    percent: { type: Number, default: 0 },
    fixedFee: { type: Number, default: 0 },
    minFee: { type: Number, default: 0 },
    pricesUpdatedAt: Date,
  },

  fcl: {
    visible: { type: Boolean, default: false },
    note: { type: String, default: '' },
    // One offer per row: a container type on a shipping line between two ports, at its price
    containers: [{
      _id: false,
      key: String,
      label: String, // the container type, e.g. 40 ft HQ
      carrier: { type: String, default: '' }, // the shipping line, e.g. MSC
      fromPort: { type: String, default: '' }, // port of loading
      toPort: { type: String, default: '' }, // port of discharge in Libya
      route: { type: String, default: '' }, // older free text, shown when no ports are set
      price: { type: Number, default: 0 },
      duration: { type: String, default: '' },
      visible: { type: Boolean, default: true },
      pricesUpdatedAt: Date,
    }],
  },

  // Where the "send on WhatsApp" button goes; the customer's city picks the office first
  offices: [{
    _id: false,
    key: String,
    label: String,
    whatsapp: String, // international, digits only: 218915643265
    cities: [String],
  }],

  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('PricingConfig', pricingConfigSchema);
