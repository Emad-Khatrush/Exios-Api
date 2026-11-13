const express = require('express');
const staffAccess = require('../controllers/staffAccess');
const { protect } = require('../middleware/check-auth');
const { hasFullAccess } = require('../middleware/permissions');
const ErrorHandler = require('../utils/errorHandler');

const router = express.Router();

// Settings > Permissions is for admins and the owner accounts only
const managers = async (req, res, next) => {
  try {
    return (await hasFullAccess(req.user)) ? next() : next(new ErrorHandler(403, 'permission-denied'));
  } catch (error) {
    return next(error);
  }
};

// Any signed-in staff member reads their own; clients get nothing out of it
const staffOnly = (req, res, next) => {
  const roles = req.user?.roles || {};
  return roles.isAdmin || roles.isEmployee || roles.isAccountant ? next() : next(new ErrorHandler(403, 'permission-denied'));
};

router.get('/staff-access/me', protect, staffOnly, staffAccess.me);
router.get('/staff-access/members', protect, managers, staffAccess.members);
router.put('/staff-access/members/:id', protect, managers, staffAccess.save);

module.exports = router;
