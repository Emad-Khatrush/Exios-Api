const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Archive of user statements removed from the cashflow, kept for audit
const deletedStatementSchema = new Schema({
  originalId: { type: Schema.Types.ObjectId, required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  currency: { type: String, enum: ['USD', 'LYD'], required: true },
  // Full copy of the statement as it was right before deletion
  statement: { type: Schema.Types.Mixed, required: true },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  deletedAt: { type: Date, default: Date.now },
  walletBalanceBefore: Number,
  walletBalanceAfter: Number,
},
{
  timestamps: true
})

module.exports = mongoose.model("DeletedStatement", deletedStatementSchema);
