const mongoose = require('mongoose');
const { officeValidator } = require('../utils/offices');
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
  actionType: { type: String, enum: ['cash', 'compensation', 'refund', 'cancellation', 'wallet', 'bank', 'withdrawal'] },
  // Any office of the system, or the two old bank values (offices are data, spec C4)
  office: { type: String, validate: officeValidator(['almutahidaTrBank', 'bank']) },
  // The account the money went into (or came out of), chosen on the deposit screen: a cash box,
  // a bank or a partner's current account such as Wasl (spec 19.4). Without it, the office's box.
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  editHistory: [{
    editedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    editedAt: Date,
    // Previous values of the fields that were changed
    before: Schema.Types.Mixed,
  }],
  // Set when the accounting section wrote this line itself (e.g. a netting credit), so its own
  // journal entry is the only one and it is never posted again as a deposit
  accountingSource: {
    model: String,
    id: Schema.Types.ObjectId,
  }, 
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
