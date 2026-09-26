const mongoose = require('mongoose');

// A record that an employee walked the warehouse floor and reconciled it
// against the system. Kept even after the packages it checked are later
// removed/moved, since it's proof the check happened at that point in time.
const warehouseCheckSchema = new mongoose.Schema(
  {
    inventoryPlace: {
      type: String,
      enum: ['tripoli', 'benghazi'],
      required: true,
    },
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
    },
    checkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    totalPackages: {
      type: Number,
      required: true,
    },
    discrepancies: [{
      _id: false,
      paymentListId: String,
      trackingNumber: String,
      customerName: String,
      note: {
        type: String,
        required: true,
      },
    }],
    notes: String,
  },
  { timestamps: true }
);

warehouseCheckSchema.index({ inventoryPlace: 1, createdAt: -1 });

module.exports = mongoose.model('WarehouseCheck', warehouseCheckSchema);
