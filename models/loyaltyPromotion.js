const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A points offer (spec 2026-11-19-loyalty-promotions-design.md): orders created between `startsAt`
// and `endsAt` (Libya days, end exclusive) on the chosen kinds, methods and countries earn
// `multiplierPct` (200 = ×2) instead of the level's multiplier, when it is higher.
const loyaltyPromotionSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  multiplierPct: { type: Number, required: true, min: 110, max: 500 },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  kinds: [{ type: String, enum: ['shipping', 'purchase', 'remittance'] }],
  // Shipping claims only; empty = every method / every country
  methods: [{ type: String, enum: ['air', 'sea'] }],
  countries: [String],
  // From this Libya midnight customers see it coming (a countdown to its start); none = seen from the start
  announceAt: Date,
  notify: { type: Boolean, default: true },
  notifiedAt: Date,
  // When customers were told it is coming (the announcement); notifiedAt is the start
  announcedAt: Date,
  endedEarlyAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

loyaltyPromotionSchema.index({ startsAt: 1, endsAt: 1 });

module.exports = mongoose.model('LoyaltyPromotion', loyaltyPromotionSchema);
