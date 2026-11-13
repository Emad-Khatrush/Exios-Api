const express = require('express');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const { downloadUrlFor } = require('../utils/googleClould');

const router = express.Router();

// The "Download" button of the admin file viewer: a 5-minute link that saves the file
router.get('/files/download-url', protect, anyStaff(allowAdminsAndEmployee), async (req, res, next) => {
  try {
    const url = await downloadUrlFor(req.query.url, req.query.name);
    if (!url) return res.status(404).json({ success: false, message: 'الملف غير موجود' });
    res.json({ url });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
