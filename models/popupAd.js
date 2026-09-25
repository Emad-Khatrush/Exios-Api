const mongoose = require('mongoose');
const { POPUP_AD_ICONS } = require('../constants/popupAdIcons');

// A customer-facing popup ad. Shown as a non-dismissible dialog until the
// customer acknowledges it (see popupAds controller). Active window is driven
// entirely by startDate/endDate, there is no separate "isActive" toggle.
const popupAdSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
      trim: true,
    },
    imageUrl: {
      type: String,
      default: null,
      trim: true,
    },
    icon: {
      type: String,
      enum: POPUP_AD_ICONS,
      default: 'megaphone',
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    // Customers who already acknowledged this ad - excluded from future fetches
    // so a swapped-through ad never comes back for the same customer. Kept with
    // a timestamp so the admin can see who viewed an ad and when.
    viewedBy: [{
      _id: false,
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      viewedAt: {
        type: Date,
        default: Date.now,
      },
    }],
  },
  { timestamps: true }
);

popupAdSchema.index({ startDate: 1, endDate: 1 });

module.exports = mongoose.model('PopupAd', popupAdSchema);
