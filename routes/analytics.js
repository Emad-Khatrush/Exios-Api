const express = require('express');
const { recordVisit, getVisitsSummary, getRecentVisits } = require('../controllers/analytics');
const { protect, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router = express.Router();

// Public: Exios-Client pings this on every route change, logged in or not.
router.route('/analytics/visit')
      .post(recordVisit);

// Admin-only dashboard data.
router.route('/analytics/summary')
      .get(protect, allow(['analytics'], isAdmin), getVisitsSummary);

router.route('/analytics/visits')
      .get(protect, allow(['analytics'], isAdmin), getRecentVisits);

module.exports = router;
