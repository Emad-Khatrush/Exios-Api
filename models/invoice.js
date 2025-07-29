const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const invoiceSchema = new Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  total: {
    type: Number,
    required: true
  },
  referenceId: {
    type: Number,
    required: true,
    unique: true
  },
  amountUSD: {
    type: Number,
    required: true,
    default: 0
  },
  amountLYD: {
    type: Number,
    required: true,
    default: 0  
  },
  rate: {
    type: Number,
    required: true,
    default: 0
  },
  currency: {
    type: String,
    required: true,
    enum: ['USD', 'EURO', 'LYD']
  },
  category: {
    type: String,
    required: true,
    enum: ['invoice', 'shipment'],
    default: 'invoice'
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

module.exports = mongoose.model("Invoice", invoiceSchema);
