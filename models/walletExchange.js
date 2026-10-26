const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  idempotencyKey: { type: String, required: true, immutable: true },
  fromCurrency: { type: String, enum: ['USD', 'LYD'], required: true, immutable: true },
  toCurrency: { type: String, enum: ['USD', 'LYD'], required: true, immutable: true },
  fromMinor: { type: Number, required: true, immutable: true },
  toMinor: { type: Number, required: true, immutable: true },
  // Always LYD for one USD, in either direction. Native amounts are cents.
  rate: { type: String, required: true, immutable: true },
  pricingMode: { type: String, enum: ['rate', 'received'], default: 'rate', immutable: true },
  day: { type: String, required: true, immutable: true },
  effectiveAt: { type: Date, required: true, immutable: true },
  note: { type: String, default: '', immutable: true },
  office: { type: String, immutable: true },
  fromStatementId: { type: Schema.Types.ObjectId, ref: 'UserStatement' },
  toStatementId: { type: Schema.Types.ObjectId, ref: 'UserStatement' },
  posting: {
    status: { type: String, enum: ['pending', 'posted'], default: 'pending' },
    entryId: Schema.Types.ObjectId,
  },
}, { timestamps: true });
schema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ user: 1, effectiveAt: -1 });
module.exports = mongoose.model('WalletExchange', schema);
