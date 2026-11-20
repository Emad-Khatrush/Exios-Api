const express = require('express');
const loyalty = require('../controllers/loyalty');
const promotions = require('../controllers/loyaltyPromotions');
const ratingRewards = require('../controllers/ratingRewards');
const referrals = require('../controllers/referrals');
const { protect, isClient } = require('../middleware/check-auth');
const { allow, anyStaff, PERMISSION_DENIED } = require('../middleware/permissions');
const ErrorHandler = require('../utils/errorHandler');

const router = express.Router();

// For staff whose permissions are not configured yet: employees keep the access the payment and
// customer screens gave them (read points, redeem on an order); anyone else is refused with 403.
// The loyalty-only routes have no such fallback: they need the `loyalty` permission (or an admin).
const employeesOnly = (req, res, next) => (req.user?.roles?.isEmployee || req.user?.roles?.isAdmin
  ? next()
  : next(new ErrorHandler(403, PERMISSION_DENIED)));

// The delivery routes' old guard (admins, employees and accountants), answering 403 to anyone else
const deliveryStaffOnly = (req, res, next) => (req.user?.roles?.isEmployee || req.user?.roles?.isAdmin || req.user?.roles?.isAccountant
  ? next()
  : next(new ErrorHandler(403, PERMISSION_DENIED)));

// Customers: read only, their own points (the app never redeems)
router.get('/client/loyalty', protect, isClient, loyalty.mine);
router.get('/client/loyalty/history', protect, isClient, loyalty.myHistory);
router.get('/client/loyalty/orders', protect, isClient, loyalty.myOrders);
router.get('/client/order/:id/loyalty', protect, isClient, loyalty.myOrder);
router.get('/client/loyalty/tiers', protect, isClient, loyalty.tiers);
router.post('/client/loyalty/level/seen', protect, isClient, loyalty.levelSeen);
router.get('/client/loyalty/promotions', protect, isClient, promotions.mine);
// Rating rewards (spec 2026-11-19): what awaits rating, and one rating for many orders (3 points each)
router.get('/client/ratings/pending', protect, isClient, ratingRewards.pending);
router.post('/client/ratings', protect, isClient, ratingRewards.rate);
// Invite a friend (spec 2026-11-20): the invite page, and the sign-up page's check of a code (public,
// limited per address so codes cannot be scanned)
router.get('/client/referrals', protect, isClient, referrals.mine);
router.get('/client/referrals/history', protect, isClient, referrals.history);
const checkHits = new Map();
const limitCodeCheck = (req, res, next) => {
  const now = Date.now();
  const hits = (checkHits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 30) return res.status(429).json({ success: false, message: 'too-many-requests' });
  hits.push(now);
  checkHits.set(req.ip, hits);
  if (checkHits.size > 5000) checkHits.clear();
  next();
};
router.get('/referrals/check/:code', limitCodeCheck, referrals.check);

// Staff
router.get('/loyalty/customers', protect, allow(['loyalty']), loyalty.customers);
router.get('/loyalty/overview', protect, allow(['loyalty']), loyalty.overview);
// Loyalty levels: the list for every staff screen, and the report for the points staff
router.get('/loyalty/tiers', protect, anyStaff(employeesOnly), loyalty.tiers);
router.get('/loyalty/levels/report', protect, allow(['loyalty']), loyalty.levelsReport);
router.get('/user/:id/loyalty/level', protect, anyStaff(employeesOnly), loyalty.customerLevel);
router.put('/user/:id/loyalty/level', protect, allow(['loyalty_level']), loyalty.setLevel);
router.get('/user/:id/loyalty', protect, allow(['loyalty_customer', 'loyalty_adjust', 'loyalty_level', 'clients'], employeesOnly), loyalty.customer);
router.post('/user/:id/loyalty/adjust', protect, allow(['loyalty_adjust']), loyalty.adjust);
router.put('/user/:id/loyalty/off', protect, allow(['loyalty_adjust']), loyalty.setOff);
router.get('/user/:id/referral', protect, allow(['loyalty_customer', 'loyalty_adjust', 'loyalty_level', 'clients'], employeesOnly), referrals.staffInfo);
router.put('/user/:id/referral', protect, allow(['loyalty_adjust']), referrals.staffSet);
router.delete('/user/:id/referral', protect, allow(['loyalty_adjust']), referrals.staffCancel);
// Reviewing invites (owner, 2026-11-20): suspicious referrals and the big step rewards, and who set referrals by hand
router.get('/loyalty/referrals/review', protect, allow(['loyalty']), referrals.reviewQueue);
router.get('/loyalty/referrals/manual', protect, allow(['loyalty']), referrals.manualReport);
router.post('/loyalty/referrals/friend/:id/approve', protect, allow(['loyalty_adjust']), referrals.approveReferral);
router.post('/loyalty/referrals/friend/:id/reject', protect, allow(['loyalty_adjust']), referrals.rejectReferral);
router.post('/loyalty/referrals/reward/:id/approve', protect, allow(['loyalty_adjust']), referrals.approveStep);
router.post('/loyalty/referrals/reward/:id/reject', protect, allow(['loyalty_adjust']), referrals.rejectStep);
router.get('/order/:id/loyalty', protect, allow(['loyalty', 'invoices_payments'], employeesOnly), loyalty.order);
// Same access as the order page (any staff member who can open it), but a 403 for the rest
router.get('/order/:id/loyalty/paid', protect, anyStaff(employeesOnly), loyalty.paid);
router.post('/order/:id/loyalty/redeem', protect, allow(['loyalty', 'invoices_payments'], employeesOnly), loyalty.redeem);
router.post('/order/:id/loyalty/redemptions/:redemptionId/cancel', protect, allow(['loyalty', 'invoices_payments'], employeesOnly), loyalty.cancelRedemption);
// At a delivery: whoever delivers or takes payments (accountants too), as the delivery routes allow
router.get('/user/:id/loyalty/delivery-quote', protect, allow(['loyalty', 'delivery', 'invoices_payments'], deliveryStaffOnly), loyalty.deliveryQuote);
router.post('/user/:id/loyalty/redeem-packages', protect, allow(['loyalty', 'delivery', 'invoices_payments'], deliveryStaffOnly), loyalty.redeemPackages);
router.put('/order/:id/loyalty/no-points', protect, allow(['loyalty']), loyalty.noPoints);

// Points offers (spec 2026-11-19): the points staff manage them
router.get('/loyalty/promotions', protect, allow(['loyalty']), promotions.list);
router.post('/loyalty/promotions', protect, allow(['loyalty']), promotions.create);
router.put('/loyalty/promotions/:id', protect, allow(['loyalty']), promotions.update);
router.post('/loyalty/promotions/:id/end', protect, allow(['loyalty']), promotions.end);
router.delete('/loyalty/promotions/:id', protect, allow(['loyalty']), promotions.remove);

module.exports = router;
