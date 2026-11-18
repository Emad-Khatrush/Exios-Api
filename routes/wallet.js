const express = require('express');
const wallet = require('../controllers/wallet');
const walletExchange = require('../controllers/walletExchange');
const { protect, allowAdminsAndEmployee, allowAdminsAndAccountants, isAdmin, canManageStatements, isClient } = require('../middleware/check-auth');
const clientWallet = require('../controllers/clientWallet');
const { allow, anyStaff } = require('../middleware/permissions');

const router  = express.Router();
// 'wallets' only shows the wallets list; putting money in or taking it out of a wallet (deposit,
// withdrawal, cancelling a wallet payment) is 'wallet_transactions', and exchanging between the
// customer's currencies is 'wallet_exchange' (owner, 2026-11-16).
router.post('/wallet/:id/exchange/quote', protect, allow(['wallet_exchange'], allowAdminsAndAccountants), walletExchange.quote);
router.post('/wallet/:id/exchange', protect, allow(['wallet_exchange'], allowAdminsAndAccountants), walletExchange.create);
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});

// Paying an invoice from the wallet is also open to 'invoices_payments'; a cash withdrawal from the
// wallet is not (it is read after multer, which fills req.body)
const withdrawalGuard = allow(['wallet_transactions'], allowAdminsAndEmployee);
const cashWithdrawalNeedsWalletTransactions = (req, res, next) => (req.body?.actionType === 'withdrawal' ? withdrawalGuard(req, res, next) : next());

router.route('/wallet/:id')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getUserWallet)
      .post(protect, allow(['wallet_transactions'], allowAdminsAndEmployee), upload.array('files'), wallet.addBalanceToWallet)
      .delete(protect, allow(['wallet_transactions'], allowAdminsAndEmployee), wallet.cancelPayment);

router.route('/wallets')
      .get(protect, allow(['wallets'], allowAdminsAndEmployee), wallet.getAllActiveWallets)

router.route('/payment-rate')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getPaymentRate)

router.route('/wallet/:id/usebalance')
      .post(protect, allow(['wallet_transactions', 'invoices_payments'], allowAdminsAndEmployee), upload.array('files'), cashWithdrawalNeedsWalletTransactions, wallet.useBalanceOfWallet)

router.route('/user/:id/statement')
      .get(protect, anyStaff(allowAdminsAndEmployee), wallet.getUserStatement)

router.route('/unverifiedUsersStatement')
      .get(protect, isAdmin, wallet.getUnverifiedUsersStatement)

router.route('/user/:id/statement/:statementId')
      .post(protect, isAdmin, wallet.verifyStatement)
      .put(protect, canManageStatements, wallet.updateStatement)
      .delete(protect, canManageStatements, wallet.deleteStatement)

// The Activity tab of the Wallets section: open to staff holding 'wallets' (admins as before)
router.route('/statements/latest')
      .get(protect, allow(['wallets'], isAdmin), wallet.getLatestStatements)

router.route('/statements/deleted')
      .get(protect, isAdmin, wallet.getDeletedStatements)
      
// The customer's own wallet in the client app: balances, debts, what is coming, and the movements
router.get('/client/wallet', protect, isClient, clientWallet.summary);
router.get('/client/wallet/statement', protect, isClient, clientWallet.statement);

module.exports = router;
