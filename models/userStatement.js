const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userStatementSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  createdAt: Date,
  description: { type: String, required: true },
  note: String,
  amount: { type: Number, required: true },
  currency: { type: String, enum: ['USD', 'LYD'], required: true },
  total: { type: Number, required: true },
  paymentType: { type: String, enum: ['wallet', 'debt', 'cash', 'bank', 'withdrawal'], required: true },
  calculationType: { type: String, enum: ['+', '-'], required: true },
  actionType: { type: String, enum: ['cash', 'compensation', 'refund', 'cancellation', 'wallet', 'bank', 'withdrawal'] },
  office: { type: String, enum: ['tripoli', 'benghazi', 'misurata', 'turkey', 'china'] },
  review: {
    receivedDate: Date,
    isAdminConfirmed: Boolean
  },
  attachments: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String,
    description: String
  }],
}, 
{
  timestamps: true
})

module.exports = mongoose.model("UserStatement", userStatementSchema);
