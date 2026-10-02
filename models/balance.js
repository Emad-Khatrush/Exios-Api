const mongoose = require('mongoose');
const { officeValidator } = require('../utils/offices');

const balanceSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order', // Reference to the 'Order' collection
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  // Any office of the system (offices are data, spec C4)
  createdOffice: {
    type: String,
    required: true,
    validate: officeValidator(),
  },
  balanceType: {
    type: String,
    required: true,
    enum: ['debt', 'credit']
  },
  amount: {
    type: Number,
    required: true,
  },
  initialAmount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    enum: ['LYD', 'USD'],
    required: true,
  },
  debtType: {
    type: String,
    enum: ['invoice', 'receivedGoods', 'general'],
  },
  status: {
    type: String,
    enum: ['open', 'closed', 'waitingApproval', 'overdue', 'lost'],
    required: true,
    default: 'open'
  },
  notes: {
    type: String,
    required: true,
  },
  paymentHistory: [
    {
      createdAt: {
        type: Date,
      },
      rate: {
        type: Number,
      },
      amount: {
        type: Number,
      },
      currency: {
        type: String,
        enum: ['LYD', 'USD'],
      },
      companyBalance: {
        isExist: {
          type: Boolean,
          default: false
        },
        reference: String
      },
      attachments: [{
        filename: String,
        path: String,
        fileType: String,
        description: String
      }],
      notes: String
    }
  ],
  attachments: [{
    filename: String,
    path: String,
    fileType: String,
    description: String
  }],
  debtPriority: String,
  // Where the money of the debt came from (spec 19.8): 'cash' = paid out of a cash box or bank,
  // 'partner' = paid for us by a partner on their current account (e.g. Aswaq), 'order' = a
  // reminder of the order's own claim (no new entry). Old debts have none.
  source: {
    kind: { type: String, enum: ['cash', 'partner', 'order'] },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountingAccount' },
  },
  // Set when an admin/accountant closes a debt by hand (e.g. 0.1$ left over).
  // The written-off remainder is moved to a separate 'lost' balance.
  manualClosure: {
    note: String,
    writtenOffAmount: Number,
    closedAt: Date,
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lostBalance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Balance',
    },
  },
  // True for debts created on an order after debts started following their order.
  // Only these move to the new customer when the order's customer changes; older debts stay put.
  followsOrder: {
    type: Boolean,
    default: false,
  },
  // On a 'lost' balance created by a manual closure: the debt it was written off from
  sourceBalance: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Balance',
  }
}, { timestamps: true });

module.exports = mongoose.model('Balance', balanceSchema);
