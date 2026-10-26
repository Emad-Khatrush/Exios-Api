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
  // Exchange rate used when an LYD payment was made
  rate: Number,
  paymentType: { type: String, enum: ['wallet', 'debt', 'cash', 'bank', 'withdrawal'], required: true },
  calculationType: { type: String, enum: ['+', '-'], required: true },
  actionType: { type: String, enum: ['cash', 'compensation', 'refund', 'cancellation', 'wallet', 'bank', 'withdrawal', 'exchange'] },
  walletExchangeId: { type: Schema.Types.ObjectId, ref: 'WalletExchange', immutable: true },
  walletExchangeLeg: { type: String, enum: ['from', 'to'], immutable: true },
  accountingSource: { model: String, id: Schema.Types.ObjectId },
  office: { type: String, enum: ['tripoli', 'benghazi', 'misurata', 'turkey', 'china', 'almutahidaTrBank', 'bank'] },
  editHistory: [{
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editedAt: Date,
    // Previous values of the fields that were changed
    before: Schema.Types.Mixed,
  }],
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
