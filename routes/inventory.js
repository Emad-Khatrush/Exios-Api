const express = require('express');
const inventory = require('../controllers/inventory');
const { protect, allowAdminsAndEmployee, isAdmin } = require('../middleware/check-auth');
const multer = require('multer');

const upload = multer();

const router  = express.Router();

router.route('/inventory')
      .get(protect, allowAdminsAndEmployee, inventory.getInventory)
      .post(protect, allowAdminsAndEmployee, upload.array('files'), inventory.createInventory)
      .put(protect, allowAdminsAndEmployee, inventory.updateInventory);

router.route('/inventory/calculationNotReady')
      .get(protect, allowAdminsAndEmployee, inventory.getInventoriesNotFinishCalculation)

router.route('/inventory/orders')
    .get(protect, allowAdminsAndEmployee, inventory.getInventoryOrders)
    .put(protect, allowAdminsAndEmployee, inventory.addOrdersToTheInventory)
    .delete(protect, allowAdminsAndEmployee, inventory.removeOrdersFromInventory);

router.route('/inventory/uploadFiles')
    .post(protect, allowAdminsAndEmployee, upload.array('files'), inventory.uploadFiles);
    
router.route('/inventory/:id')
    .get(protect, allowAdminsAndEmployee, inventory.getSingleInventory)

router.route('/inventory/:inventoryId/expenses')
    .post(protect, isAdmin, inventory.addExpenseToInventory)
    .put(protect, isAdmin, inventory.updateExpenseOfInventory)
    .delete(protect, isAdmin, inventory.deleteExpenseOfInventory)

router.route('/warehouse/:office/goods')
    .get(protect, allowAdminsAndEmployee, inventory.getWarehouseInventory)

// Returned Payments routes
router.route('/returnedPayments')
    .get(protect, allowAdminsAndEmployee, inventory.getReturnedPayments)
    .post(protect, allowAdminsAndEmployee, upload.array('files'), inventory.createReturnedPayment)
    .put(protect, allowAdminsAndEmployee, inventory.updateReturnedPayment)

module.exports = router;
