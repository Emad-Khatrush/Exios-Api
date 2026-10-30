const mongoose = require('mongoose');
const { Schema } = mongoose;
const hint = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  description: { type: String, required: true },
  counterAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  office: String,
});
hint.index({ accountId: 1, description: 1 }, { unique: true });
module.exports = {
  BankMatchingHint: mongoose.model('AccountingBankMatchingHint', hint),
  BankMatchingProfileRun: mongoose.model('AccountingBankMatchingProfileRun', new Schema({
    hash: { type: String, unique: true, required: true }, appliedAt: Date, counts: Schema.Types.Mixed,
  })),
};
