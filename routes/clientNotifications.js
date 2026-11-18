const express = require('express');
const clientNotifications = require('../controllers/clientNotifications');
const { protect, isClient } = require('../middleware/check-auth');

const router = express.Router();

// The client app's notifications page: customers read only their own (and the announcements)
router.get('/client/notifications', protect, isClient, clientNotifications.list);
router.get('/client/notifications/unread', protect, isClient, clientNotifications.unread);
router.post('/client/notifications/seen', protect, isClient, clientNotifications.seen);

module.exports = router;
