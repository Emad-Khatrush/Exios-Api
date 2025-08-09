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
  },
  departureDate: {
    type: Date,
  },
  voyageAmount: Number,
  costPrice: Number,
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
  },
  shippingType: {
    type: String,
    required: true,
    enum: ['air', 'sea', 'domestic'],
  },
  isCaclulationDone: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    required: true,
    default: 'processing',
    enum: ['processing', 'finished'],
  },
  expenses: [{
    description: String,
    amount: Number,
    currency: {
      type: String,
      enum: ['USD', 'LYD']
    },
    rate: {
      type: Number,
      default: 0
    },
    date: {
      type: Date,
      default: Date.now
    }
  }],
  note: String
},
{
  timestamps: true
})

// Create compound indexes
inventorySchema.index(
  { inventoryType: 1, status: 1, shippingType: 1, createdAt: -1 },
  { name: 'compound_inventory_index' }
);

// Create a text index for full-text search
inventorySchema.index(
  {
    voyage: 'text',
    shippingType: 'text',
    inventoryPlace: 'text',
    shippedCountry: 'text',
    'orders.orderId': 'text',
    'orders.paymentList.deliveredPackages.trackingNumber': 'text'
  },
  { name: 'text_search_index' }
);


module.exports = mongoose.model("Inventory", inventorySchema);
