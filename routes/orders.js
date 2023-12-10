const express = require('express');

const orders = require('../controllers/orders');
const { protect, isAdmin, isClient, isEmployee, allowAdminsAndEmployee } = require('../middleware/check-auth');
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

// Admin Routes
router.route('/invoices')
      .get(protect, isAdmin, orders.getInvoices);

router.route('/orders')
      .get(protect, allowAdminsAndEmployee, orders.getOrders)
      .post(protect, allowAdminsAndEmployee, upload.array('files'), orders.createOrder);

router.route('/packages/orders')
      .get(protect, isAdmin, orders.getPackagesOfOrders)

router.route('/currentOrdersTab')
      .get(protect, allowAdminsAndEmployee, orders.getOrdersTab)

router.route('/orders/search')
      .get(protect, allowAdminsAndEmployee, orders.getOrdersBySearch)

router.route('/unsureOrder/add')
      .post(protect, allowAdminsAndEmployee, orders.createUnsureOrder);

router.route('/order/uploadFiles')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), orders.uploadFiles);

router.route('/order/upload/fileLink')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), orders.uploadFilesToLinks)
      .delete(protect, allowAdminsAndEmployee, orders.deleteLinkFiles);
      
router.route('/order/deleteFiles')
      .delete(protect, allowAdminsAndEmployee, orders.deleteFiles);

router.route('/order/:id')
      .get(protect, allowAdminsAndEmployee, orders.getOrder)
      .put(protect, allowAdminsAndEmployee, orders.updateOrder);

router.route('/order/:id/view')
      .get(orders.getPublicOrder)

router.route('/order/:id/cancel')
      .post(protect, allowAdminsAndEmployee, orders.cancelOrder);

router.route('/order/:id/addActivity')
      .post(protect, allowAdminsAndEmployee, orders.createOrderActivity)

router.route('/orders/rating')
      .get(protect, isAdmin, orders.getRatings)

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

module.exports = router;
