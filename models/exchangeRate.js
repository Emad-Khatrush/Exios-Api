const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const exchangeRateSchema = new Schema({
  fromCurrency: {
    required: true,
    type: String,
    enum: ['usd', 'lyd'],
    default: 'usd'
  },
  toCurrency: {
    required: true,
    type: String,
    enum: ['usd', 'lyd'],
    default: 'lyd'
  },
  rate: {
    required: true,
    type: Number
  }
}, { timestamps: true });

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);
