// Routes the system's own screens use (spec 19.1): staff record trip costs, order purchases and
// office expenses with their ordinary system access, without entering the accounting section.
// Mounted at /api by app.js.
const express = require('express');
const multer = require('multer');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { handle } = require('./controllers/util');
const staff = require('./services/staffOperations');
const { listMoneyAccounts, depositPlaces } = require('./services/moneyAccounts');
const customerChange = require('./services/customerChange');

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
// The offices and banks a cash deposit in this currency can go to (each has a box in it)
router.get('/acc/deposit-places', STAFF, handle(async (req, res) => res.json({ results: await depositPlaces(String(req.query.currency || 'USD')) })));
// An order marked as an Alipay transfer: send its yuan from Alipay in one step (owner's decision, v8)
router.route('/acc/orders/:orderId/alipay')
  .get(STAFF, handle(async (req, res) => res.json(await require('./services/posting/alipay').remittanceStatus(req.params.orderId))))
  .post(STAFF, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/alipay').sendRemittance(req.params.orderId, req.body || {}, { session, req })))));

// Abandoned goods on the order page (spec v8): admins and the owner declare, undo, sell
const abandoned = () => require('./services/abandoned');
router.get('/acc/orders/:orderId/packages-state', STAFF, handle(async (req, res) => res.json(await abandoned().orderPackages(req.params.orderId, req.user))));
router.post('/acc/orders/:orderId/packages/:packageId/abandon', STAFF, handle(async (req, res) => res.json(await abandoned().declareAbandoned(req.params.orderId, req.params.packageId, req))));
router.post('/acc/orders/:orderId/packages/:packageId/restore', STAFF, handle(async (req, res) => res.json(await abandoned().restoreAbandoned(req.params.orderId, req.params.packageId, req))));
router.post('/acc/orders/:orderId/packages/:packageId/sell', STAFF, handle(async (req, res) => res.json(await abandoned().sellAbandoned(req.params.orderId, req.params.packageId, req.body || {}, req))));

// The package dialog: the volumetric factor, and whether this user may change a saved weight
router.get('/acc/package-settings', STAFF, handle(async (req, res) => {
  const { volumetricFactor, canEditMeasures } = require('../utils/packageMeasures');
  const ExchangeRate = require('../models/exchangeRate');
  const rate = Number((await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean())?.rate) || null;
  res.json({ volumetricFactor: await volumetricFactor(), canEditMeasures: await canEditMeasures(req.user), rate });
}));

// An old dinar payment saved without a rate: an admin or the accountant writes it (paymentRate.js)
router.put('/acc/order-payments/:paymentId/rate', STAFF, handle(async (req, res) => res.json(await require('./services/paymentRate').setPaymentRate(req.params.paymentId, req.body?.rate, req.user))));

// Custody and loans (owner's request 2026-10-04): a staff member's own, on their Home page; and the
// overview of everyone's, for the accountant and the admin
router.get('/acc/my-custody', STAFF, handle(async (req, res) => res.json(await require('./services/custody').mine(req.user))));
router.get('/acc/custody-summary', STAFF, handle(async (req, res) => res.json(await require('./services/custody').summary(req.user))));

// The opening count day of the committed migration: money dated on or before it is already in the
// counted boxes, so the screens warn that it goes to the opening balance instead (see ledger.js)
router.get('/acc/count-day', STAFF, handle(async (req, res) => {
  const { count } = await require('./services/config').getConfig();
  res.json({ day: count?.day || null, at: count?.at || null, endOfDay: !!count?.endOfDay });
}));

// Offices and currencies as data (spec C4): the system's dropdowns read them here
router.get('/acc/offices', STAFF, handle(async (req, res) => {
  const { officeList } = require('../utils/offices');
  const { Currency } = require('./models');
  const currencies = await Currency.find({ isActive: { $ne: false } }).select('code name decimals symbol').sort({ isBase: -1, code: 1 }).lean().catch(() => []);
  res.json({ offices: await officeList(), currencies, walletCurrencies: ['USD', 'LYD'] });
}));
router.post('/acc/vendors', STAFF, handle(async (req, res) => res.json(await staff.createVendor(req.body || {}))));

router.route('/acc/trips/:tripId/costs')
  .get(STAFF, handle(async (req, res) => res.json(await staff.tripCosts(req.params.tripId))))
  .post(STAFF, handle(async (req, res) => res.json(await staff.addTripCost(req.params.tripId, req.body || {}, req))));
router.route('/acc/orders/:orderId/costs')
  .get(STAFF, handle(async (req, res) => res.json(await staff.orderCosts(req.params.orderId))))
  .post(STAFF, handle(async (req, res) => res.json(await staff.addOrderCost(req.params.orderId, req.body || {}, req))));
// After an order moves from A000 to its real customer: A000's wallet lines for it, and moving the chosen ones
router.get('/acc/orders/:orderId/previous-statements', STAFF, handle(async (req, res) => res.json(await customerChange.movableStatements(req.params.orderId))));
router.post('/acc/orders/:orderId/move-statements', STAFF, handle(async (req, res) => res.json(await customerChange.moveStatements(req.params.orderId, req.body?.statementIds, req))));
// A refund from the supplier on this order, part of it added to the customer's wallet (spec 19.6)
router.route('/acc/orders/:orderId/refunds')
  .get(STAFF, handle(async (req, res) => {
    const { CustomerRefund } = require('./models/documents');
    res.json({ results: await CustomerRefund.find({ orderId: req.params.orderId }).sort({ day: -1 }).populate('accountId', 'code name currency').lean() });
  }))
  .post(STAFF, handle(async (req, res) => {
    const { runInTransaction } = require('./services/transaction');
    const { createCustomerRefund } = require('./services/posting/customerRefund');
    res.json(await runInTransaction((session) => createCustomerRefund({ ...(req.body || {}), orderId: req.params.orderId }, { session, req })));
  }));
router.get('/acc/orders/:orderId/pending-refunds', STAFF, handle(async (req, res) => {
  res.json({ results: await require('./services/posting/pendingRefund').candidates(req.query, null, { allDates: true, suggestFractions: true }) });
}));
router.post('/acc/bills/:billId/cancel', STAFF, handle(async (req, res) => res.json(await staff.cancelOwnBill(req.params.billId, req, req.body?.reason))));

router.get('/office-expenses/options', STAFF, handle(async (req, res) => res.json(await staff.officeExpenseOptions(req.user, req.query.office))));
router.route('/office-expenses')
  .get(STAFF, handle(async (req, res) => res.json({ results: await staff.myExpenses(req.user, req.query) })))
  .post(STAFF, upload.array('files'), handle(async (req, res) => res.json(await staff.createOfficeExpense(req.body || {}, await uploadReceipts(req.files), req))));
router.route('/office-expenses/:id')
  .put(STAFF, upload.array('files'), handle(async (req, res) => res.json(await staff.updateOfficeExpense(req.params.id, req.body || {}, await uploadReceipts(req.files), req))))
  .delete(STAFF, handle(async (req, res) => res.json(await staff.deleteOfficeExpense(req.params.id, req))));

module.exports = router;
