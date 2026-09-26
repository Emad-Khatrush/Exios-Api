const mongoose = require('mongoose');

// A WhatsApp broadcast sent to a snapshot of clients. The `users` list is
// captured at send time (not re-queried later) so the campaign stays an
// accurate record of who was actually targeted, even if the client list
// changes afterwards. Per-user status is updated live by the send-message
// queue worker in app.js as each message goes out.
const campaignSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    imgUrl: {
      type: String,
      default: null,
    },
    target: {
      type: String,
      enum: ['allUsers', 'onlyNewClients'],
      required: true,
    },
    status: {
      type: String,
      enum: ['sending', 'completed', 'cancelled'],
      default: 'sending',
    },
    totalUsers: {
      type: Number,
      required: true,
    },
    sentCount: {
      type: Number,
      default: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
    },
    users: [{
      _id: false,
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      firstName: String,
      lastName: String,
      phone: String,
      customerId: String,
      status: {
        type: String,
        enum: ['pending', 'sent', 'failed', 'cancelled'],
        default: 'pending',
      },
      sentAt: Date,
    }],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

campaignSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Campaign', campaignSchema);
