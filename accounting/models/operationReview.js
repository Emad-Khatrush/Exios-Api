const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  fingerprint: { type: String, required: true },
  state: { type: String, enum: ['reviewed', 'issue', 'pending'], required: true },
  note: { type: String, maxlength: 1000 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
module.exports = mongoose.model('AccountingOperationReview', schema);
