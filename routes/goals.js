const express = require('express');
const goals = require('../controllers/goals');
const { protect, isAdmin, allowAdminsAndEmployee } = require('../middleware/check-auth');

const router = express.Router();

// Admins set the goals; employees follow them from their home page
router.route('/goals')
      .get(protect, isAdmin, goals.getGoals)
      .put(protect, isAdmin, goals.saveGoals);

router.route('/goals/dashboard')
      .get(protect, allowAdminsAndEmployee, goals.getDashboard);

module.exports = router;
