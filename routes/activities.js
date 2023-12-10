const express = require('express');
const ativities = require('../controllers/activities');
const { protect, isAdmin } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/activities')
      .get(protect, isAdmin, ativities.getActivities);

module.exports = router;
