const mongoose = require('mongoose');

// Customer analytics settings (owner 2026-11-27): one document (key 'main') with the targets shown
// beside the analyses and the accounts marked as companies (left out with companies=exclude).
// accounting/services/customerAnalytics/dataset.js reads this collection directly.
const customerAnalyticsSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'main' },
    // { [target key]: number }: rates 0..1, money in US cents, days (see CONTRACT.md)
    targets: { type: mongoose.Schema.Types.Mixed, default: {} },
    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('CustomerAnalyticsSetting', customerAnalyticsSettingSchema, 'customeranalyticssettings');
