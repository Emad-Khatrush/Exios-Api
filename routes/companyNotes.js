const express = require('express');
const multer = require('multer');
const companyNotes = require('../controllers/companyNotes');
const { protect, isAdmin } = require('../middleware/check-auth');

const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 25 * 1024 * 1024, // 25mb per file
      },
});
const router = express.Router();

// Admin only: internal company notes and documents.
router.route('/companyNotes')
      .get(protect, isAdmin, companyNotes.getCompanyNotes)
      .post(protect, isAdmin, upload.array('files'), companyNotes.createCompanyNote);

router.route('/companyNotes/:id')
      .put(protect, isAdmin, upload.array('files'), companyNotes.updateCompanyNote)
      .delete(protect, isAdmin, companyNotes.deleteCompanyNote);

router.route('/companyNotes/:id/files/:fileId')
      .delete(protect, isAdmin, companyNotes.deleteCompanyNoteFile);

module.exports = router;
