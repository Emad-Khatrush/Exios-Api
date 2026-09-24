const express = require('express');
const multer = require('multer');

const users = require('../controllers/users');
const { protect, isEmployee, isAdmin, isClient, allowAdminsAndEmployee, allowAdminsAndAccountants } = require('../middleware/check-auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // No larger than 10mb
  },
});

const router  = express.Router();

router.route('/employeeHome')
      .get(protect, isEmployee, users.getEmpoyeeHomeData)

router.route('/home')
      .get(protect, isAdmin, users.getHomeData)

router.route('/employees')
      .get(protect, allowAdminsAndEmployee, users.getEmployees)

router.route('/clients')
      .get(protect, allowAdminsAndEmployee, users.getClients)
      
router.route('/customer/:id')
      .get(protect, allowAdminsAndEmployee, users.getCustomerData)

router.post('/account/create', upload.single('passportImage'), users.createUser);

router.route('/account/update')
      .put(protect, isClient, users.updateUser);

router.route('/account/me')
      .get(protect, isClient, users.getMyAccount);

router.route('/account/passport/upload')
      .post(protect, isClient, upload.single('passportImage'), users.uploadPassport);

router.route('/customerId/:id/update')
      .put(protect, allowAdminsAndEmployee, users.updateCustomerId);

// Only admins set special prices; employees see them when creating shipment invoices
router.route('/customer/:id/specialPrices')
      .put(protect, allowAdminsAndAccountants, allowAdminsAndEmployee, users.updateSpecialPrices);

// Only admins and accountants can review passport verifications
router.route('/customer/:id/passportVerification')
      .put(protect, allowAdminsAndAccountants, users.updatePassportVerification);

router.route('/passportVerifications')
      .get(protect, allowAdminsAndAccountants, users.getPendingPassportVerifications);

router.route('/specialPriceCustomers')
      .get(protect, allowAdminsAndAccountants, allowAdminsAndEmployee, users.getSpecialPriceCustomers);

router.post('/verifyToken', users.verifyToken);

router.post('/login', users.login);

module.exports = router;