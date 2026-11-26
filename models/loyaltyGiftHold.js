const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A sign-up or invite-welcome gift waiting for the customer's first paid order (owner, 2026-11-27).
// Many open an account and never ship, so a gift booked at sign-up was a liability that would never
// be claimed. While waiting it is only shown to the customer: no points, no journal entry. When the
// customer first earns points (an order paid in full) the hourly job gives it as a normal loyalty
// 'add' lot (eventKey `${eventKey}:R`); after GIFT_HOLD_DAYS without one it lapses.
const loyaltyGiftHoldSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  points: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true },
  // SIGNUP_GIFT:<user> or REFERRAL_WELCOME:<user>: one hold per gift, ever
  eventKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'granted', 'expired', 'canceled'], default: 'pending' },
  expiresAt: { type: Date, required: true },
  grantedAt: Date,
  lotId: { type: Schema.Types.ObjectId, ref: 'LoyaltyPoint' },
  endedAt: Date,
}, { timestamps: true });

loyaltyGiftHoldSchema.index({ status: 1, user: 1 });

module.exports = mongoose.model('LoyaltyGiftHold', loyaltyGiftHoldSchema);
