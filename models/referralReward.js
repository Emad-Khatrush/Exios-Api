const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// An invite-a-friend reward for the inviter (spec 2026-11-20-referrals-design.md). Every reward waits
// 24 hours (`releaseAt`, owner 2026-11-20): then the hourly job gives it as a loyalty add when the
// friend's order behind it was neither changed nor cancelled, else cancels it. A reward given and
// whose order is cancelled later is taken back (`revoked`).
const referralRewardSchema = new Schema({
  inviter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // The friend it comes from (none for a step: it comes from all the friends)
  friend: { type: Schema.Types.ObjectId, ref: 'User' },
  kind: { type: String, enum: ['first', 'share', 'step'], required: true },
  points: { type: Number, required: true, min: 1 },
  // Points that count toward the inviter's level (the share only)
  levelPoints: Number,
  reason: String,
  // The friend's earn (and its order) that brought it: a first reward or a share
  sourceEarn: { type: Schema.Types.ObjectId, ref: 'LoyaltyPoint' },
  sourceOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
  // A step: how many friends, and whether it makes an ambassador
  step: { _id: false, friends: Number, usd: Number, title: String, ambassador: Boolean },
  // The loyalty add's eventKey once given (a cancelled reward gets a new one, so it can come again)
  eventKey: { type: String, required: true, unique: true },
  releaseAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'granted', 'canceled', 'revoked'], default: 'pending' },
  lotId: { type: Schema.Types.ObjectId, ref: 'LoyaltyPoint' },
  // A step reward waits for staff (owner, 2026-11-20): who approved it, and when
  approvedAt: Date,
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  grantedAt: Date,
  canceledAt: Date,
  cancelReason: String,
}, { timestamps: { createdAt: true, updatedAt: false } });

referralRewardSchema.index({ status: 1, releaseAt: 1 });
referralRewardSchema.index({ inviter: 1, status: 1 });
referralRewardSchema.index({ sourceOrder: 1, status: 1 });

module.exports = mongoose.model('ReferralReward', referralRewardSchema);
