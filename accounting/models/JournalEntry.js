const mongoose = require('mongoose');
const { Schema } = mongoose;

const lineSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  // Display copy only; renaming an account's code never breaks an entry
  accountCode: String,
  // USD in cents
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  currency: String,
  // In the smallest unit of `currency`: positive = debit, negative = credit
  amountCurrency: Number,
  rate: Number,
  partnerId: { type: Schema.Types.ObjectId, ref: 'User' },
  vendorId: { type: Schema.Types.ObjectId },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  packageId: { type: Schema.Types.ObjectId },
  tripId: { type: Schema.Types.ObjectId, ref: 'Inventory' },
  employeeId: { type: Schema.Types.ObjectId, ref: 'User' },
  assetId: { type: Schema.Types.ObjectId },
  prepaidId: { type: Schema.Types.ObjectId },
  office: String,
  tags: [{ type: Schema.Types.ObjectId }],
  arKey: String,
  apKey: String,
  label: String,
}, { _id: false });

const journalEntrySchema = new Schema({
  number: { type: String, required: true, unique: true },
  journalId: { type: Schema.Types.ObjectId, ref: 'AccountingJournal', required: true },
  date: { type: Date, required: true },
  // The accounting day in Libya time (YYYY-MM-DD); reports and the lock date work on this
  day: { type: String, required: true },
  // Economic date retained when a closed period shifts the posting to an open day.
  originalDay: String,
  description: String,
  eventType: { type: String, required: true },
  eventKey: { type: String, required: true, unique: true },
  source: {
    model: String,
    id: Schema.Types.ObjectId,
  },
  status: { type: String, enum: ['posted', 'reversed'], default: 'posted' },
  reversalOf: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  reversedBy: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  // Claim entries of a cancelled or deleted order that net to zero: hidden with the cancelled ones
  hiddenWithCancel: { type: Boolean, default: false },
  lines: { type: [lineSchema], required: true },
  // Bank statement reconciliation can match one journal entry once per cash account. Written
  // transactionally to prevent concurrent statement lines from claiming the same movement.
  bankMatchedAccounts: [{ type: Schema.Types.ObjectId, ref: 'AccountingAccount' }],
  bankSourceReference: String,
  bankSourceAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  // Contention point for concurrent nettings against the same customer receivable claim.
  claimAllocationVersion: { type: Number, default: 0 },
  // Contention point for concurrent repayments against the company loan balance.
  loanAllocationVersion: { type: Number, default: 0 },
  totalDebit: Number,
  attachments: [{
    filename: String,
    path: String,
    folder: String,
    bytes: String,
    fileType: String,
    description: String,
  }],
  notes: [String],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isHistorical: { type: Boolean, default: false },
  migrationRunId: String,
  // Assumptions made while posting (derived rate, fallback date, missing office...)
  fallbacks: [String],
  exportedToOdooAt: Date,
  // The Odoo export batch that took this entry (cleared when the batch is undone)
  odooExportId: { type: Schema.Types.ObjectId, ref: 'AccountingOdooExport' },
}, { timestamps: true });

journalEntrySchema.index({ 'lines.accountId': 1, day: 1 });
journalEntrySchema.index({ day: 1, number: 1 });
journalEntrySchema.index({ journalId: 1, day: 1 });
journalEntrySchema.index({ 'lines.partnerId': 1 });
journalEntrySchema.index({ 'lines.vendorId': 1 });
journalEntrySchema.index({ 'lines.arKey': 1 });
journalEntrySchema.index({ 'lines.apKey': 1 });
journalEntrySchema.index({ 'lines.tripId': 1 });
journalEntrySchema.index({ 'lines.orderId': 1 });
journalEntrySchema.index({ 'source.model': 1, 'source.id': 1 });
journalEntrySchema.index({ bankSourceAccountId: 1, bankSourceReference: 1 }, {
  unique: true, partialFilterExpression: { bankSourceReference: { $type: 'string' }, status: 'posted' },
});

module.exports = mongoose.model('AccountingJournalEntry', journalEntrySchema);
