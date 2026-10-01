const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const orderPaymentHistorySchema = new Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order', // Reference to the 'Order' collection
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  receivedAmount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    enum: ['USD', 'EURO', 'LYD']
  },
  category: {
    type: String,
    required: true,
    enum: ['invoice', 'receivedGoods'],
    default: 'invoice'
  },
  rate: {
    type: Number,
    default: 0
  },
  paymentType: {
    type: String,
    required: true,
    enum: ['wallet', 'cash']
  },
  attachments: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String,
    description: String
  }],
  list: [],
  note: String,
  // For wallet payments: the customer statement line that took the money, so cancelling the
  // payment can reverse exactly that accounting entry
  statementId: { type: Schema.Types.ObjectId, ref: 'UserStatement' },
  // Debts of the order that this payment paid down, so cancelling the payment reopens them:
  // the debt, what was taken off it (in the debt's currency) and the line added to its history
  debtPayments: [{
    _id: false,
    balance: { type: Schema.Types.ObjectId, ref: 'Balance' },
    amount: Number,
    historyId: Schema.Types.ObjectId,
  }],
}, { timestamps: true });

module.exports = mongoose.model("OrderPaymentHistory", orderPaymentHistorySchema);
