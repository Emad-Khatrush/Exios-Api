const mongoose = require('mongoose');
const { Schema } = mongoose;

const ruleSchema = new Schema({
  _id: String,
  country: { type: String, required: true },
  kind: { type: String, enum: ['air', 'FCL', 'LCL', 'sea', 'domestic'], required: true },
  enabled: { type: Boolean, default: false },
  format: { type: String, enum: ['number', 'number-year'], default: 'number-year' },
  year: { type: String, required: true },
  nameTemplate: { type: String, required: true },
  nextNumber: { type: Number, min: 1, required: true },
  version: { type: Number, default: 0 },
  mutationVersion: { type: Number, default: 0 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Reservations survive deleting/renaming a trip, so an issued number is never reused.
const reservationSchema = new Schema({
  _id: String,
  ruleId: { type: String, required: true },
  period: { type: String, required: true },
  number: { type: Number, required: true },
  voyage: { type: String, required: true },
  inventoryId: { type: Schema.Types.ObjectId, ref: 'Inventory', required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
reservationSchema.index({ ruleId: 1, period: 1, number: -1 });

module.exports = {
  TripNumberingRule: mongoose.model('TripNumberingRule', ruleSchema),
  TripNumberReservation: mongoose.model('TripNumberReservation', reservationSchema),
};
