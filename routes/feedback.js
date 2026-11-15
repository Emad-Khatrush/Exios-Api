const express = require('express');
const multer = require('multer');
const feedback = require('../controllers/feedback');
const { protect, isAdmin, isClient } = require('../middleware/check-auth');
const { allow } = require('../middleware/permissions');
const ErrorHandler = require('../utils/errorHandler');

const router = express.Router();

// Screenshots only: up to 5 images of 8 MB each, held in memory until they go to the bucket
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: feedback.MAX_IMAGES },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)),
});
// Multer's own errors in the customer's language, as a 400 rather than a server error
const images = (req, res, next) => upload.array('images', feedback.MAX_IMAGES)(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') return next(new ErrorHandler(400, 'حجم الصورة يجب ألا يتجاوز 8 ميغابايت'));
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') return next(new ErrorHandler(400, `يمكن إرفاق ${feedback.MAX_IMAGES} صور كحد أقصى`));
  return next(error);
});

// Customers: send and follow their own complaints and suggestions
router.route('/client/feedback')
  .get(protect, isClient, feedback.mine)
  .post(protect, isClient, images, feedback.create);
router.get('/client/feedback/orders', protect, isClient, feedback.myOrders);
router.post('/client/feedback/:id/messages', protect, isClient, images, feedback.customerReply);
router.post('/client/feedback/:id/seen', protect, isClient, feedback.seen);

// Staff: the same permission as customer ratings (the page lives under Ratings)
router.get('/feedback', protect, allow(['ratings'], isAdmin), feedback.list);
router.post('/feedback/:id/messages', protect, allow(['ratings'], isAdmin), images, feedback.staffReply);
router.route('/feedback/:id')
  .put(protect, allow(['ratings'], isAdmin), feedback.update)
  .delete(protect, allow(['ratings'], isAdmin), feedback.remove);

module.exports = router;
