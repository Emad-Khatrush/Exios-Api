const express = require('express');
const push = require('../controllers/push');
const { protect, isClient } = require('../middleware/check-auth');

const router = express.Router();

router.route('/client/push/token')
  .post(protect, isClient, push.saveToken)
  .delete(protect, isClient, push.removeToken);

module.exports = router;
