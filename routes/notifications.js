const express = require('express');
const notifications = require('../controllers/notifications');
const { protect, isAdmin, isEmployee } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/notifications')
      .get(protect, isAdmin, isEmployee, notifications.getNotifications)
      .delete(protect, isAdmin, isEmployee, notifications.deleteNotifications);

module.exports = router;
