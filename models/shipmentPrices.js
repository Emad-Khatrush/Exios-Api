const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const shipmentPricesSchema = new Schema({
  shippingType: {
    type: String,
    enum: ['air', 'sea'],
    required: true
  },
  sellingPrice: {
    type: Number,
    required: true
  },
  country: {
    type: String,
    required: true,
    enum: ['china', 'uae', 'turkey', 'usa', 'uk']
  },
  currency: {
    type: String,
    enum: ['USD'],
    default: 'USD',
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model("ShipmentPrice", shipmentPricesSchema);
