const mongoose = require('mongoose');

// Internal company notes and documents (contracts, licenses, account details...).
// Admin-only: never exposed to employees or clients.
const companyNoteSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      default: '',
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    files: [{
      path: String,
      name: String,
      fileType: String,
      size: Number,
      uploadedAt: {
        type: Date,
        default: Date.now,
      },
    }],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CompanyNote', companyNoteSchema);
