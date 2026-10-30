const express = require('express');
const { getAnnouncements, updateAnnouncements, createAnnouncements, deleteAnnouncement, getActivePosts, createPost, updatePost, deletePost } = require('../controllers/announcement');
const { getPrices, updatePrices, getExchangeRate, updateExchangeRate, updatePricesDescription } = require('../controllers/prices');
const { protect, isAdmin } = require('../middleware/check-auth');
const tripNumbering = require('../controllers/tripNumbering');

const router  = express.Router();

router.get('/trip-numbering', protect, isAdmin, tripNumbering.list);
router.put('/trip-numbering/:country/:kind', protect, isAdmin, tripNumbering.save);

router.route('/shipmentPrices')
      .get(protect, getPrices)
      .put(protect, updatePrices);

router.route('/shipmentPricesDescription')
      .put(protect, updatePricesDescription);

router.route('/exchangeRate')
      .get(protect, getExchangeRate)
      .put(protect, updateExchangeRate);

router.route('/announcements')
      .get(protect, getAnnouncements)
      .post(protect, isAdmin, createAnnouncements)
      .put(protect, isAdmin, updateAnnouncements)
      .delete(protect, isAdmin, deleteAnnouncement);

router.route('/posts')
      .get(protect, getActivePosts)
      .post(protect, isAdmin, createPost)

router.route('/posts/:id')    
      .put(protect, isAdmin, updatePost)
      .delete(protect, isAdmin, deletePost);

module.exports = router;
