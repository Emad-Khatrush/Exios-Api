const express = require('express');

const reset = require('../controllers/resetToken');

const router  = express.Router();

router.route('/get-token-password')
      .post(reset.sendPasswordToken),

router.route('/reset-password')
      .post(reset.resetNewPassword)

module.exports = router;