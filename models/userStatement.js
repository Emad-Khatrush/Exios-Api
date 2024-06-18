const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userStatementSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  createdAt: Date,
  description: { type: String, required: true },
  note: String,
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['USD', 'LYD'], required: true },
  total: { type: Number, required: true },
  paymentType: { type: String, enum: ['wallet', 'debt'], required: true },
  calculationType: { type: String, enum: ['+', '-'], required: true },
  review: {
    receivedDate: Date,
    isAdminConfirmed: Boolean
  },
}, 
{
  timestamps: true
})

module.exports = mongoose.model("UserStatement", userStatementSchema);
