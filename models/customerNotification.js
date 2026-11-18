const mongoose = require('mongoose');

// What the client app's notifications page lists (owner's request 2026-11-19): every message sent
// to customers (a shipment moved on, points, a new level, a stopped shipment, an announcement),
// saved whether or not it also reached a phone, so it can be read again later.
// user: the customer; null: every customer (an announcement from the office).
// Read state is one time per customer (User.notificationsSeenAt): what came after it is unread.
// Kept 120 days, then MongoDB removes it by itself.
const KEEP_DAYS = 120;

const customerNotificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  title: { type: String, required: true, maxlength: 200 },
  body: { type: String, default: '', maxlength: 1000 },
  url: { type: String, default: '/home', maxlength: 300 },
  tag: { type: String, default: '', maxlength: 100 },
  createdAt: { type: Date, default: Date.now },
});

customerNotificationSchema.index({ user: 1, createdAt: -1 });
customerNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('CustomerNotification', customerNotificationSchema);
module.exports.KEEP_DAYS = KEEP_DAYS;
