const mongoose = require('mongoose');

// Audit trail for packages removed from a warehouse. A snapshot is kept
// because the underlying order/package may later change or be deleted
// itself, and this record must still make sense on its own.
const packageDeletionSchema = new mongoose.Schema(
  {
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true,
    },
    inventoryPlace: {
      type: String,
      enum: ['tripoli', 'benghazi'],
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Orders',
    },
    orderId: String,
    paymentListId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    snapshot: {
      customerName: String,
      customerId: String,
      phone: String,
      trackingNumber: String,
      receiptNo: String,
      weight: {
        total: Number,
        measureUnit: String,
      },
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

packageDeletionSchema.index({ inventoryPlace: 1, createdAt: -1 });

module.exports = mongoose.model('PackageDeletion', packageDeletionSchema);
