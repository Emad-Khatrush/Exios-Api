const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
  username: {
    type: String,
    required: true,
    trim: true,
  },
  customerId: {
    type: String,
    unique: true,
    trim: true,
  },
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  phone: {
    type: Number,
    required: true,
    unique: true,
  },
  city: {
    type: String,
  },
  password: {
    type: String,
    required: true,
  },
  imgUrl: {
    type: String,
  },
  isCanceled: {
    type: Boolean,
    default: false,
  },
  isAgreeToTermsOfCompany: {
    type: Boolean,
    default: false,
  },
  roles: {
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isEmployee: {
      type: Boolean,
      default: false,
    },
    isClient: {
      type: Boolean,
      default: false,
    },
    isAccountant: {
      type: Boolean,
      default: false,
    },
  },
  // Special Exios shipment prices (USD) for chosen customers: air is per KG, sea is per CBM.
  // Categories are free to add or remove; new customers start with Normal, Copy + Cosmetic, Medical.
  specialPrices: {
    enabled: { type: Boolean, default: false },
    categories: [{
      _id: false,
      name: { type: String, trim: true },
      air: Number,
      sea: Number,
    }],
    note: String,
    updatedAt: Date,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  // Passport verification required at registration; customer can use the app while pending
  // for the first time, but must re-upload if an admin rejects it, and stays blocked while
  // that re-upload is pending review (wasRejected tracks that, since status alone can't
  // tell a first-time pending apart from a pending-after-rejection).
  passportVerification: {
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    imageUrl: { type: String },
    rejectionReason: { type: String },
    wasRejected: { type: Boolean, default: false },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
}, { timestamps: true });

userSchema.methods.matchPassword = async function(password) {
  return await bcrypt.compare(password, this.password);
}

userSchema.methods.getSignedToken = function() {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  })
}

module.exports = mongoose.model("User", userSchema);
