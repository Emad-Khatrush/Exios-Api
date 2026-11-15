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

const pricingConfigSchema = new Schema({
  key: { type: String, default: 'main', unique: true },

  // The rate itself is the accounting/settings rate (ExchangeRate); this only shows or hides it
  exchangeRate: {
    visible: { type: Boolean, default: true },
  },

  shipping: {
    visible: { type: Boolean, default: true },
    note: { type: String, default: '' },
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
    minCommission: { type: Number, default: 10 },
    // When its prices (not the note or visibility) last changed, shown to customers. Same in
    // alipay and swift.
    pricesUpdatedAt: Date,
    // { upTo, type: 'fixed' | 'percent', value }
    tiers: { type: [tier], default: undefined },
    // Fees the shopping site itself adds, e.g. Alibaba 3%
    sites: [{ _id: false, key: String, label: String, feePercent: { type: Number, default: 0 } }],
  },

  alipay: {
    visible: { type: Boolean, default: false },
    note: { type: String, default: '' },
    // { upTo (yuan), rate (yuan for 1 USD), fee (USD added to the transfer) }
    tiers: { type: [tier], default: undefined },
    pricesUpdatedAt: Date,
  },

  swift: {
    visible: { type: Boolean, default: false },
    note: { type: String, default: '' },
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
