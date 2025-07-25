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
  isCanceled: {
    type: Boolean,
    default: false,
  },
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
  }]
}, { timestamps: true })

module.exports = mongoose.model("Order", orderSchema);
