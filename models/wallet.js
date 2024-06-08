const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to the 'User' collection
    required: true
  },
  balance: {
    type: Number,
    required: true,
    default: 0
  },
  currency: {
    type: String,
    enum: ['LYD', 'USD'],
    required: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('Wallet', walletSchema);
