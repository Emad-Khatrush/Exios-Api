const express = require('express');
const wallet = require('../controllers/wallet');
const walletExchange = require('../controllers/walletExchange');
const { protect, allowAdminsAndEmployee, allowAdminsAndAccountants, isAdmin, canManageStatements } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router  = express.Router();
router.post('/wallet/:id/exchange/quote', protect, allow(['wallets'], allowAdminsAndAccountants), walletExchange.quote);
router.post('/wallet/:id/exchange', protect, allow(['wallets'], allowAdminsAndAccountants), walletExchange.create);
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});

router.route('/wallet/:id')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getUserWallet)
      .post(protect, allow(['wallets'], allowAdminsAndEmployee), upload.array('files'), wallet.addBalanceToWallet)
      .delete(protect, allow(['wallets'], allowAdminsAndEmployee), wallet.cancelPayment);

router.route('/wallets')
      .get(protect, allow(['wallets'], allowAdminsAndEmployee), wallet.getAllActiveWallets)

router.route('/payment-rate')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getPaymentRate)

router.route('/wallet/:id/usebalance')
      .post(protect, allow(['wallets', 'invoices_payments'], allowAdminsAndEmployee), upload.array('files'), wallet.useBalanceOfWallet)

router.route('/user/:id/statement')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getUserStatement)

router.route('/unverifiedUsersStatement')
      .get(protect, isAdmin, wallet.getUnverifiedUsersStatement)

router.route('/user/:id/statement/:statementId')
      .post(protect, isAdmin, wallet.verifyStatement)
      .put(protect, canManageStatements, wallet.updateStatement)
      .delete(protect, canManageStatements, wallet.deleteStatement)

router.route('/statements/latest')
      .get(protect, isAdmin, wallet.getLatestStatements)

router.route('/statements/deleted')
      .get(protect, isAdmin, wallet.getDeletedStatements)
      
module.exports = router;
