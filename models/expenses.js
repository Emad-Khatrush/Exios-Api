const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const expenseSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User'},
  placedAt: {
    type: String,
    required: true
  },
  images: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String
  }],
  cost: {
    currency: String,
    total: Number
  },
  description: String
}, 
{
  timestamps: true
})

module.exports = mongoose.model("Expense", expenseSchema);
