const mongoose = require('mongoose');

// One row per device a customer uses the client app on (the visitor id the app keeps in
// localStorage). Tells whether it is installed (opened from the home screen), when it was first and
// last opened that way, and whether notifications are on. Browsers never say when an app is
// removed: a device not opened as an app for a while (see appUsage.ACTIVE_DAYS) counts as no longer
// using it.
const appDeviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, maxlength: 100 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  platform: { type: String, enum: ['ios', 'android', 'desktop'], default: 'desktop' },
  browser: { type: String, default: '' },
  // Opened from the home screen icon (installed) on its last visit
  standalone: { type: Boolean, default: false },
  firstAppAt: Date,
  lastAppAt: Date,
  lastSeenAt: { type: Date, default: Date.now },
  push: { type: Boolean, default: false },
  userAgent: { type: String, maxlength: 400, default: '' },
}, { timestamps: true });

appDeviceSchema.index({ lastAppAt: -1 });
appDeviceSchema.index({ firstAppAt: 1 });

module.exports = mongoose.model('AppDevice', appDeviceSchema);
