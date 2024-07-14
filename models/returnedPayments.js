const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const returnedPaymentsSchema = new Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User'},
  orders: [],
  attachments: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String,
    description: String
  }],
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User'},
  deliveryTo: {
    type: String,
    required: true,
  },
  shippingCompanyName: {
    type: String,
    required: true,
  },
  issuedOffice: {
    type: String,
    required: true,
    enum: ['tripoli', 'benghazi']
  },
  goodsSentDate: {
    type: Date,
    required: true
  },
  paidDate: {
    type: Date,
  },
  amount: {
    type: Number,
    required: true
  },
  paidAmount: {
    type: Number,
  },
  paidAmountCurrency: {
    type: String,
    enum: ['USD', 'LYD']
  },
  currency: {
    type: String,
    required: true,
    enum: ['USD', 'LYD']
  },
  shippingType: {
    type: String,
    required: true,
    enum: ['air', 'sea', 'domestic'],
  },
  status: {
    type: String,
    required: true,
    enum: ['active', 'waitingApproval', 'finished'],
    default: 'active'
  },
  paymentFound: {
    type: String,
  },
  note: String
},
{
  timestamps: true
})

module.exports = mongoose.model("ReturnedPayment", returnedPaymentsSchema);
