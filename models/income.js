const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const incomeSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User'},
  office: {
    type: String,
    required: true,
    enum: ['tripoli', 'benghazi', 'turkey']
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

module.exports = mongoose.model("Income", incomeSchema);
