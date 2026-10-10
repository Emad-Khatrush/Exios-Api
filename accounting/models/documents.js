// Documents entered in the accounting section (spec 4.2). Every financial document shares the
// same lifecycle fields (spec 7-ج.5): draft -> posted -> canceled, never deleted once posted.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const attachmentSchema = new Schema({
  filename: String, path: String, folder: String, bytes: String, fileType: String, description: String,
}, { _id: false });

const lifecycle = {
  number: { type: String },
  status: { type: String, enum: ['draft', 'posted', 'canceled'], default: 'posted' },
  entryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  canceledAt: Date,
  canceledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelReason: String,
  reversalEntryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  replacedBy: Schema.Types.ObjectId,
  replaces: Schema.Types.ObjectId,
  // Sent by the UI so a double click never creates two documents
  idempotencyKey: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  attachments: [attachmentSchema],
  note: String,
};

const withLifecycle = (definition, options = {}) => {
  const schema = new Schema({ ...definition, ...lifecycle }, { timestamps: true, ...options });
  schema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
  schema.index({ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
  schema.index({ status: 1, day: -1 });
  return schema;
};

const vendorSchema = new Schema({
  costPostingVersion: { type: Number, default: 0 },
  name: { type: String, required: true, trim: true },
  // Only automatically discovered merchants use this key; manual/historical vendors stay valid.
  bankNameKey: String,
  bankAliases: [String],
  bankPurpose: { type: String, enum: ['china_services', 'yuan_purchase'] },
  bankAccountCode: String,
  bankOffice: String,
  bankMappings: [{ _id: false, accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
    merchant: String, counterAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' } }],
  // 'funder': a third party whose card buys for us (a friend); we settle with them later (spec 19.13)
  type: { type: String, enum: ['carrier', 'supplier', 'service', 'funder', 'other'], default: 'supplier' },
  phone: String,
  country: String,
  defaultCurrency: { type: String, default: 'USD' },
  // A partner who is both a customer and a vendor (netting)
  linkedCustomer: { type: Schema.Types.ObjectId, ref: 'User' },
  note: String,
  // Created by setup (historical vendors, cash expenses); cannot be deleted
  seedKey: { type: String },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });
vendorSchema.index({ bankNameKey: 1 }, { unique: true, partialFilterExpression: { bankNameKey: { $type: 'string' } } });
const Vendor = mongoose.model('AccountingVendor', vendorSchema);

const billLineSchema = new Schema({
  purchaseItemId: { type: Schema.Types.ObjectId },
  description: { type: String, required: true },
  // In the bill currency
  amount: { type: Number, required: true },
  // customs: the clearance of one package, owed to the clearing agent and sold to the customer
  // with the package (its cost waits until that sale is recognised)
  target: { type: String, enum: ['order', 'trip', 'expense', 'asset', 'prepaid', 'customs'], required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  packageId: { type: Schema.Types.ObjectId },
  tripId: { type: Schema.Types.ObjectId, ref: 'Inventory' },
  // A trip's cost by kind, for the trip report (spec v8): shipping, customs, clearance, transport, other
  costCategory: { type: String, enum: ['shipping', 'customs', 'clearance', 'transport', 'other', null] },
  // expense: the expense account; asset: the fixed asset account (1501xx)
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  asset: { name: String, usefulLifeMonths: Number, salvageValue: Number },
  prepaid: { expenseAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' }, months: Number, startMonth: String },
  office: String,
  // Filled when posted
  usd: Number,
  assetId: Schema.Types.ObjectId,
  prepaidId: Schema.Types.ObjectId,
});

const SupplierBill = mongoose.model('AccountingSupplierBill', withLifecycle({
  duplicateDecision: String,
  duplicateReason: String,
  duplicateFingerprint: String,
  vendorId: { type: Schema.Types.ObjectId, ref: 'AccountingVendor', required: true },
  vendorRef: String,
  vendorRefKind: { type: String, enum: ['invoice', 'bank'] },
  importReference: String,
  importHash: String,
  day: { type: String, required: true },
  currency: { type: String, required: true },
  rate: Number,
  lines: { type: [billLineSchema], required: true },
  total: Number,
  totalUsd: Number,
  alipayValuationUsd: Number,
  alipayValuationAdjustmentUsd: Number,
  alipayValuationProvisional: Boolean,
  alipayValuationEntryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  // Incremented transactionally when a payment or refund is allocated to this bill.
  allocationVersion: { type: Number, default: 0 },
  isCreditNote: { type: Boolean, default: false },
  originalBillId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  // Cash/bank account, or the employee advances account with employeeId, paid on the spot
  paidImmediatelyFrom: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  employeeId: { type: Schema.Types.ObjectId, ref: 'User' },
  paymentId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierPayment' },
  // The payable account the bill was posted to (carriers or suppliers); payments use the same one
  payableAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  isHistorical: { type: Boolean, default: false },
  migrationRunId: String,
  // Paid before the count day, out of cash the count already left out (spec v8): posted against the
  // opening balance, so the boxes counted on that day are not reduced a second time
  paidBeforeCount: { type: Boolean, default: false },
  // Entered through the quick expense screen
  isQuickExpense: { type: Boolean, default: false },
  // Entered by office staff on the system's Expenses screen (spec 19.1): their office, the type
  officeExpense: { type: Boolean, default: false },
  office: String,
  expenseTypeId: { type: Schema.Types.ObjectId, ref: 'AccountingExpenseType' },
  // Entered from an operations screen (trip page, order page) rather than the accounting section
  enteredFrom: { type: String, enum: ['accounting', 'trip', 'order', 'officeExpense', null], default: null },
}));

const SupplierPayment = mongoose.model('AccountingSupplierPayment', withLifecycle({
  batchTrial: Boolean,
  historicalSettlementVersion: { type: Number, default: 0 },
  // Automatic remittance valuation; original bill/payment and payable allocations stay intact.
  alipayValuationUsd: Number,
  alipayValuationAdjustmentUsd: Number,
  alipayValuationProvisional: Boolean,
  alipayValuationEntryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },

  vendorId: { type: Schema.Types.ObjectId, ref: 'AccountingVendor', required: true },
  day: { type: String, required: true },
  // Paid from this cash/bank/e-wallet (or employee advances); null when an advance is applied
  fromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  employeeId: { type: Schema.Types.ObjectId, ref: 'User' },
  fromAdvance: { type: Boolean, default: false },
  currency: String,
  amount: Number,
  rate: Number,
  // USD cents taken off each bill; the rest of the payment is an advance to the vendor
  allocations: [{ _id: false, billId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' }, amountUsd: Number }],
  advanceUsd: { type: Number, default: 0 },
  // The difference between what was paid and what the bills said, put on the bills' cost (USD
  // cents, + paid more, - paid less): the cost is what the money really cost (owner 2026-10-04)
  costDifferenceUsd: { type: Number, default: 0 },
  autoFromBillId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  isHistorical: { type: Boolean, default: false },
  migrationRunId: String,
}));

// Money a vendor gives us (spec 19.13): back from an advance we paid, the refund of a credit note,
// or simply held for them (e.g. a supplier put 50 yuan in our Alipay)
const SupplierReceipt = mongoose.model('AccountingSupplierReceipt', withLifecycle({
  vendorId: { type: Schema.Types.ObjectId, ref: 'AccountingVendor', required: true },
  day: { type: String, required: true },
  toAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  currency: String,
  amount: Number,
  rate: Number,
  // USD cents settling each credit note; the rest goes on the vendor's advance balance
  allocations: [{ _id: false, billId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' }, amountUsd: Number }],
  advanceUsd: { type: Number, default: 0 },
}));

// Writing off what a customer still owes on a delivered package or a purchase invoice (spec 19.7):
// the unpaid part leaves the receivable against its deferred revenue, the paid part becomes revenue
// and the whole cost is recognised, so the real loss shows. A later payment brings revenue back.
const ClaimWriteOff = mongoose.model('AccountingClaimWriteOff', withLifecycle({
  day: { type: String, required: true },
  arKey: { type: String, required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  partnerId: { type: Schema.Types.ObjectId, ref: 'User' },
  amountUsd: { type: Number, required: true },
  reason: { type: String, required: true },
}));

// Yuan bought from a broker for the Alipay accounts (spec 19.5): paid in dollars (or another
// currency), received in yuan; its rate is yuan / dollar. Until the yuan arrives the dollars wait
// on "yuan in transit" against the broker.
const YuanPurchase = mongoose.model('AccountingYuanPurchase', withLifecycle({
  // The cash left once in this supplier payment; this document reclassifies its excess.
  fundedFromPaymentId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierPayment', index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'AccountingVendor', required: true },
  day: { type: String, required: true },
  fromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  currency: String,
  amount: Number,
  // USD cents that left
  usd: Number,
  toAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  cnyExpected: Number,
  cnyReceived: Number,
  arrived: { type: Boolean, default: true },
  arrivedDay: String,
  rate: Number,
}));

// Money a supplier gave back on a purchase, part of it added to the customer's wallet (spec 19.6)
const CustomerRefund = mongoose.model('AccountingCustomerRefund', withLifecycle({
  fundedFromPendingBankLineId: { type: Schema.Types.ObjectId, ref: 'AccountingBankStatementLine' },
  bankValuationBeforeUsd: Number,
  bankValuationEntryIds: [{ type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' }],
  bankLineId: { type: Schema.Types.ObjectId, ref: 'AccountingBankStatementLine' },
  billId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  billLineId: Schema.Types.ObjectId,
  originalAmount: Number,
  originalCurrency: String,
  day: { type: String, required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  partnerId: { type: Schema.Types.ObjectId, ref: 'User' },
  // Where the money came in, in its currency, and its real dollar value (USD cents)
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  currency: String,
  amount: Number,
  usd: Number,
  // USD cents added to the customer's wallet
  walletUsd: { type: Number, default: 0 },
  userStatementId: Schema.Types.ObjectId,
}));

const TreasuryTransfer = mongoose.model('AccountingTreasuryTransfer', withLifecycle({
  day: { type: String, required: true },
  fromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  fromAmount: { type: Number, required: true },
  toAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  toAmount: { type: Number, required: true },
  // Legacy transfers paid fees from the sending account; new transfers select the paying account.
  fees: { type: Number, default: 0 },
  feesFromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  feesCurrency: String,
  feesAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  employeeId: { type: Schema.Types.ObjectId, ref: 'User' },
}));

const CashCount = mongoose.model('AccountingCashCount', withLifecycle({
  day: { type: String, required: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  // In the account currency, as typed
  countedAmount: { type: Number, required: true },
  systemAmount: Number,
  difference: Number,
}));

const FixedAsset = mongoose.model('AccountingFixedAsset', withLifecycle({
  name: { type: String, required: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  office: String,
  purchaseDay: { type: String, required: true },
  // USD cents
  cost: { type: Number, required: true },
  salvageValue: { type: Number, default: 0 },
  usefulLifeMonths: { type: Number, required: true },
  method: { type: String, default: 'straight_line' },
  depreciationPosted: [{ _id: false, month: String, amount: Number, entryId: Schema.Types.ObjectId }],
  assetStatus: { type: String, enum: ['active', 'fully_depreciated', 'disposed'], default: 'active' },
  disposal: { day: String, proceeds: Number, toAccountId: Schema.Types.ObjectId, rate: Number, entryId: Schema.Types.ObjectId },
  sourceBillId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
}));

const PrepaidExpense = mongoose.model('AccountingPrepaidExpense', withLifecycle({
  description: { type: String, required: true },
  expenseAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  office: String,
  // USD cents
  total: { type: Number, required: true },
  months: { type: Number, required: true },
  startMonth: { type: String, required: true },
  amortizationPosted: [{ _id: false, month: String, amount: Number, entryId: Schema.Types.ObjectId }],
  sourceBillId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
}));

const SalaryPayment = mongoose.model('AccountingSalaryPayment', withLifecycle({
  employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  month: { type: String, required: true },
  day: { type: String, required: true },
  office: { type: String, required: true },
  currency: { type: String, required: true },
  rate: Number,
  grossAmount: { type: Number, required: true },
  // Same currency as the salary
  advanceDeduction: { type: Number, default: 0 },
  paidFromAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
}));

const EquityTransaction = mongoose.model('AccountingEquityTransaction', withLifecycle({
  type: { type: String, enum: ['capital_in', 'withdrawal', 'loan_in', 'loan_repayment'], required: true },
  partyName: { type: String, required: true },
  day: { type: String, required: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  amount: { type: Number, required: true },
  rate: Number,
}));

const Netting = mongoose.model('AccountingNetting', withLifecycle({
  vendorId: { type: Schema.Types.ObjectId, ref: 'AccountingVendor', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: String, required: true },
  mode: { type: String, enum: ['payable_to_ar', 'payable_to_wallet'], required: true },
  billId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill', required: true },
  arKey: String,
  walletCurrency: String,
  rate: Number,
  amountUsd: { type: Number, required: true },
  userStatementId: Schema.Types.ObjectId,
}));

const bankLineSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  day: { type: String, required: true },
  description: String,
  reference: String,
  // Minor units of the account currency: positive = money in, negative = money out
  sourceProvider: { type: String, enum: ['alipay'] },
  sourceCurrency: String,
  sourceTransactionId: String,
  merchantOrderId: String,
  counterparty: String,
  paymentMethod: String,
  transactionStatus: String,
  sourceTime: String,
  walletImpact: { type: String, enum: ['balance', 'unknown', 'confirmed'] },
  sourceReviewReason: String,
  amount: { type: Number, required: true },
  balanceAfter: Number,
  matchedEntryIds: [{ type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' }],
  lineStatus: { type: String, enum: ['unmatched', 'matched', 'created_entry', 'ignored'], default: 'unmatched' },
  entryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
  importBatchId: String,
  // Preserve previous postings when a user reverses and corrects this line.
  historyEntryIds: [{ type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' }],
  postingAttempt: { type: Number, default: 0 },
  pendingRefund: { type: Boolean, default: false },
  pendingClaimVersion: { type: Number, default: 0 },
  pendingRefundAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
  tripCostSettlementId: { type: Schema.Types.ObjectId, ref: 'AccountingTripCostSettlement' },
  // Parked as unidentified ("لا أعرف بعد"): the bank side is posted against a clearing account
  // until the line is explained, or the owner decides where it goes after its waiting period
  // A partner's line dated before the count, tied to the wallet deposits it was (no entry: the count holds it)
  partnerStatementIds: [{ type: Schema.Types.ObjectId, ref: 'UserStatement' }],
  // A line of the count period with nothing to post (a transfer between two counted accounts): why
  coveredNote: String,
  // Supplier payments this line made for a partner's grouped Alipay transfers (cancelled with the match)
  groupPaymentIds: [{ type: Schema.Types.ObjectId, ref: 'AccountingSupplierPayment' }],
  unidentified: {
    status: { type: String, enum: ['open', 'decided', 'resolved'] },
    hint: { type: String, enum: ['purchase', 'shipping', 'refund', 'customer', 'expense', 'unknown'] },
    note: String,
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User' },
    parkedAt: Date,
    parkedDay: String,
    parkedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    clearingAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
    decision: {
      kind: String,
      accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount' },
      reason: String,
      day: String,
      entryId: { type: Schema.Types.ObjectId, ref: 'AccountingJournalEntry' },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: Date,
    },
  },
  // A purchase or expense line becomes a supplier bill and its payment
  billId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  paymentId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierPayment' },
  // What the other account received when it is in another currency (dollars sold for lira)
  counterAmount: Number,
  counterCurrency: String,
  originalAmount: Number,
  originalCurrency: String,
  matchedOriginalAmount: Number,
  matchedOriginalCurrency: String,
  matchDifferenceConfirmed: Boolean,
  purchaseReviewPending: Boolean,
  historicalPurchase: { type: Boolean, default: false },
  historicalCovered: { type: Boolean, default: false },
  historicalSettlementPaymentId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierPayment' },
  historicalSettlementUsd: Number,
  movementKind: { type: String, enum: ['purchase', 'purchase_refund', 'card_payment'] },
  receiptId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierReceipt' },
  customerRefundId: { type: Schema.Types.ObjectId, ref: 'AccountingCustomerRefund' },
  creditNoteId: { type: Schema.Types.ObjectId, ref: 'AccountingSupplierBill' },
  refundCreditCreated: Boolean,
  settlementUsd: Number,
  exchangeRate: Number,
  valuationSource: String,
  crossRate: Number,
  rateBaseCurrency: String,
  rateQuoteCurrency: String,
  valuationUsd: Number,
  // Cancellation must leave a supplier invoice entered before the statement intact.
  billCreatedFromStatement: Boolean,
  // A website purchase linked to the order it was bought for (one purchase cost of that order)
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  purchaseItemId: Schema.Types.ObjectId,
  // Same account, day, amount and normalised text (+ its repeat number that day): a line already
  // imported from an earlier file is recognised and not imported twice
  fingerprint: String,
  fingerprintAliases: [String],
  fingerprintRepeat: Number,
  importedValues: Schema.Types.Mixed,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
bankLineSchema.index({ accountId: 1, lineStatus: 1, day: 1 });
bankLineSchema.index({ historicalSettlementPaymentId: 1 }, { unique: true, partialFilterExpression: { lineStatus: 'created_entry', historicalSettlementPaymentId: { $exists: true } } });
bankLineSchema.index({ accountId: 1, fingerprint: 1 });
bankLineSchema.index({ accountId: 1, fingerprintAliases: 1 });
bankLineSchema.index({ accountId: 1, sourceProvider: 1, sourceTransactionId: 1 });
const BankStatementLine = mongoose.model('AccountingBankStatementLine', bankLineSchema);

const ExpenseType = mongoose.model('AccountingExpenseType', new Schema({
  name: { type: String, required: true },
  nameEn: String,
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  defaultOffice: String,
  seedKey: String,
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true }));

// A statement line whose text contains the keyword is posted to this account (the owner teaches
// the system once: bank fees, rent paid by transfer, a supplier paid from the bank...)
const BankRule = mongoose.model('AccountingBankRule', new Schema({
  // null = every bank and e-wallet
  accountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', default: null },
  keyword: { type: String, required: true, trim: true },
  direction: { type: String, enum: ['in', 'out', 'any'], default: 'any' },
  counterAccountId: { type: Schema.Types.ObjectId, ref: 'AccountingAccount', required: true },
  office: String,
  // Set on the rules the setup creates, so running it again does not add them twice
  seedKey: String,
  // Higher wins when several rules fit a line; weak hints (a country, "limited") are below 0
  priority: { type: Number, default: 0 },
  // The vendor a purchase or expense is billed to ("Alibaba", "Google"); '@bank' = the bank itself
  // (its charges); empty = the merchant written on the line
  vendorName: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true }));

module.exports = {
  BankRule,
  Vendor,
  SupplierBill,
  SupplierPayment,
  SupplierReceipt,
  ClaimWriteOff,
  YuanPurchase,
  CustomerRefund,
  TreasuryTransfer,
  CashCount,
  FixedAsset,
  PrepaidExpense,
  SalaryPayment,
  EquityTransaction,
  Netting,
  BankStatementLine,
  ExpenseType,
};
