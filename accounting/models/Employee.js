const mongoose = require('mongoose');
const { Schema } = mongoose;
const Employee = mongoose.model('AccountingEmployee', new Schema({
  // Existing staff retain their User id as the employee dimension; new people need no login.
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  firstName: { type: String, required: true }, lastName: { type: String, default: '' },
  phone: String, office: String,
  baseSalary: { type: Number, default: 0 }, salaryCurrency: { type: String, default: 'USD' },
  isActive: { type: Boolean, default: true },
  allocationVersion: { type: Number, default: 0 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
const Adjustment = mongoose.model('AccountingEmployeeAdjustment', new Schema({
  employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
  kind: { type: String, enum: ['commission', 'deduction'], required: true },
  day: { type: String, required: true }, month: { type: String, required: true },
  amount: { type: Number, required: true }, currency: { type: String, required: true },
  rate: Number,
  reason: { type: String, required: true },
  salaryId: { type: Schema.Types.ObjectId, ref: 'AccountingSalaryPayment' },
  paidMinor: { type: Number, default: 0, min: 0 },
  waivedMinor: { type: Number, default: 0, min: 0 },
  remainderClosure: {
    amountMinor: Number,
    reason: String,
    closedAt: Date,
    closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  isCanceled: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));
Adjustment.schema.index({ employeeId: 1, month: 1, currency: 1 });
module.exports = { Employee, Adjustment };
