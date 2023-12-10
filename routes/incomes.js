const express = require('express');
const incomes = require('../controllers/incomes');
const { protect, allowAdminsAndEmployee, isAdmin } = require('../middleware/check-auth');
const multer = require('multer');

const upload = multer();

const router  = express.Router();

router.route('/incomes')
      .get(protect, allowAdminsAndEmployee, incomes.getIncomes)
      .post(protect, allowAdminsAndEmployee, upload.array('files'), incomes.createIncome);
      
router.route('/income/:id')
      .get(protect, allowAdminsAndEmployee, incomes.getIncome)
      .put(protect, allowAdminsAndEmployee, incomes.updateIncome);

router.route('/income/uploadFiles')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), incomes.uploadFiles);

router.route('/income/deleteFiles')
      .delete(protect, isAdmin, incomes.deleteFiles);


module.exports = router;
