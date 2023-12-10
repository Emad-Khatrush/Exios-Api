const express = require('express');
const { getAnnouncements, updateAnnouncements, createAnnouncements, deleteAnnouncement } = require('../controllers/announcement');
const { getPrices, updatePrices, getExchangeRate, updateExchangeRate } = require('../controllers/prices');
const { protect, isAdmin } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/shipmentPrices')
      .get(protect, getPrices)
      .put(protect, updatePrices);

router.route('/exchangeRate')
      .get(protect, getExchangeRate)
      .put(protect, updateExchangeRate);

router.route('/announcements')
      .get(protect, getAnnouncements)
      .post(protect, isAdmin, createAnnouncements)
      .put(protect, isAdmin, updateAnnouncements)
      .delete(protect, isAdmin, deleteAnnouncement);

module.exports = router;
