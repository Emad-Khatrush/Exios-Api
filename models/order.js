const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const orderSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  madeBy: { type: Schema.Types.ObjectId, ref: 'User' },
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  customerInfo: {
    fullName: {
      type: String,
      required: true,
    },
    phone: String,
    email: String
  },
  receivedUSD: {
    type: Number,
    default: 0
  },
  receivedLYD: {
    type: Number,
    default: 0
  },
  receivedShipmentLYD: { 
    type: Number,
    default: 0
  },
  receivedShipmentUSD: {
    type: Number,
    default: 0
  },
  paymentExistNote: String,
  placedAt: {
    type: String,
    required: true,
  },
  totalInvoice: {
    type: Number,
    default: 0
  },
  invoiceConfirmed: {
    type: Boolean,
    default: false
  },
  requestedEditDetails: {
    type: {
      amount: Number,
      createdAt: Date,
      items: [{
        description: String,
        unitPrice: Number,
        quantity: Number
      }]
    },
    default: null
  },
  editedAmounts: {
    type: [{
      oldAmount: Number,
      newAmount: Number,
      createdAt: {
        type: Date,
      },
      status: {
        type: String,
        enum: ['accepted', 'waiting', 'rejected', 'deleted'],
      },
      note: String,
      items: [{
        description: {
          type: String,
        },
        unitPrice: {
          type: Number,
        },
        quantity: {
          type: Number,
        }, 
      }],
    }],
    default: [],
  },
  shipment: {
    fromWhere: {
      type: String,
      required: true,
    },
    toWhere: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
      enum: ['air', 'sea', 'unknown']
    },
    estimatedDelivery: Date,
    exiosShipmentPrice: Number,
    originShipmentPrice: Number,
    weight: Number,
    packageCount: Number,
    note: String,
  },
  productName: {
    type: String,
    default: '',
  },
  quantity: {
    type: String,
    default: 0,
  },
  isShipment: {
    type: Boolean,
    default: false
  },
  // A purchase invoice that is an Alipay transfer for the customer (yuan sent to their supplier):
  // its sale and cost are remittance revenue and cost in accounting (spec 19.5)
  isRemittance: {
    type: Boolean,
    default: false,
  },
  isPayment: {
    type: Boolean,
    default: false
  },
  unsureOrder: {
    type: Boolean,
    default: false
  },
  hasRemainingPayment: {
    type: Boolean,
    default: false
  },
  hasProblem: {
    type: Boolean,
    default: false
  },
  orderStatus: {
    type: Number,
    default: 0
  },
  isFinished: {
    type: Boolean,
    default: false
  },
  activity: [{
    country: String,
    description: String,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  netIncome: [{
    nameOfIncome: {
      enum: ['shipment', 'payment'],
      type: String
    },
    total: {
      type: Number,
      default: 0
    },
  }],
  orderNote: String,
  // A personal note the customer sets for themselves on their own order (not to be
  // confused with `orderNote`, which is set by admins/employees). Lets a customer
  // jot down why they placed the order, e.g. "gift for mom", so it's easy for them
  // to recognize at a glance, together with a color they picked to tell it apart
  // from their other orders. Set by the customer from the client app only.
  customization: {
    note: {
      type: String,
      default: '',
      maxlength: 600,
    },
    theme: {
      type: String,
      default: '',
    },
  },
  isCanceled: {
    type: Boolean,
    default: false,
  },
  // Deleted by an admin because it was created by mistake (spec 19.10): hidden from the whole
  // system; accounting still shows it (its claims reversed) with a "deleted" badge
  isDeleted: { type: Boolean, default: false },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelation: {
    date: {
      type: Date,
      default: Date.now
    },
    reason: {
      type: String
    }
  },
  images: [{
    filename: String,
    path: String,
    category: {
      type: String,
      enum: ['invoice', 'receipts']
    },
    fileType: String
  }],
  debt: {
    currency: String,
    total: Number,
  },
  credit: {
    currency: String,
    total: Number,
  },
  paymentList: [{
    link: {
      type: String,
      default: ''
    },
    // The air or sea trip that carried this package, and the domestic trip that took it on to
    // another office (accounting reads these; kept in step with the trips' package lists by
    // accounting/services/tripLinks.js). Warehouses never set them.
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    domesticTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    status: {
      arrived: {
        type: Boolean,
        default: false
      },
      arrivedLibya: {
        type: Boolean,
        default: false
      },
      paid: {
        type: Boolean,
        default: false
      },
      received: {
        type: Boolean,
        default: false
      }
    },
    mark: {
      type: String,
      enum: ['found', 'missing', 'unknown'],
      default: 'found'
    },
    missingDescription: String,
    settings: {
      visableForClient: {
        type: Boolean,
        default: true
      }
    },
    note: {
      type: String,
      default: ''
    },
    images: [{
      filename: String,
      path: String,
      folder: String,
      bytes: String,
      fileType: String,
      description: String
    }],
    deliveredPackages: {
      arrivedAt: {
        type: Date,
        default: Date.now
      },
      deliveredInfo: {
        deliveredDate: {
          type: Date,
          defaule: Date.now
        },
        note: String
      },
      locationPlace: String,
      boxesCount: String,
      trackingNumber: {
        type: String,
        default: ''
      },
      weight: {
        total: {
          type: Number,
          default: 0
        },
        measureUnit: {
          type: String,
          default: ''
        }
      },
      originPrice: {
        type: Number,
        default: 0
      },
      exiosPrice: {
        type: Number,
        default: 0
      },
      receivedShipmentLYD: {
        type: Number,
        default: 0
      },
      receivedShipmentUSD: {
        type: Number,
        default: 0
      },
      shipmentMethod: {
        type: String,
        enum: ['air', 'sea', 'unknown'],
      },
      containerInfo: {
        billOfLading: {
          type: String,
          default: ''
        }
      },
      receiptNo: String
    }
  }],
  items: [{
    description: {
      type: String,
      default: ''
    },
    unitPrice: {
      type: Number,
      default: 0
    },
    quantity: {
      type: Number,
      default: 1
    }, 
  }],
  purchaseItems: [{
    date: {
      type: Date,
      default: Date.now
    },
    description: {
      type: String,
      default: 'شراء من مواقع'
    },
    unitPrice: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: '',
    },
  }]
}, { timestamps: true })

orderSchema.index({ 'paymentList.tripId': 1 });
orderSchema.index({ isDeleted: 1 });

// Deleted orders are left out of every query unless it asks for them with { withDeleted: true }
// or names isDeleted itself
function hideDeleted() {
  if (this.getOptions().withDeleted || 'isDeleted' in this.getFilter()) return;
  this.where({ isDeleted: { $ne: true } });
}
['find', 'findOne', 'countDocuments', 'distinct', 'findOneAndUpdate', 'updateOne', 'updateMany'].forEach((op) => orderSchema.pre(op, hideDeleted));
orderSchema.pre('aggregate', function hideDeletedInPipeline() {
  if (this.options?.withDeleted) return;
  this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
});
orderSchema.index({ 'paymentList.domesticTripId': 1 });

module.exports = mongoose.model("Order", orderSchema);
