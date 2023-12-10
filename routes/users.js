const express = require('express');

const users = require('../controllers/users');
const { protect, isEmployee, isAdmin, isClient, allowAdminsAndEmployee } = require('../middleware/check-auth');

const router  = express.Router();

router.route('/employeeHome')
      .get(protect, isEmployee, users.getEmpoyeeHomeData)

router.route('/home')
      .get(protect, isAdmin, users.getHomeData)

router.route('/employees')
      .get(protect, allowAdminsAndEmployee, users.getEmployees)

router.route('/customer/:id')
      .get(protect, allowAdminsAndEmployee, users.getCustomerData)

router.post('/account/create', users.createUser);

router.route('/account/update')
      .put(protect, isClient, users.updateUser);

router.post('/verifyToken', users.verifyToken);

router.post('/login', users.login);

module.exports = router;