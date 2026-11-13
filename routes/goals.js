const express = require('express');
const goals = require('../controllers/goals');
const { protect, isAdmin, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router = express.Router();

// Admins set the goals; employees follow them from their home page
router.route('/goals')
      .get(protect, allow(['goals'], isAdmin), goals.getGoals)
      .put(protect, allow(['goals'], isAdmin), goals.saveGoals);

router.route('/goals/dashboard')
      .get(protect, anyStaff(allowAdminsAndEmployee), goals.getDashboard);

module.exports = router;
