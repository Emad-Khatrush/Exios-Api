const mongoose = require('mongoose');
const { Schema } = mongoose;

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

// A node of the chart of accounts. Groups only hold children; entries are posted on detail
// accounts. Entries point to the account by _id, so the code and the parent can change freely.
const accountSchema = new Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, trim: true },
  type: { type: String, enum: ACCOUNT_TYPES, required: true },
  isGroup: { type: Boolean, default: false },
  parentId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', default: null },
  // null = valued in USD only. Otherwise every line carries the amount in this currency too.
  currency: { type: String, default: null },
  // Cash box, bank or e-wallet: shows up in payment screens and has its own journal
  isCash: { type: Boolean, default: false },
  cashKind: { type: String, enum: ['cash', 'bank', 'ewallet', 'current', null], default: null },
  // A sub cash box (spec v8): the office's day-to-day box that system operations post to; the
  // accountant hands its money over to the office's main box
  subBox: { type: Boolean, default: false },
  // AccountingOffice.code the cash account belongs to
  office: { type: String, default: null },
  // Dimensions every line on this account must carry: partner, vendor, employee, trip, order, package, office
  requires: { type: [String], default: [] },
  allowManualEntry: { type: Boolean, default: true },
  cashFlowCategory: { type: String, enum: ['operating', 'investing', 'financing', null], default: null },
  isActive: { type: Boolean, default: true },
  // Transactional mutex for operations that spend from this account and must recheck its balance.
  postingVersion: { type: Number, default: 0 },
  sortOrder: { type: Number, default: 0 },
  // Set on accounts created by the setup script, so re-running it recognises them even
  // after their code or name was changed by hand
  seedKey: { type: String, default: undefined },
  // The account in Odoo that this one is exported to (its code there)
  odooCode: { type: String, trim: true, default: '' },
  odooExternalId: { type: String, trim: true, default: '' },
}, { timestamps: true });

accountSchema.index({ seedKey: 1 }, { unique: true, sparse: true });

accountSchema.index({ parentId: 1, sortOrder: 1 });

module.exports = mongoose.model('AccountingAccount', accountSchema);
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
