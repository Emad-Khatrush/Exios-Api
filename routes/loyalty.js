const express = require('express');
const loyalty = require('../controllers/loyalty');
const promotions = require('../controllers/loyaltyPromotions');
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
