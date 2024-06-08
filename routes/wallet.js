const express = require('express');
const wallet = require('../controllers/wallet');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/wallet/:id')
      .get(protect, allowAdminsAndEmployee, wallet.getUserWallet)
      .post(protect, allowAdminsAndEmployee, wallet.addBalanceToWallet);

router.route('/wallets')
      .get(protect, allowAdminsAndEmployee, wallet.getAllWallets)

router.route('/wallet/:id/usebalance')
      .post(protect, allowAdminsAndEmployee, wallet.useBalanceOfWallet)

router.route('/user/:id/statement')
      .get(protect, allowAdminsAndEmployee, wallet.getUserStatement)


module.exports = router;
