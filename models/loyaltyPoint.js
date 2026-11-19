const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// One movement of a customer's loyalty points (spec 2026-11-16). Earned and added points are
// lots (`remaining`, `expiresAt`); spending, deducting, expiring and taking back name the lots
// they used (`sources`, oldest first). `eventKey` makes every movement happen once.
const loyaltyPointSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['earn', 'add', 'restore', 'redeem', 'deduct', 'expire', 'revoke'], required: true },
  points: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'points must be a whole number' } },
  // An earn only: the points before the level's multiplier (what counts toward the level) and the
  // level the customer had when it was earned
  basePoints: Number,
  tier: String,
  // An earn only: the points offer that decided the multiplier (spec 2026-11-19), when one did
  promotion: { _id: false, id: { type: Schema.Types.ObjectId, ref: 'LoyaltyPromotion' }, name: String, multiplierPct: Number },
  arKey: String,
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  office: String,
  earnedAt: Date,
  expiresAt: Date,
  // Lots only (earn, add, restore): what is still left to spend
  remaining: { type: Number, min: 0, validate: { validator: (v) => v === undefined || v === null || Number.isInteger(v), message: 'remaining must be a whole number' } },
  sources: [{ _id: false, lotId: { type: Schema.Types.ObjectId, ref: 'LoyaltyPoint' }, points: Number }],
  eventKey: { type: String, required: true, unique: true },
  journalEntryId: { type: Schema.Types.ObjectId },
  reason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  // A redeem movement staff cancelled (its points came back): when, by whom and why
  canceledAt: Date,
  canceledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelReason: String,
}, { timestamps: { createdAt: true, updatedAt: false } });

loyaltyPointSchema.index({ user: 1, expiresAt: 1 });
loyaltyPointSchema.index({ arKey: 1 });
loyaltyPointSchema.index({ orderId: 1 });

module.exports = mongoose.model('LoyaltyPoint', loyaltyPointSchema);
