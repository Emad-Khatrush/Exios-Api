// Routes the system's own screens use (spec 19.1): staff record trip costs, order purchases and
// office expenses with their ordinary system access, without entering the accounting section.
// Mounted at /api by app.js.
const express = require('express');
const multer = require('multer');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { handle } = require('./controllers/util');
const staff = require('./services/staffOperations');
const { listMoneyAccounts } = require('./services/moneyAccounts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const STAFF = [protect, allowAdminsAndEmployee];

async function uploadReceipts(files) {
  if (!files?.length) return [];
  // Loaded here: the storage client reads its credentials when required
  const { uploadToGoogleCloud } = require('../utils/googleClould');
  const out = [];
  for (const file of files) {
    const uploaded = await uploadToGoogleCloud(file, 'exios-admin-expenses');
    out.push({ path: uploaded.publicUrl, filename: uploaded.filename, folder: uploaded.folder, bytes: uploaded.bytes, fileType: file.mimetype });
  }
  return out;
}

// Lists for the forms: suppliers, money accounts (by name), currencies, offices
router.get('/acc/options', STAFF, handle(async (req, res) => res.json(await staff.options(req.user, { currency: req.query.currency }))));
// Where a deposit can go or a debt's money came from: cash boxes, banks, partners' current accounts
router.get('/acc/money-accounts', STAFF, handle(async (req, res) => res.json({ results: await listMoneyAccounts({ currency: req.query.currency }) })));
router.post('/acc/vendors', STAFF, handle(async (req, res) => res.json(await staff.createVendor(req.body || {}))));

router.route('/acc/trips/:tripId/costs')
  .get(STAFF, handle(async (req, res) => res.json(await staff.tripCosts(req.params.tripId))))
  .post(STAFF, handle(async (req, res) => res.json(await staff.addTripCost(req.params.tripId, req.body || {}, req))));
router.route('/acc/orders/:orderId/costs')
  .get(STAFF, handle(async (req, res) => res.json(await staff.orderCosts(req.params.orderId))))
  .post(STAFF, handle(async (req, res) => res.json(await staff.addOrderCost(req.params.orderId, req.body || {}, req))));
router.post('/acc/bills/:billId/cancel', STAFF, handle(async (req, res) => res.json(await staff.cancelOwnBill(req.params.billId, req, req.body?.reason))));

router.get('/office-expenses/options', STAFF, handle(async (req, res) => res.json(await staff.officeExpenseOptions(req.user, req.query.office))));
router.route('/office-expenses')
  .get(STAFF, handle(async (req, res) => res.json({ results: await staff.myExpenses(req.user, req.query) })))
  .post(STAFF, upload.array('files'), handle(async (req, res) => res.json(await staff.createOfficeExpense(req.body || {}, await uploadReceipts(req.files), req))));
router.route('/office-expenses/:id')
  .put(STAFF, upload.array('files'), handle(async (req, res) => res.json(await staff.updateOfficeExpense(req.params.id, req.body || {}, await uploadReceipts(req.files), req))))
  .delete(STAFF, handle(async (req, res) => res.json(await staff.deleteOfficeExpense(req.params.id, req))));

module.exports = router;
