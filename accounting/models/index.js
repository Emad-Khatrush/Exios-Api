const mongoose = require('mongoose');
const { Schema } = mongoose;

const Account = require('./Account');
const JournalEntry = require('./JournalEntry');

const JOURNAL_TYPES = ['cash', 'bank', 'ewallet', 'sales', 'purchases', 'wallet', 'general', 'fx', 'depreciation', 'migration'];

const Journal = mongoose.model('AccountingJournal', new Schema({
  // Fixed once the journal has entries, so numbering never changes
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  name: { type: String, required: true },
  type: { type: String, enum: JOURNAL_TYPES, required: true },
  // Cash, bank and e-wallet journals: the account they belong to
  defaultAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', default: null },
  office: { type: String, default: null },
  sequencePrefix: { type: String, required: true },
  sequenceResetYearly: { type: Boolean, default: true },
  // Name of the matching journal in Odoo; empty = the default journal of the Odoo export
  odooJournal: { type: String, trim: true, default: '' },
  odooExternalId: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true }));

// Named AccountingOffice because the system already has an `Office` model (old cash totals)
const AccountingOffice = mongoose.model('AccountingOffice', new Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true },
  nameEn: String,
  country: String,
  isActive: { type: Boolean, default: true },
}, { timestamps: true }));

const Currency = mongoose.model('AccountingCurrency', new Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  name: { type: String, required: true },
  decimals: { type: Number, required: true, min: 0, max: 4 },
  symbol: String,
  isBase: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: true }));

// Daily rates: units of the currency for 1 USD (rate 9 = 1$ is 9 LYD)
const currencyRateSchema = new Schema({
  currency: { type: String, required: true },
  day: { type: String, required: true },
  rate: { type: Number, required: true, min: 0 },
  // Set once a posted entry used this rate; it can no longer be changed
  isUsed: { type: Boolean, default: false },
  // 'entered' by a person (or imported), 'derived' by the historical migration from the rates
  // written on that day's operations
  source: { type: String, enum: ['entered', 'derived'], default: 'entered' },
  migrationRunId: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
currencyRateSchema.index({ currency: 1, day: 1 }, { unique: true });
const CurrencyRate = mongoose.model('AccountingCurrencyRate', currencyRateSchema);

// One document (key 'main')
const AccountingSettings = mongoose.model('AccountingSettings', new Schema({
  key: { type: String, default: 'main', unique: true },
  // Last locked day (YYYY-MM-DD); nothing can be posted on or before it
  lockDate: { type: String, default: null },
  periodVersion: { type: Number, default: 0 },
  historyStartDate: { type: String, default: null },
  // Day the historical migration was committed; live posting starts after it
  migrationDate: { type: String, default: null },
  // While a migration dry run waits for review, nothing else may be posted on or before this day
  migrationGuardDay: { type: String, default: null },
  // role -> account _id
  accountRoles: { type: Schema.Types.Mixed, default: {} },
  // office code -> { currency: account _id }
  officeAccounts: { type: Schema.Types.Mixed, default: {} },
  // { office: { currency: accountId } } of the sub cash boxes (spec v8): every cash operation made
  // from the system's screens after go-live posts to the sub box of the staff member's office
  subOfficeAccounts: { type: Schema.Types.Mixed, default: {} },
  // UserStatement.office values that are an account of an office, not an office (value -> office code)
  officeAliases: { type: Schema.Types.Mixed, default: {} },
  // event type -> journal code, or '@cash' for the journal of the cash account on the entry
  eventJournals: { type: Schema.Types.Mixed, default: {} },
  fiscalYearStartMonth: { type: Number, default: 1, min: 1, max: 12 },
  // The exact instant history ended and live posting began: everything created before it was
  // posted by the historical migration, everything after by live posting (spec 19.11)
  cutoffAt: { type: Date, default: null },
  // Delivered and unpaid for longer than this many days: listed for a write-off decision (spec 19.7)
  writeOffAfterDays: { type: Number, default: 180 },
  // No rate on or before an operation's day: use the first rate after it (marked on the entry)
  rateFallbackNext: { type: Boolean, default: true },
  // Volumetric weight of a package = its CBM x this factor (KG per CBM); used when the package is
  // marked "charged by volume"
  volumetricFactor: { type: Number, default: 167 },
  // A package that arrived and was not collected for this many days is listed as abandoned
  abandonAfterDays: { type: Number, default: 365 },
  // A bank line parked as unidentified waits this long for the owner's final decision:
  // money out 90 days, money in (possibly a customer's) a year
  unidentifiedOutDays: { type: Number, default: 90 },
  unidentifiedInDays: { type: Number, default: 365 },
  timezone: { type: String, default: 'Africa/Tripoli' },
  // Live posting of the system's own operations (deposits, orders, deliveries...). Off until the
  // historical migration is committed, so history and live never overlap.
  liveEnabled: { type: Boolean, default: false },
  // A claim counts as paid when at most this much is left (the delivery screen accepts 2$ short)
  recognitionToleranceCents: { type: Number, default: 200 },
  // Office used on revenue/expense lines when an operation has none
  defaultOffice: { type: String, default: 'tripoli' },
  setupCompletedAt: Date,
  wizard: { type: Schema.Types.Mixed, default: {} },
  // Odoo export: { companyCurrency: 'USD' | 'LYD', defaultJournal }
  odoo: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false }));

const Counter = mongoose.model('AccountingCounter', new Schema({
  _id: String,
  seq: { type: Number, default: 0 },
}));

const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  model: String,
  docId: Schema.Types.ObjectId,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  ip: String,
  at: { type: Date, default: Date.now },
});
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ model: 1, docId: 1 });
const AuditLog = mongoose.model('AccountingAuditLog', auditLogSchema);

// Outbox: an existing screen records "this happened" and the worker posts it in its own
// transaction, oldest first (spec 8: Outbox when the operation cannot share a transaction)
const accountingEventSchema = new Schema({
  type: { type: String, required: true },
  refId: { type: Schema.Types.ObjectId, required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  // 'covered': recorded before the historical migration read the data, so the migration posted it
  status: { type: String, enum: ['pending', 'done', 'failed', 'skipped', 'covered'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  processingVersion: { type: Number, default: 0 },
  lastError: String,
  result: Schema.Types.Mixed,
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  processedAt: Date,
}, { timestamps: true });
accountingEventSchema.index({ status: 1, createdAt: 1 });
const AccountingEvent = mongoose.model('AccountingEvent', accountingEventSchema);

// One run of the historical migration (spec 6-أ): dry run, report, then commit or discard
const MigrationRun = mongoose.model('AccountingMigrationRun', new Schema({
  runId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['running', 'review', 'failed', 'discarding', 'discarded', 'committing', 'committed'], default: 'running' },
  bankTrialEnabled: { type: Boolean, default: false },
  bankTrialVersion: { type: Number, default: 0 },
  // Everything that happened up to this moment is replayed; commit catches up what came after
  cutoff: { type: Date, required: true },
  // The moment the opening counts stand for when they were taken on the day of the run: the dry
  // run read the books then, so what was posted after it is not in the counts (set at commit)
  countAt: Date,
  historyStart: Date,
  config: {
    // [{ kind: 'trip' | 'order', key, accountId }] - which cash box paid old costs
    costAccounts: { type: Schema.Types.Mixed, default: [] },
    // [{ accountId, amount }] - counted balance of each cash box today (spec E22)
    openingCounts: { type: Schema.Types.Mixed, default: [] },
    // The day the counts were taken (balance at the end of that day); default: the run's day
    countDay: String,
    // Fold what history leaves in suspense into the opening balance (start from the counts)
    closeSuspense: { type: Boolean, default: false },
    // Purchase costs from the account statements only: purchases typed on orders are not bills
    purchaseCostsFromStatements: { type: Boolean, default: false },
  },
  progress: { phase: String, done: Number, total: Number },
  report: Schema.Types.Mixed,
  // Records that could not be replayed (the run goes on without them)
  problems: [{ _id: false, at: Date, source: String, ref: String, message: String }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  startedAt: Date,
  finishedAt: Date,
  committedAt: Date,
  message: String,
}, { timestamps: true }));

// Result of the daily reconciliation (spec 10), one document per day
const Reconciliation = mongoose.model('AccountingReconciliation', new Schema({
  day: { type: String, required: true, unique: true },
  ranAt: Date,
  errorCount: Number,
  warningCount: Number,
  results: Schema.Types.Mixed,
}, { timestamps: true }));

// A review item the accountant looked at and accepted (an old purchase whose cost will never be
// known, a trip that really had no cost): it leaves the daily list until the mark is taken back.
// Errors cannot be marked; only items to review and notices
const ReviewedItem = mongoose.model('AccountingReviewedItem', new Schema({
  check: { type: String, required: true },
  ref: { type: String, required: true },
  label: String,
  note: String,
  by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }).index({ check: 1, ref: 1 }, { unique: true }));

// A printed receipt or payment voucher (spec 7): one per entry that moved cash, numbered in its
// own series the first time it is printed
const Voucher = mongoose.model('AccountingVoucher', new Schema({
  entryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry', required: true, unique: true },
  kind: { type: String, enum: ['receipt', 'payment'], required: true },
  number: { type: String, required: true, unique: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));

// One export of journal entries to Odoo (spec 13). Its entries carry odooExportId; undoing the
// batch puts them back as not exported.
const OdooExport = mongoose.model('AccountingOdooExport', new Schema({
  number: { type: String, required: true, unique: true },
  // Every unexported entry up to this day was taken
  upTo: { type: String, required: true },
  firstDay: String,
  lastDay: String,
  entryIds: [{ type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' }],
  count: Number,
  // USD cents
  totalDebit: Number,
  companyCurrency: String,
  referenceMode: { type: String, enum: ['mapping', 'external_id'], default: 'mapping' },
  accountReferences: { type: Schema.Types.Mixed, default: undefined },
  journalReferences: { type: Schema.Types.Mixed, default: undefined },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  undoneAt: Date,
  undoneBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));

// The weekly check while Odoo still runs beside Exios (spec 19.14): three figures from each side
// on the same day. USD cents.
const figures = { _id: false, cash: Number, wallets: Number, receivables: Number };
const OdooComparison = mongoose.model('AccountingOdooComparison', new Schema({
  day: { type: String, required: true },
  ours: figures,
  odoo: figures,
  note: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));

// What an admin or accountant who is not the owner may do in accounting (services/access.js).
// No document = no access.
const AccountingMember = mongoose.model('AccountingMember', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  permissions: { type: [String], default: [] },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));

module.exports = {
  ReviewedItem,
  AccountingMember,
  OdooExport,
  OdooComparison,
  Voucher,
  Reconciliation,
  MigrationRun,
  AccountingEvent,
  Account,
  JournalEntry,
  Journal,
  AccountingOffice,
  Currency,
  CurrencyRate,
  AccountingSettings,
  Counter,
  AuditLog,
  JOURNAL_TYPES,
};
