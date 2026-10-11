const mongoose = require('mongoose');
module.exports = mongoose.model('AccountingStatementTranslation', new mongoose.Schema({
  sourceHash: { type: String, required: true, unique: true },
  original: { type: String, required: true },
  text: { type: String, required: true },
  sourceLanguage: String,
  targetLanguage: { type: String, default: 'ar' },
  provider: String,
}, { timestamps: true }));
