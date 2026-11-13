const express = require('express');
const expenses = require('../controllers/expenses');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const router  = express.Router();

// Old expenses are kept for reading (reports) and are posted by the historical migration.
// New expenses are entered on the Expenses screen (/api/office-expenses), which posts them.
router.route('/expenses')
      .get(protect, allow(['expenses'], allowAdminsAndEmployee), expenses.getExpenses);

router.route('/expense/:id')
      .get(protect, allow(['expenses'], allowAdminsAndEmployee), expenses.getExpense);

module.exports = router;
