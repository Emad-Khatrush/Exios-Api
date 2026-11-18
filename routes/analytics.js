const express = require('express');
const { recordVisit, getVisitsSummary, getRecentVisits } = require('../controllers/analytics');
const appUsage = require('../controllers/appUsage');
const { protect, isAdmin, isClient, allowAdminsAndEmployee } = require('../middleware/check-auth');
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

// The client app on customers' devices: the app reports each device when it opens; staff read it
// per customer (customer page) and as totals (analytics page)
router.post('/client/app/ping', protect, isClient, appUsage.ping);
router.get('/user/:id/app', protect, anyStaff(allowAdminsAndEmployee), appUsage.customer);
router.get('/analytics/app', protect, allow(['analytics'], isAdmin), appUsage.summary);

module.exports = router;
