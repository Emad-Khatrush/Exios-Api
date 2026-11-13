const express = require('express');
const ativities = require('../controllers/activities');
const { protect, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router  = express.Router();

router.route('/activities')
      .get(protect, allow(['activities'], isAdmin), ativities.getActivities);

router.route('/activities/users')
      .get(protect, allow(['activities'], isAdmin), ativities.getActivityUsers);

module.exports = router;
