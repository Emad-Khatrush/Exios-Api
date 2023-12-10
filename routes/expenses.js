const express = require('express');
const expenses = require('../controllers/expenses');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const multer = require('multer');

// cloudinary settings
// const { storage } = require('../utils/cloudinary');
const upload = multer();

const router  = express.Router();

router.route('/expenses')
      .get(protect, allowAdminsAndEmployee, expenses.getExpenses)
      .post(protect, allowAdminsAndEmployee, upload.array('files'), expenses.createExpense);

      
router.route('/expense/uploadFiles')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), expenses.uploadFiles);
      
router.route('/expense/deleteFiles')
      .delete(protect, allowAdminsAndEmployee, expenses.deleteFiles);

router.route('/expense/:id')
      .get(protect, allowAdminsAndEmployee, expenses.getExpense)
      .put(protect, allowAdminsAndEmployee, expenses.updateExpense);

module.exports = router;
