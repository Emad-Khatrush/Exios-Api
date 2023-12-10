const mongoose = require('mongoose');

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
  createdOffice: {
    type: String,
    required: true,
    enum: ['benghazi', 'tripoli']
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
  status: {
    type: String,
    enum: ['open', 'closed', 'overdue', 'lost'],
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
  debtPriority: String
}, { timestamps: true });

module.exports = mongoose.model('Balance', balanceSchema);
