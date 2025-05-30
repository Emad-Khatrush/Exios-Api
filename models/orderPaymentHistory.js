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
  note: String
}, { timestamps: true });

module.exports = mongoose.model("OrderPaymentHistory", orderPaymentHistorySchema);
