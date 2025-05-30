const express = require('express');
const wallet = require('../controllers/wallet');
const { protect, allowAdminsAndEmployee, isAdmin } = require('../middleware/check-auth');

const router  = express.Router();
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});

router.route('/wallet/:id')
      .get(protect, allowAdminsAndEmployee, wallet.getUserWallet)
      .post(protect, allowAdminsAndEmployee, upload.array('files'), wallet.addBalanceToWallet)
      .delete(protect, allowAdminsAndEmployee, wallet.cancelPayment);

router.route('/wallets')
      .get(protect, allowAdminsAndEmployee, wallet.getAllWallets)

router.route('/wallet/:id/usebalance')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), wallet.useBalanceOfWallet)

router.route('/user/:id/statement')
      .get(protect, allowAdminsAndEmployee, wallet.getUserStatement)

router.route('/unverifiedUsersStatement')
      .get(protect, isAdmin, wallet.getUnverifiedUsersStatement)

router.route('/user/:id/statement/:statementId')
      .post(protect, isAdmin, wallet.verifyStatement)
      
module.exports = router;
