const mongoose = require('mongoose');

// One row per page view on Exios-Client (public pages included - landing, login,
// signup - so `user` is null for guests). `sessionId` is a random id the client
// keeps in localStorage, used to count unique visitors without requiring login.
const siteVisitSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      trim: true,
    },
    path: {
      type: String,
      required: true,
      trim: true,
    },
    referrer: {
      type: String,
      default: '',
      trim: true,
    },
    userAgent: {
      type: String,
      default: '',
    },
    device: {
      type: String,
      enum: ['mobile', 'tablet', 'desktop'],
      default: 'desktop',
    },
    browser: {
      type: String,
      default: 'Other',
    },
    ip: {
      type: String,
      default: '',
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

siteVisitSchema.index({ createdAt: -1 });
siteVisitSchema.index({ sessionId: 1, createdAt: -1 });
siteVisitSchema.index({ path: 1 });

module.exports = mongoose.model('SiteVisit', siteVisitSchema);
