const mongoose = require('mongoose');
const { Schema } = mongoose;
const lifecycle = {
  number: String, status: { type: String, enum: ['posted', 'canceled'], default: 'posted' },
  entryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  idempotencyKey: { type: String, required: true }, createdBy: Schema.Types.ObjectId,
  canceledAt: Date, canceledBy: Schema.Types.ObjectId, cancelReason: String, reversalEntryId: Schema.Types.ObjectId,
};
const operationSchema = new Schema({
  ...lifecycle, kind: String, day: String, office: String, description: String, currency: String,
  totalMinor: Number, usd: Number, quantity: Number, month: String, partyName: String,
  grossAmount: Number, advanceDeduction: Number,
  sourceBillId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  employeeId: Schema.Types.ObjectId, partnerId: Schema.Types.ObjectId,
  fromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  counterAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  expenseAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  postingVersion: { type: Number, default: 0 },
}, { timestamps: true });
operationSchema.index({ idempotencyKey: 1 }, { unique: true });
operationSchema.index({ status: 1, kind: 1, day: -1 });
const actionSchema = new Schema({
  ...lifecycle, operationId: { type: Schema.Types.ObjectId, ref: 'AccountingFinancialOperation', required: true },
  day: String, mode: String, amountMinor: Number, usd: Number, receivedAmount: Number,
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' }, description: String,
}, { timestamps: true });
actionSchema.index({ idempotencyKey: 1 }, { unique: true });
actionSchema.index({ operationId: 1, status: 1 });
module.exports = {
  Operation: mongoose.model('AccountingFinancialOperation', operationSchema),
  Action: mongoose.model('AccountingFinancialOperationAction', actionSchema),
};
