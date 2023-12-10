const express = require('express');

const sendMessages = require('../controllers/sendMessages');
const { protect, isAdmin, isEmployee } = require('../middleware/check-auth');

const router  = express.Router();

// router.route('/get-qr-code')
//       .get(sendMessages.getQRcode)

// router.route('/sendWhatsupMessage')
//       .post(sendMessages.sendWhatsupMessage)

module.exports = router;
