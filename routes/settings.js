const express = require('express');
const { getAnnouncements, updateAnnouncements, createAnnouncements, deleteAnnouncement, getActivePosts, createPost, updatePost, deletePost } = require('../controllers/announcement');
const { getPrices, updatePrices, getExchangeRate, updateExchangeRate, updatePricesDescription } = require('../controllers/prices');
const { protect, isAdmin, allowAdminsAndAccountants } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const tripNumbering = require('../controllers/tripNumbering');

const router  = express.Router();

router.get('/trip-numbering', protect, isAdmin, tripNumbering.list);
router.put('/trip-numbering/:country/:kind', protect, isAdmin, tripNumbering.save);

router.route('/shipmentPrices')
      .get(protect, getPrices)
      .put(protect, allow(['settings_prices'], allowAdminsAndAccountants), updatePrices);

router.route('/shipmentPricesDescription')
      .put(protect, allow(['settings_prices'], allowAdminsAndAccountants), updatePricesDescription);

router.route('/exchangeRate')
      .get(protect, getExchangeRate)
      .put(protect, allow(['settings_prices'], allowAdminsAndAccountants), updateExchangeRate);

router.route('/announcements')
      .get(protect, getAnnouncements)
      .post(protect, allow(['settings_content'], isAdmin), createAnnouncements)
      .put(protect, allow(['settings_content'], isAdmin), updateAnnouncements)
      .delete(protect, allow(['settings_content'], isAdmin), deleteAnnouncement);

router.route('/posts')
      .get(protect, getActivePosts)
      .post(protect, allow(['settings_content'], isAdmin), createPost)

router.route('/posts/:id')    
      .put(protect, allow(['settings_content'], isAdmin), updatePost)
      .delete(protect, allow(['settings_content'], isAdmin), deletePost);

module.exports = router;
