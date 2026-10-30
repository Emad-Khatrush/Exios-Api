const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A sales-team goal for one office: a weekly or monthly target for one metric, with the dinars the
// team earns when it is reached. Changing a goal adds a version that starts with the current week or
// month, so past periods keep being scored against the goal that was in force then.
const salesGoalSchema = new Schema({
  office: { type: String, required: true, enum: ['tripoli', 'benghazi'] },
  // The goods the goal counts, by where they were shipped from (the trip). China only for now.
  country: { type: String, enum: ['CN'], default: 'CN' },
  // sales: USD invoiced; air: KG; lcl: CBM shared sea freight; fcl: full containers (count)
  metric: { type: String, required: true, enum: ['sales', 'air', 'lcl', 'fcl'] },
  period: { type: String, required: true, enum: ['week', 'month'] },
  target: { type: Number, required: true, min: 0 },
  incentiveLYD: { type: Number, default: 0, min: 0 },
  // Start of the week or month this version applies from (Libya time)
  effectiveFrom: { type: Date, required: true },
  setBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

salesGoalSchema.index({ office: 1, country: 1, metric: 1, period: 1, effectiveFrom: 1 }, { unique: true });

module.exports = mongoose.model('SalesGoal', salesGoalSchema);
