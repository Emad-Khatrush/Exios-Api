const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const officeSchema = new Schema({
  office: {
    type: String,
    enum: ['tripoli', 'benghazi', 'turkey']
  },
  libyanDinar: {
    value: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'LYD'
    }
  },
  usaDollar: {
    value: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'USD'
    }
  },
  turkishLira: {
    value: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'TRY'
    }
  }
}, 
{
  timestamps: true
})

module.exports = mongoose.model("Office", officeSchema);
