const PopupAd = require('../models/popupAd');
const { POPUP_AD_ICONS } = require('../constants/popupAdIcons');
const ErrorHandler = require('../utils/errorHandler');

const getStatus = (ad) => {
  const now = new Date();
  if (now < ad.startDate) return 'upcoming';
  if (now > ad.endDate) return 'expired';
  return 'active';
};

// Admin: list every popup ad with a computed status and a view count.
// The full viewer list (with names) is fetched separately, on demand - see getPopupAdViewers.
module.exports.getPopupAds = async (req, res, next) => {
  try {
    const ads = await PopupAd.find({}).sort({ startDate: -1 });
    res.status(200).json(ads.map((ad) => {
      const obj = ad.toObject();
      const viewCount = obj.viewedBy?.length || 0;
      delete obj.viewedBy;
      return { ...obj, status: getStatus(ad), viewCount };
    }));
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Admin: who viewed this ad and when, most recent first.
module.exports.getPopupAdViewers = async (req, res, next) => {
  try {
    const { id } = req.params;
    const ad = await PopupAd.findById(id)
      .select('viewedBy')
      .populate('viewedBy.user', 'firstName lastName phone customerId');

    if (!ad) {
      return next(new ErrorHandler(404, 'Popup ad not found'));
    }

    const viewers = ad.viewedBy
      .filter((entry) => entry.user)
      .sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt))
      .map((entry) => ({ user: entry.user, viewedAt: entry.viewedAt }));

    res.status(200).json(viewers);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.createPopupAd = async (req, res, next) => {
  try {
    const { description, imageUrl, icon, startDate, endDate } = req.body;

    if (!description || !String(description).trim()) {
      return next(new ErrorHandler(400, 'Description is required'));
    }
    if (!startDate || !endDate) {
      return next(new ErrorHandler(400, 'Start date and end date are required'));
    }
    if (new Date(endDate) < new Date(startDate)) {
      return next(new ErrorHandler(400, 'End date must be after the start date'));
    }
    if (icon && !POPUP_AD_ICONS.includes(icon)) {
      return next(new ErrorHandler(400, 'Unknown icon'));
    }

    const ad = await PopupAd.create({
      description: String(description).trim(),
      imageUrl: imageUrl ? String(imageUrl).trim() : null,
      icon: imageUrl ? undefined : (icon || 'megaphone'),
      startDate,
      endDate,
    });

    res.status(201).json({ ...ad.toObject(), status: getStatus(ad) });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.updatePopupAd = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { description, imageUrl, icon, startDate, endDate } = req.body;

    if (description !== undefined && !String(description).trim()) {
      return next(new ErrorHandler(400, 'Description is required'));
    }
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      return next(new ErrorHandler(400, 'End date must be after the start date'));
    }
    if (icon && !POPUP_AD_ICONS.includes(icon)) {
      return next(new ErrorHandler(400, 'Unknown icon'));
    }

    const update = {};
    if (description !== undefined) update.description = String(description).trim();
    if (startDate !== undefined) update.startDate = startDate;
    if (endDate !== undefined) update.endDate = endDate;
    if (imageUrl !== undefined) {
      update.imageUrl = imageUrl ? String(imageUrl).trim() : null;
      // Switching to a photo drops the icon; switching back to icon-only needs one supplied.
      update.icon = imageUrl ? undefined : (icon || 'megaphone');
    } else if (icon !== undefined) {
      update.icon = icon;
    }

    const ad = await PopupAd.findByIdAndUpdate(id, update, { new: true });
    if (!ad) {
      return next(new ErrorHandler(404, 'Popup ad not found'));
    }

    res.status(200).json({ ...ad.toObject(), status: getStatus(ad) });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.deletePopupAd = async (req, res, next) => {
  try {
    const { id } = req.params;
    const ad = await PopupAd.findByIdAndDelete(id);
    if (!ad) {
      return next(new ErrorHandler(404, 'Popup ad not found'));
    }
    res.status(200).json({ message: 'Popup ad deleted' });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Client: ads currently inside their date window that this customer hasn't acknowledged yet.
module.exports.getActivePopupAdsForClient = async (req, res, next) => {
  try {
    const now = new Date();
    const ads = await PopupAd.find({
      startDate: { $lte: now },
      endDate: { $gte: now },
      'viewedBy.user': { $ne: req.user._id },
    }).sort({ startDate: 1 });

    res.status(200).json(ads);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.acknowledgePopupAd = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Only push when this customer isn't already recorded, so re-acknowledging
    // (e.g. a retry after a network error) never creates duplicate entries or
    // overwrites the original viewedAt.
    const updated = await PopupAd.findOneAndUpdate(
      { _id: id, 'viewedBy.user': { $ne: req.user._id } },
      { $push: { viewedBy: { user: req.user._id, viewedAt: new Date() } } },
      { new: true }
    );

    if (!updated) {
      const exists = await PopupAd.exists({ _id: id });
      if (!exists) {
        return next(new ErrorHandler(404, 'Popup ad not found'));
      }
      // Already acknowledged by this customer - treat as success (idempotent).
    }

    res.status(200).json({ message: 'Acknowledged' });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};
