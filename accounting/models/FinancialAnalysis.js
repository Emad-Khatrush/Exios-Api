const mongoose = require('mongoose');
const { Schema } = mongoose;
const Settings = mongoose.model('AccountingAnalysisSettings', new Schema({
  key: { type: String, unique: true, default: 'main' },
  reliableFrom: String,
  classifications: [{ _id: false, accountId: Schema.Types.ObjectId, category: String }],
  costBehavior: [{ _id: false, accountId: Schema.Types.ObjectId, behavior: String }],
  version: { type: Number, default: 0 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
const periodSchema = new Schema({
  from: { type: String, required: true }, to: { type: String, required: true },
  budget: [{ _id: false, accountId: Schema.Types.ObjectId, amount: Number }],
  // Optional measured activity totals, USD cents. These are analytical inputs, not journal entries.
  creditSales: Number, creditPurchases: Number, inventoryCost: Number, interestExpense: Number,
  notes: String,
  version: { type: Number, default: 0 }, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
periodSchema.index({ from: 1, to: 1 }, { unique: true });
const Period = mongoose.model('AccountingAnalysisPeriod', periodSchema);
module.exports = { Settings, Period };
