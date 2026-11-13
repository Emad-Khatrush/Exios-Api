const express = require('express');
const {
  getPopupAds,
  createPopupAd,
  updatePopupAd,
  deletePopupAd,
  getPopupAdViewers,
  getActivePopupAdsForClient,
  acknowledgePopupAd,
} = require('../controllers/popupAds');
const { protect, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router = express.Router();

// Client-facing: ads in their active window that this customer hasn't acknowledged.
router.route('/popupAds/active')
      .get(protect, getActivePopupAdsForClient);

router.route('/popupAds/:id/acknowledge')
      .post(protect, acknowledgePopupAd);

// Admin management.
router.route('/popupAds')
      .get(protect, allow(['settings_content'], isAdmin), getPopupAds)
      .post(protect, allow(['settings_content'], isAdmin), createPopupAd);

router.route('/popupAds/:id')
      .put(protect, allow(['settings_content'], isAdmin), updatePopupAd)
      .delete(protect, allow(['settings_content'], isAdmin), deletePopupAd);

router.route('/popupAds/:id/viewers')
      .get(protect, allow(['settings_content'], isAdmin), getPopupAdViewers);

module.exports = router;
