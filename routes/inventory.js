const express = require('express');
const inventory = require('../controllers/inventory');
const tripNumbering = require('../controllers/tripNumbering');
const inventoryAttachments = require('../utils/inventoryAttachments');
const { protect, allowAdminsAndEmployee, isAdmin } = require('../middleware/check-auth');
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

router.get('/inventory/numbering-preview', protect, allowAdminsAndEmployee, tripNumbering.preview);

router.route('/inventory')
      .get(protect, allowAdminsAndEmployee, inventory.getInventory)
      .post(protect, allowAdminsAndEmployee, uploadInventoryAttachments, inventory.createInventory)
      .put(protect, allowAdminsAndEmployee, inventory.updateInventory);

// Admin flight board (open / needs attention / finished air & sea flights).
// Must come before /inventory/:id.
router.route('/inventory/flights')
      .get(protect, isAdmin, inventory.getFlights)

router.route('/inventory/orders')
    .get(protect, allowAdminsAndEmployee, inventory.getInventoryOrders)
    .put(protect, allowAdminsAndEmployee, inventory.addOrdersToTheInventory)
    .delete(protect, allowAdminsAndEmployee, inventory.removeOrdersFromInventory);

router.route('/inventory/uploadFiles')
    .post(protect, fileAccessRoles, uploadInventoryAttachments, inventory.uploadFiles);

router.route('/inventory/deleteFiles')
    .delete(protect, fileAccessRoles, inventory.deleteFiles);

router.get('/inventory/:id/attachments/:attachmentId/content', protect, fileAccessRoles, inventoryAttachments.content);
router.put('/inventory/:id/attachments/:attachmentId/visibility', protect, fileAccessRoles, inventoryAttachments.changeVisibility);

// Must come before /inventory/:id, or Express matches "deletions" as :id first.
router.route('/inventory/deletions')
    .get(protect, isAdmin, inventory.getPackageDeletions)

router.route('/inventory/:id/packages/:paymentListId')
    .delete(protect, allowAdminsAndEmployee, inventory.deleteWarehousePackage)

router.route('/inventory/:id/report')
    .get(protect, allowAdminsAndEmployee, inventory.getFlightReport)

router.route('/inventory/:id')
    .get(protect, fileAccessRoles, inventory.getSingleInventory)
    .delete(protect, isAdmin, inventory.deleteInventory)

// A trip's costs are supplier bills now (POST /api/acc/trips/:tripId/costs), so they reach the
// books; the old expenses list on the trip is read-only and moved by the historical migration
router.route('/inventory/:inventoryId/expenses')
    .all(protect, allowAdminsAndEmployee, (req, res) => res.status(410).json({ message: 'Trip expenses are now added from the trip page as supplier bills (Accounting).' }))

router.route('/warehouse/:office/goods')
    .get(protect, allowAdminsAndEmployee, inventory.getWarehouseInventory)

router.route('/warehouse/:office/internalShipping')
    .post(protect, allowAdminsAndEmployee, inventory.createInternalShipping)

router.route('/warehouse/:office/check')
    .post(protect, allowAdminsAndEmployee, inventory.submitWarehouseCheck)

router.route('/warehouse/:office/checks')
    .get(protect, allowAdminsAndEmployee, inventory.getWarehouseChecks)

// Returned Payments routes
router.route('/returnedPayments')
    .get(protect, allowAdminsAndEmployee, inventory.getReturnedPayments)
    .post(protect, allowAdminsAndEmployee, upload.array('files'), inventory.createReturnedPayment)
    .put(protect, allowAdminsAndEmployee, inventory.updateReturnedPayment)

module.exports = router;
