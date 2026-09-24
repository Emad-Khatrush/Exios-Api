const express = require('express');
const marketing = require('../controllers/marketing');
const { protect, isAdmin } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/marketing/inactiveCustomers')
      .get(protect, isAdmin, marketing.getInactiveCustomers);

module.exports = router;
