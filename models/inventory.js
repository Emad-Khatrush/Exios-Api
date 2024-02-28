const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const inventorySchema = new Schema({
  createdBy: { type: Schema.Types.ObjectId, ref: 'User'},
  orders: [],
  attachments: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String,
    description: String
  }],
  voyage: {
    type: String,
    required: true
  },
  shippedCountry: {
    type: String,
    required: true,
    enum: ['CN', 'UAE', 'TR', 'USA', 'UK']
  },
  inventoryPlace: {
    type: String,
    required: true,
    enum: ['tripoli', 'benghazi']
  },
  inventoryFinishedDate: {
    type: Date,
    required: true
  },
  voyageAmount: {
    type: Number,
    required: true
  },
  voyageCurrency: {
    type: String,
    required: true,
    enum: ['USD', 'LYD']
  },
  inventoryType: {
    type: String,
    required: true,
    enum: ['inventoryGoods', 'shippingVoyage', 'warehouseInventory'],
    default: 'inventoryGoods'
  }
},
{
  timestamps: true
})

module.exports = mongoose.model("Inventory", inventorySchema);
