const express = require('express');

const { getOffice } = require('../controllers/offices');
const { protect, isAdmin, isEmployee } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/office/:officeName')
      .get(protect, isAdmin, isEmployee, getOffice)

// router.route('/office')
//       .post(protect, createOffice)

module.exports = router;
