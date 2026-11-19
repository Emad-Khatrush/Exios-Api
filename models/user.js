const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
  walletPostingVersion: { type: Number, default: 0 },
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
  // The office a staff member works in (an accounting office code): their expenses are recorded on
  // that office and paid from its cash box. Set by the owner in Accounting > Access.
  office: {
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
  // Wrong passwords in a row (counted from the first one in the current window), and until when
  // sign-in is paused after too many. Never sent out with the account.
  failedLoginCount: { type: Number, default: 0, select: false },
  failedLoginSince: { type: Date, select: false },
  loginLockedUntil: { type: Date, select: false },
  isAgreeToTermsOfCompany: {
    type: Boolean,
    default: false,
  },
  // Every time the customer agreed to the company's terms: which version, how ('signup' or 'prompt'
  // when asked again after a change), when, and from where. Kept so the agreement can be shown later;
  // added to, never edited. See utils/termsAcceptance.
  termsAcceptance: [{
    _id: false,
    version: String,
    via: { type: String, enum: ['signup', 'prompt'] },
    acceptedAt: Date,
    ip: String,
    userAgent: String,
  }],
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
  walletExchangeVersion: { type: Number, default: 0 },
  // Loyalty level (accounting/services/loyalty/tiers.js). No level saved = the first level.
  // `reviewAt`: when the level is checked again (a year after it was reached or kept).
  // `seen`: the last level the app celebrated. `history`: every change, newest last.
  // Loyalty points switched off for this customer (partners on a special price): set by staff with a
  // reason; absent = on. accounting/services/loyalty/index.js (isOff / setOff)
  loyaltyOff: { at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String },
  // The client app's notifications page was last opened then: what came after it is unread
  notificationsSeenAt: Date,
  loyaltyTier: {
    level: String,
    since: Date,
    reviewAt: Date,
    seen: String,
    manual: { reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date },
    history: [{
      _id: false,
      from: String,
      to: String,
      at: Date,
      why: { type: String, enum: ['upgrade', 'review', 'manual'] },
      reason: String,
      by: { type: Schema.Types.ObjectId, ref: 'User' },
    }],
  },
  // What a staff member who is not an admin may open (constants/staffPermissions.js), set by an admin
  // or an owner in Settings > Permissions. `kind` is the type of work (data entry, cashier...). No kind
  // yet: the person keeps the access their role gave before permissions existed
  // (middleware/permissions.js), until someone saves theirs.
  staffAccess: {
    kind: String,
    permissions: { type: [String], default: undefined },
    updatedAt: Date,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
}, { timestamps: true });

// Sent as JSON (the account in the apps), a switched-off points flag keeps only its date: why and by
// whom are staff notes (staff read them from GET user/:id/loyalty → offInfo)
userSchema.set('toJSON', {
  transform(doc, ret) {
    if (ret.loyaltyOff) ret.loyaltyOff = ret.loyaltyOff.at ? { at: ret.loyaltyOff.at } : undefined;
    return ret;
  },
});

userSchema.methods.matchPassword = async function(password) {
  return await bcrypt.compare(password, this.password);
}

userSchema.methods.getSignedToken = function() {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  })
}

module.exports = mongoose.model("User", userSchema);
