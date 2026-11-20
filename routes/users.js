const express = require('express');
const multer = require('multer');

const users = require('../controllers/users');
const { protect, isEmployee, isAdmin, isClient, allowAdminsAndEmployee, allowAdminsAndAccountants } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');

const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');

// Passport photos: images only (owner, 2026-11-20), no larger than 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // No larger than 10mb
  },
  fileFilter: (req, file, cb) => (String(file.mimetype || '').startsWith('image/')
    ? cb(null, true)
    : cb(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_TYPE))),
});

const router  = express.Router();

router.route('/employeeHome')
      .get(protect, isEmployee, users.getEmpoyeeHomeData)

router.route('/home')
      .get(protect, isAdmin, users.getHomeData)

router.route('/employees')
      .get(protect, anyStaff(allowAdminsAndEmployee), users.getEmployees)

router.route('/clients')
      .get(protect, anyStaff(allowAdminsAndEmployee), users.getClients)
      
router.route('/customer/:id')
      .get(protect, anyStaff(allowAdminsAndEmployee), users.getCustomerData)

router.post('/account/create', upload.single('passportImage'), users.createUser);

// Public, so it is limited per address: enough for a person fixing typos, too few to scan for accounts
const checkHits = new Map();
const limitSignupCheck = (req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const hits = (checkHits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 30) return res.status(429).json({ success: false, message: 'too-many-requests' });
  hits.push(now);
  checkHits.set(key, hits);
  if (checkHits.size > 5000) checkHits.clear();
  next();
};
router.post('/account/check', limitSignupCheck, users.checkSignupAvailability);

// Sign-up reads the passport number from the photo (Google Cloud Vision, paid past 1,000 a month):
// public, so it is limited per address and per day
const readHits = new Map();
let readDay = { day: '', count: 0 };
const READS_PER_DAY = 1500;
const limitPassportRead = (req, res, next) => {
  const now = Date.now();
  const hits = (readHits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  const day = new Date(now).toISOString().slice(0, 10);
  if (readDay.day !== day) readDay = { day, count: 0 };
  if (hits.length >= 8 || readDay.count >= READS_PER_DAY) return res.status(429).json({ success: false, message: 'too-many-requests' });
  hits.push(now);
  readDay.count += 1;
  readHits.set(req.ip, hits);
  if (readHits.size > 5000) readHits.clear();
  next();
};
router.post('/account/passport/read', limitPassportRead, upload.single('passportImage'), users.readPassportNumber);

router.route('/account/update')
      .put(protect, isClient, users.updateUser);

router.route('/account/me')
      .get(protect, isClient, users.getMyAccount);

router.route('/account/terms/accept')
      .post(protect, isClient, users.acceptTerms);

router.route('/account/passport/upload')
      .post(protect, isClient, upload.single('passportImage'), users.uploadPassport);

router.route('/customerId/:id/update')
      .put(protect, allow(['clients'], allowAdminsAndEmployee), users.updateCustomerId);

// Only admins can edit a customer's name, username, phone and city
router.route('/customer/:id/info')
      .put(protect, allow(['clients'], isAdmin), users.updateCustomerInfo);

// Only admins set special prices; employees see them when creating shipment invoices
router.route('/customer/:id/specialPrices')
      .put(protect, allow(['special_prices'], allowAdminsAndAccountants, allowAdminsAndEmployee), users.updateSpecialPrices);

// Only admins and accountants can review passport verifications
router.route('/customer/:id/passportVerification')
      .put(protect, allow(['passports'], allowAdminsAndAccountants), users.updatePassportVerification);

router.route('/passportVerifications')
      .get(protect, allow(['passports'], allowAdminsAndAccountants), users.getPendingPassportVerifications);

// Admin only - the "Approved" tab in Passport Review.
router.route('/passportVerifications/approved')
      .get(protect, allow(['passports'], isAdmin), users.getApprovedPassportVerifications);

router.route('/specialPriceCustomers')
      .get(protect, allow(['special_prices'], allowAdminsAndAccountants, allowAdminsAndEmployee), users.getSpecialPriceCustomers);

router.post('/verifyToken', users.verifyToken);

const { loginByIp } = require('../middleware/rateLimit');
router.post('/login', loginByIp, users.login);

module.exports = router;