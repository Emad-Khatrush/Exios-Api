const express = require('express');

const orders = require('../controllers/orders');
const ordersControl = require('../controllers/ordersControl');
const xTracking = require('../controllers/xTracking');
const shippingBlock = require('../controllers/shippingBlock');
const { protect, isAdmin, isClient, allowAdminsAndAccountants, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const multer = require('multer');
// cloudinary settings
const { storage } = require('../utils/cloudinary');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});

const router  = express.Router();
const allowDeliveryStaff = (req, res, next) => req.user?.roles?.isAccountant ? next() : allowAdminsAndEmployee(req, res, next);

router.put('/order/:id/shipping-block', protect, allow(['delivery', 'invoices_edit'], allowDeliveryStaff), shippingBlock.update);

// Admin Routes
router.route('/invoices')
      .get(protect, allow(['invoices_list'], isAdmin), orders.getInvoices);

router.route('/orders')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getOrders)
      .post(protect, allow(['invoices_create'], allowAdminsAndEmployee), upload.array('files'), orders.createOrder);

router.route('/orders/status')
      .put(protect, allow(['invoices_edit', 'tracking', 'warehouse'], allowAdminsAndEmployee), orders.updateStatusOfOrder)

router.route('/packages/orders')
      .get(protect, isAdmin, orders.getPackagesOfOrders)

router.route('/currentOrdersTab')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getOrdersTab)

router.route('/orders/search')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getOrdersBySearch)

// X-Tracking: bounded order/tracking search, payment states and expandable package summaries.
router.route('/orders/tracking')
      .get(protect, allow(['tracking'], allowAdminsAndEmployee), xTracking.list)

router.route('/orders/tracking/:id/packages')
      .get(protect, allow(['tracking'], allowAdminsAndEmployee), xTracking.packages)

router.route('/unsureOrder/add')
      .post(protect, allow(['invoices_create'], allowAdminsAndEmployee), orders.createUnsureOrder);

router.route('/order/uploadFiles')
      .post(protect, allow(['invoices_create', 'invoices_edit'], allowAdminsAndEmployee), upload.array('files'), orders.uploadFiles);

router.route('/order/upload/fileLink')
      .post(protect, allow(['invoices_create', 'invoices_edit'], allowAdminsAndEmployee), upload.array('files'), orders.uploadFilesToLinks)
      .delete(protect, allow(['invoices_create', 'invoices_edit'], allowAdminsAndEmployee), orders.deleteLinkFiles);
      
router.route('/order/deleteFiles')
      .delete(protect, allow(['invoices_create', 'invoices_edit'], allowAdminsAndEmployee), orders.deleteFiles);

router.route('/order/:id')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getOrder)
      .put(protect, allow(['invoices_edit'], allowAdminsAndEmployee), orders.updateOrder)
      .delete(protect, isAdmin, orders.deleteOrder);

router.route('/order/:id/package')
      .put(protect, allow(['invoices_edit', 'warehouse'], allowAdminsAndEmployee), orders.updateSinglePackage);
      
router.route('/order/:id/view')
      .get(orders.getPublicOrder)

router.route('/order/:id/cancel')
      .post(protect, allow(['invoices_cancel'], allowAdminsAndEmployee), orders.cancelOrder);

router.route('/order/:id/addActivity')
      .post(protect, allow(['invoices_edit', 'tracking', 'warehouse'], allowAdminsAndEmployee), orders.createOrderActivity)

router.route('/order/:id/activity/:activityId')
      .delete(protect, isAdmin, orders.deleteOrderActivity)

// X-Tracking > مراقبة الطلبيات: every open package with its stage and automatic checks (read-only)
router.route('/orders/control')
      .get(protect, allow(['tracking'], isAdmin), ordersControl.getOrdersControl)

router.route('/orders/rating')
      .get(protect, allow(['ratings'], isAdmin), orders.getRatings)

router.route('/order/:id/payments')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getPaymentsOfOrder)
      .post(protect, allow(['invoices_payments'], allowAdminsAndEmployee), upload.array('files'), orders.addPaymentToOrder)

router.route('/orders/:id/confirmInvoice')
      .post(protect, allow(['invoices_edit'], allowAdminsAndEmployee), orders.confirmInvoice)

router.route('/orders/:id/items')
      .put(protect, allow(['invoices_edit'], allowAdminsAndEmployee), orders.updateOrderItems)

router.route('/orders/:id/confirmItemsChanges')
      .put(protect, allow(['invoices_edit'], allowAdminsAndEmployee), orders.confirmItemsChanges)

router.route('/user/:id/packages')
        .get(protect, anyStaff(allowDeliveryStaff), orders.getUserPackagesOfOrdersAdmin)

router.route('/user/:id/markAsDelivered')
        .post(protect, allow(['delivery'], allowDeliveryStaff), orders.markPackagesAsDelivered)

// Delivering many packages in batches (utils/batchDelivery.js)
router.route('/user/:id/deliveries')
        .get(protect, allow(['delivery'], allowDeliveryStaff), orders.openDelivery)
        .post(protect, allow(['delivery'], allowDeliveryStaff), orders.startDelivery)
router.route('/deliveries/:jobId/next')
        .post(protect, allow(['delivery'], allowDeliveryStaff), orders.nextDeliveryBatch)
router.route('/deliveries/:jobId/stop')
        .post(protect, allow(['delivery'], allowDeliveryStaff), orders.stopDelivery)

router.route('/invoices/customer/:id')
      .get(protect, anyStaff(allowAdminsAndEmployee), orders.getInvoicesByCustomer);

router.route('/invoices/:id/cancel')
      .post(protect, allow(['invoices_cancel'], allowAdminsAndAccountants), orders.cancelInvoice);

router.route('/invoices/issued')
      .get(protect, allow(['invoices_list'], allowAdminsAndEmployee), orders.getAllIssuedInvoices);

router.route('/monthReport')
      .get(protect, allow(['reports'], isAdmin), orders.getMonthReport)

router.route('/odoReport')
      .get(protect, allow(['reports'], allowAdminsAndAccountants), orders.odoReport)
      
// Client Routes

router.route('/client/home')
      .get(protect, isClient, orders.getClientHomeData)

router.route('/client/orders/:type')
      .get(protect, isClient, orders.getOrdersForUser)

router.route('/client/orders/search/:value')
      .get(protect, isClient, orders.getOrdersClientBySearch)

router.route('/client/order/:id')
      .get(protect, isClient, orders.getClientOrder)

router.route('/client/create/trackingNumber')
      .post(protect, isClient, orders.createTrackingNumbersForClient)

router.route('/client/unsureOrder/:id/delete')
      .delete(protect, isClient, orders.deleteUnsureOrder)
      
router.route('/client/order/:id/rating')
      .get(protect, isClient, orders.getOrderRating)
      .post(protect, isClient, orders.createRatingForOrder)

router.route('/client/order/:id/customization')
      .put(protect, isClient, orders.updateOrderCustomization)

module.exports = router;
