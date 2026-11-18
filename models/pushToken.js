const mongoose = require('mongoose');

// One row per device that turned notifications on in the client app (a phone, a browser).
// The token is what Firebase Cloud Messaging sends to; a customer can have several devices.
const pushTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token: { type: String, required: true, unique: true },
  userAgent: { type: String, maxlength: 400, default: '' },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('PushToken', pushTokenSchema);
