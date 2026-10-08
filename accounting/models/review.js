const mongoose = require('mongoose');
const { Schema } = mongoose;
const ReviewTask = mongoose.model('AccountingReviewTask', new Schema({
  key: { type: String, unique: true, required: true }, fingerprint: String,
  state: { type: String, enum: ['open', 'deferred', 'independent'], default: 'open' },
  reason: String, assignee: { type: Schema.Types.ObjectId, ref: 'User' }, dueDay: String,
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
const CostReview = mongoose.model('AccountingCostReview', new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', unique: true, required: true },
  fingerprint: String, reason: String, zeroCost: Boolean,
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date,
}, { timestamps: true }));
const PeriodApproval = mongoose.model('AccountingPeriodApproval', new Schema({
  month: { type: String, unique: true, required: true }, fingerprint: String,
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, approvedAt: Date,
}, { timestamps: true }));
const TripCostReview = mongoose.model('AccountingTripCostReview', new Schema({
  tripId: { type: Schema.Types.ObjectId, ref: 'Inventory', unique: true, required: true },
  fingerprint: String, reason: String, zeroCost: Boolean, reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date,
}, { timestamps: true }));
const BankMonthReview = mongoose.model('AccountingBankMonthReview', new Schema({
  key: { type: String, unique: true }, accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' }, month: String,
  statementBalance: Number, fingerprint: String, note: String, reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date,
}, { timestamps: true }));
module.exports = { ReviewTask, CostReview, TripCostReview, PeriodApproval, BankMonthReview };
