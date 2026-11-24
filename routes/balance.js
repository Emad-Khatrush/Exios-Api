const express = require('express');

const balance = require('../controllers/balance');
const { protect, allowAdminsAndEmployee, isAdmin, allowAdminsAndAccountants } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});
const router  = express.Router();

router.route('/balances')
      .get(protect, allow(['debts'], allowAdminsAndEmployee), balance.getBalances)
      .post(protect, allow(['debts'], allowAdminsAndEmployee), balance.createBalance);

router.route('/balances/:id')
      .delete(protect, isAdmin, balance.deleteBalance);

// What the customer's points can pay on a debt (the points field of the payment form)
router.get('/balances/:id/points', protect, allow(['debts'], allowAdminsAndEmployee), balance.debtPointsQuote);

router.route('/balances/:id/paymentHistory')
      .post(protect, allow(['debts'], allowAdminsAndEmployee), upload.array('files'), balance.createPaymentHistory)
      .put(protect, allow(['debts'], allowAdminsAndEmployee), balance.updateCompanyBalance);

// Cancelling a payment made by mistake: same people as closing a debt by hand
router.route('/balances/:id/paymentHistory/:paymentId')
      .delete(protect, allow(['debts'], allowAdminsAndAccountants), balance.cancelDebtPayment);

router.route('/balances/:id/confirmed')
      .put(protect, isAdmin, balance.confirmDebt)

router.route('/balances/:id/close')
      .put(protect, allow(['debts'], allowAdminsAndAccountants), balance.closeDebtManually)

router.route('/debts/search')
      .get(protect, anyStaff(allowAdminsAndEmployee), balance.searchForDebt)

router.route('/debts/:userId')
      .get(protect, anyStaff(allowAdminsAndEmployee), balance.getDebtOfUser)

router.route('/debts/user/:customerId')
      .get(protect, anyStaff(allowAdminsAndEmployee), balance.checkDebtsByUser)

module.exports = router;
