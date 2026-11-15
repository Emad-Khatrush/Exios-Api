const express = require('express');

const reset = require('../controllers/resetToken');
const { resetByEmail, resetByIp } = require('../middleware/rateLimit');

const router  = express.Router();

router.route('/get-token-password')
      .post(resetByIp, resetByEmail, reset.sendPasswordToken),

router.route('/reset-password')
      .post(reset.resetNewPassword)

module.exports = router;