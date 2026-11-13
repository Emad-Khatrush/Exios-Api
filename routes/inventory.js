const express = require('express');
const inventory = require('../controllers/inventory');
const tripNumbering = require('../controllers/tripNumbering');
const inventoryAttachments = require('../utils/inventoryAttachments');
const { protect, allowAdminsAndEmployee, isAdmin } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const multer = require('multer');

const upload = multer();
const attachmentUpload = multer({ limits: { fileSize: inventoryAttachments.MAX_SIZE, files: 20 } });
const uploadInventoryAttachments = (req, res, next) => attachmentUpload.array('files')(req, res, error => {
  if (!error) return next();
  return res.status(400).json({ success: false, message: error.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 25 MB or smaller.' : 'Choose up to 20 files per upload.' });
});
const fileAccessRoles = (req, res, next) => {
  if (req.user?.roles?.isEmployee || inventoryAttachments.canManage(req.user)) return next();
  return res.status(403).json({ success: false, message: 'Staff access is required.' });
};

const router  = express.Router();

router.get('/inventory/numbering-preview', protect, allow(['inventory'], allowAdminsAndEmployee), tripNumbering.preview);

router.route('/inventory')
      .get(protect, allow(['inventory', 'warehouse'], allowAdminsAndEmployee), inventory.getInventory)
      .post(protect, allow(['inventory'], allowAdminsAndEmployee), uploadInventoryAttachments, inventory.createInventory)
      .put(protect, allow(['inventory'], allowAdminsAndEmployee), inventory.updateInventory);

// Admin flight board (open / needs attention / finished air & sea flights).
// Must come before /inventory/:id.
router.route('/inventory/flights')
      .get(protect, allow(['inventory'], isAdmin), inventory.getFlights)

router.route('/inventory/orders')
    .get(protect, allow(['inventory', 'warehouse'], allowAdminsAndEmployee), inventory.getInventoryOrders)
    .put(protect, allow(['inventory', 'warehouse'], allowAdminsAndEmployee), inventory.addOrdersToTheInventory)
    .delete(protect, allow(['inventory', 'warehouse'], allowAdminsAndEmployee), inventory.removeOrdersFromInventory);

router.route('/inventory/uploadFiles')
    .post(protect, allow(['inventory', 'warehouse'], fileAccessRoles), uploadInventoryAttachments, inventory.uploadFiles);

router.route('/inventory/deleteFiles')
    .delete(protect, allow(['inventory', 'warehouse'], fileAccessRoles), inventory.deleteFiles);

router.get('/inventory/:id/attachments/:attachmentId/content', protect, allow(['inventory', 'warehouse'], fileAccessRoles), inventoryAttachments.content);
router.put('/inventory/:id/attachments/:attachmentId/visibility', protect, allow(['inventory', 'warehouse'], fileAccessRoles), inventoryAttachments.changeVisibility);

// Must come before /inventory/:id, or Express matches "deletions" as :id first.
router.route('/inventory/deletions')
    .get(protect, isAdmin, inventory.getPackageDeletions)

router.route('/inventory/:id/packages/:paymentListId')
    .delete(protect, allow(['inventory', 'warehouse'], allowAdminsAndEmployee), inventory.deleteWarehousePackage)

router.route('/inventory/:id/report')
    .get(protect, allow(['inventory'], allowAdminsAndEmployee), inventory.getFlightReport)

router.route('/inventory/:id')
    .get(protect, allow(['inventory', 'warehouse'], fileAccessRoles), inventory.getSingleInventory)
    .delete(protect, isAdmin, inventory.deleteInventory)

// A trip's costs are supplier bills now (POST /api/acc/trips/:tripId/costs), so they reach the
// books; the old expenses list on the trip is read-only and moved by the historical migration
router.route('/inventory/:inventoryId/expenses')
    .all(protect, allowAdminsAndEmployee, (req, res) => res.status(410).json({ message: 'Trip expenses are now added from the trip page as supplier bills (Accounting).' }))

router.route('/warehouse/:office/goods')
    .get(protect, allow(['warehouse'], allowAdminsAndEmployee), inventory.getWarehouseInventory)

router.route('/warehouse/:office/internalShipping')
    .post(protect, allow(['warehouse'], allowAdminsAndEmployee), inventory.createInternalShipping)

router.route('/warehouse/:office/check')
    .post(protect, allow(['warehouse'], allowAdminsAndEmployee), inventory.submitWarehouseCheck)

router.route('/warehouse/:office/checks')
    .get(protect, allow(['warehouse'], allowAdminsAndEmployee), inventory.getWarehouseChecks)

// Returned Payments routes
router.route('/returnedPayments')
    .get(protect, allow(['returned_payments'], allowAdminsAndEmployee), inventory.getReturnedPayments)
    .post(protect, allow(['returned_payments'], allowAdminsAndEmployee), upload.array('files'), inventory.createReturnedPayment)
    .put(protect, allow(['returned_payments'], allowAdminsAndEmployee), inventory.updateReturnedPayment)

module.exports = router;
