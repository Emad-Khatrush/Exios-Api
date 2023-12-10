const express = require('express');

const balance = require('../controllers/balance');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});
const router  = express.Router();

router.route('/balances')
      .get(protect, allowAdminsAndEmployee, balance.getBalances)
      .post(protect, allowAdminsAndEmployee, balance.createBalance);

router.route('/balances/:id/paymentHistory')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), balance.createPaymentHistory)
      .put(protect, allowAdminsAndEmployee, balance.updateCompanyBalance);
      
module.exports = router;
