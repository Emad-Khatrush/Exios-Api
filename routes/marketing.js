const express = require('express');
const marketing = require('../controllers/marketing');
const { protect, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router  = express.Router();

router.route('/marketing/inactiveCustomers')
      .get(protect, allow(['marketing'], isAdmin), marketing.getInactiveCustomers);

module.exports = router;
