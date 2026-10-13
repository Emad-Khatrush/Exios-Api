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
// Daily work: the accountant counts each cash box, marks the day's unusual operations and closes the
// day with a saved report. A day may be closed several times (version 1, 2, ...); nothing is locked.
const CashTally = mongoose.model('AccountingCashTally', new Schema({
  day: { type: String, required: true }, accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  // Minor units of the account currency
  expected: Number, counted: Number, difference: Number, note: String,
  status: { type: String, enum: ['matched', 'difference', 'explained', 'adopted'], required: true },
  cashCountId: { type: Schema.Types.ObjectId, ref: 'AccountingCashCount' },
  countedBy: { type: Schema.Types.ObjectId, ref: 'User' }, resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, resolvedAt: Date,
}, { timestamps: true }).index({ day: 1, accountId: 1 }, { unique: true }));
const DailyItemReview = mongoose.model('AccountingDailyItemReview', new Schema({
  key: { type: String, unique: true, required: true }, day: String,
  state: { type: String, enum: ['ok', 'issue'], required: true }, note: String, title: String, url: String,
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, resolvedAt: Date,
}, { timestamps: true }));
const DailyClose = mongoose.model('AccountingDailyClose', new Schema({
  day: { type: String, required: true }, version: { type: Number, required: true }, note: String,
  closedBy: { type: Schema.Types.ObjectId, ref: 'User' }, report: Schema.Types.Mixed,
}, { timestamps: true }).index({ day: 1, version: 1 }, { unique: true }));
module.exports = { ReviewTask, CostReview, TripCostReview, PeriodApproval, BankMonthReview, CashTally, DailyItemReview, DailyClose };
