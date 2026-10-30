const mongoose = require('mongoose');
const { Schema } = mongoose;

// Deliberately separate from statements, wallets, bank lines and the general ledger.
const row = new Schema({
  day: String, description: String, reference: String, direction: String, category: String,
  amountMinor: Number, transferRef: String, fingerprint: String, duplicateReason: String,
  sourceRow: Number,
});
const batch = new Schema({
  requestKey: { type: String, unique: true, required: true },
  requestFingerprint: String,
  title: String, office: String, officeName: String,
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  accountName: String, accountCode: String, currency: String, decimals: Number,
  from: String, to: String, openingMinor: Number, closingMinor: Number,
  scope: { type: String, enum: ['full', 'wallets'], default: 'full' },
  rows: [row], status: { type: String, enum: ['draft', 'approved', 'void'], default: 'draft' },
  revision: { type: Number, default: 1 },
  sourceFile: { name: String, hash: String, sheet: String, data: { type: Buffer, select: false } },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, approvedAt: Date,
  reviewNote: String, voidReason: String,
}, { timestamps: true });
batch.index({ status: 1, office: 1, from: 1, to: 1 });
batch.index({ 'rows.fingerprint': 1 });
batch.index({ 'rows.transferRef': 1 });
const mutex = new Schema({ key: { type: String, unique: true }, version: { type: Number, default: 0 } });
module.exports = {
  HistoricalCashBatch: mongoose.model('AccountingHistoricalCashBatch', batch),
  HistoricalCashMutex: mongoose.model('AccountingHistoricalCashMutex', mutex),
  HistoricalCashSourceReview: mongoose.model('AccountingHistoricalCashSourceReview', new Schema({
    key: { type: String, required: true, unique: true }, fingerprint: String,
    state: { type: String, enum: ['reviewed', 'issue', 'excluded', 'linked'], required: true },
    category: String, note: String, independent: Boolean,
    manualKey: { type: String }, batchId: Schema.Types.ObjectId, rowId: Schema.Types.ObjectId, batchRevision: Number,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date,
  }, { timestamps: true })),
};
