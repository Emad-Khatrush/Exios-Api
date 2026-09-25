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

const router = express.Router();

// Client-facing: ads in their active window that this customer hasn't acknowledged.
router.route('/popupAds/active')
      .get(protect, getActivePopupAdsForClient);

router.route('/popupAds/:id/acknowledge')
      .post(protect, acknowledgePopupAd);

// Admin management.
router.route('/popupAds')
      .get(protect, isAdmin, getPopupAds)
      .post(protect, isAdmin, createPopupAd);

router.route('/popupAds/:id')
      .put(protect, isAdmin, updatePopupAd)
      .delete(protect, isAdmin, deletePopupAd);

router.route('/popupAds/:id/viewers')
      .get(protect, isAdmin, getPopupAdViewers);

module.exports = router;
