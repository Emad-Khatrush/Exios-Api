const mongoose = require('mongoose');
module.exports = mongoose.model('AccountingTripCostSettlement', new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
  mode: { type: String, enum: ['air', 'sea'], required: true },
  method: { type: String, enum: ['weight', 'equal'], required: true },
  status: { type: String, enum: ['posted', 'canceled'], default: 'posted' },
  fingerprint: { type: String, required: true, unique: true },
  sourceLineIds: [mongoose.Schema.Types.ObjectId],
  bills: [{ billId: mongoose.Schema.Types.ObjectId, paymentId: mongoose.Schema.Types.ObjectId }],
  preview: mongoose.Schema.Types.Mixed,
  createdBy: mongoose.Schema.Types.ObjectId,
  canceledBy: mongoose.Schema.Types.ObjectId,
  cancelReason: String,
}, { timestamps: true }));
