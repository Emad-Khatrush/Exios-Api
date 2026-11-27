const express = require('express');
const { recordVisit, getVisitsSummary, getRecentVisits } = require('../controllers/analytics');
const appUsage = require('../controllers/appUsage');
const customerAnalytics = require('../controllers/customerAnalytics');
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

// Customer and sales analyses (owner 2026-11-27): their own permission, off for staff until given;
// staff not configured yet are refused (no legacy guard), admins and owners pass
// Their settings: targets and the accounts marked as companies (before the :section route)
router.route('/analytics/customers-settings')
      .get(protect, allow(['customer_analytics']), customerAnalytics.getSettings)
      .put(protect, allow(['customer_analytics']), customerAnalytics.putSettings);
router.get('/analytics/customers/:section', protect, allow(['customer_analytics']), customerAnalytics.section);

module.exports = router;
