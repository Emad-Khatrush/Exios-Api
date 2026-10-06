const mongoose = require('mongoose');
const { JournalEntry, Account } = require('../models');
const docs = require('../models/documents');
const User = require('../../models/user');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const { handle, badRequest, notFound, isObjectId, pick } = require('./util');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const { getConfig } = require('../services/config');
const { resolveAccount } = require('../services/roles');
const { getBalance } = require('../services/carrying');
const { cancelDocument, CANCELABLE_MODELS } = require('../services/cancel');
const payables = require('../services/posting/payables');
const treasury = require('../services/posting/treasury');
const schedules = require('../services/posting/schedules');
const people = require('../services/posting/people');
const bank = require('../services/posting/bank');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inTx = (fn) => runInTransaction(fn);

function listQuery(req, extra = {}) {
  const query = { ...extra };
  // Cancelled documents are hidden unless asked for ('all' or 'canceled'), spec 19.9
  if (req.query.status === 'all') { /* every status */ } else if (req.query.status) query.status = req.query.status;
  else query.status = { $ne: 'canceled' };
  if (req.query.from || req.query.to) {
    query.day = {};
    if (req.query.from) query.day.$gte = req.query.from;
    if (req.query.to) query.day.$lte = req.query.to;
  }
  return query;
}

const page = (req) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const current = Math.max(Number(req.query.page) || 1, 1);
  return { limit, skip: (current - 1) * limit, page: current };
};

async function paged(Model, query, req, populate = []) {
  const { limit, skip, page: current } = page(req);
  let find = Model.find(query).sort({ day: -1, createdAt: -1 }).skip(skip).limit(limit);
  populate.forEach((p) => { find = find.populate(p); });
  const [results, total] = await Promise.all([find.lean(), Model.countDocuments(query)]);
  return { results, total, page: current, limit };
}

// ---- Vendors ----

// Owed per vendor: credit - debit on payable lines with its vendorId
async function vendorBalances(vendorIds) {
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.vendorId': { $in: vendorIds } } },
    { $unwind: '$lines' },
    { $match: { 'lines.vendorId': { $in: vendorIds }, 'lines.apKey': { $exists: true } } },
    { $group: { _id: '$lines.vendorId', owed: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.owed]));
}

module.exports.listVendors = handle(async (req, res) => {
  const query = {};
  if (req.query.search) query.name = new RegExp(escapeRegex(req.query.search), 'i');
  if (req.query.active === 'true') query.isActive = true;
  const vendors = await docs.Vendor.find(query).sort({ name: 1 }).populate('linkedCustomer', 'firstName lastName customerId').lean();
  const balances = await vendorBalances(vendors.map((v) => v._id));
  res.json({ results: vendors.map((v) => ({ ...v, owed: balances.get(String(v._id)) || 0 })) });
});

module.exports.createVendor = handle(async (req, res) => {
  const body = pick(req.body, ['name', 'type', 'phone', 'country', 'defaultCurrency', 'linkedCustomer', 'note']);
  if (!String(body.name || '').trim()) throw badRequest('اسم المورد مطلوب');
  if (body.linkedCustomer === '') delete body.linkedCustomer;
  const vendor = await inTx(async (session) => {
    const [created] = await docs.Vendor.create([body], { session });
    await logAudit({ req, action: 'vendor.create', model: 'AccountingVendor', docId: created._id, after: created }, session);
    return created;
  });
  res.status(201).json(vendor);
});

module.exports.updateVendor = handle(async (req, res) => {
  const vendor = await docs.Vendor.findById(req.params.id);
  if (!vendor) throw notFound('المورد غير موجود');
  const before = vendor.toObject();
  const body = pick(req.body, ['name', 'type', 'phone', 'country', 'defaultCurrency', 'linkedCustomer', 'note']);
  if (body.linkedCustomer === '') body.linkedCustomer = null;
  Object.assign(vendor, body);
  await inTx(async (session) => {
    await vendor.save({ session });
    await logAudit({ req, action: 'vendor.update', model: 'AccountingVendor', docId: vendor._id, before, after: vendor }, session);
  });
  res.json(vendor);
});

module.exports.setVendorActive = (isActive) => handle(async (req, res) => {
  const vendor = await docs.Vendor.findById(req.params.id);
  if (!vendor) throw notFound('المورد غير موجود');
  if (!isActive) {
    const owed = (await vendorBalances([vendor._id])).get(String(vendor._id)) || 0;
    if (owed !== 0) throw badRequest(`رصيد المورد ليس صفراً (${owed / 100}$)`);
  }
  vendor.isActive = isActive;
  await inTx(async (session) => {
    await vendor.save({ session });
    await logAudit({ req, action: isActive ? 'vendor.unarchive' : 'vendor.archive', model: 'AccountingVendor', docId: vendor._id }, session);
  });
  res.json(vendor);
});

module.exports.deleteVendor = handle(async (req, res) => {
  const vendor = await docs.Vendor.findById(req.params.id);
  if (!vendor) throw notFound('المورد غير موجود');
  if (vendor.seedKey) throw badRequest('مورد النظام لا يُحذف');
  const used = await Promise.all([
    docs.SupplierBill.exists({ vendorId: vendor._id }), docs.SupplierPayment.exists({ vendorId: vendor._id }), docs.Netting.exists({ vendorId: vendor._id }),
  ]);
  if (used.some(Boolean)) return res.status(400).json({ success: false, message: 'لا يمكن الحذف - للمورد فواتير أو دفعات. أرشفه بدلاً من ذلك.', canArchive: true });
  await inTx(async (session) => {
    await docs.Vendor.deleteOne({ _id: vendor._id }, { session });
    await logAudit({ req, action: 'vendor.delete', model: 'AccountingVendor', docId: vendor._id, before: vendor }, session);
  });
  res.json({ success: true });
});

// Every payable movement of the vendor with a running balance (owed to the vendor)
module.exports.vendorStatement = handle(async (req, res) => {
  const vendor = await docs.Vendor.findById(req.params.id).lean();
  if (!vendor) throw notFound('المورد غير موجود');
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.vendorId': vendor._id } },
    { $sort: { day: 1, createdAt: 1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.vendorId': vendor._id, 'lines.apKey': { $exists: true } } },
    { $project: { number: 1, day: 1, description: 1, eventType: 1, status: 1, reversalOf: 1, source: 1, line: '$lines' } },
  ]);
  let owed = 0;
  const movements = rows.map((row) => {
    owed += row.line.credit - row.line.debit;
    return { ...row, owed };
  });
  const openBills = await openBillsFor(vendor._id);
  res.json({ vendor, movements, owed, openBills, advance: -(await payables.apBalance(payables.advanceKey(vendor._id))) });
});

async function openBillsFor(vendorId) {
  const bills = await docs.SupplierBill.find({ vendorId, status: 'posted', isCreditNote: { $ne: true } }).sort({ day: 1 }).lean();
  const result = [];
  for (const bill of bills) {
    const open = await payables.apBalance(payables.billKey(bill._id));
    if (open !== 0) result.push({ _id: bill._id, number: bill.number, day: bill.day, currency: bill.currency, total: bill.total, totalUsd: bill.totalUsd, open, vendorRef: bill.vendorRef });
  }
  return result;
}

module.exports.vendorOpenBills = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('المورد غير صالح');
  res.json({ results: await openBillsFor(oid(req.params.id)), advance: -(await payables.apBalance(payables.advanceKey(req.params.id))) });
});

// ---- Bills ----

// What is still owed on each bill, in USD cents (its payable lines, keyed BILL:<id>)
async function billsOpen(billIds) {
  if (!billIds.length) return new Map();
  const keys = billIds.map((id) => payables.billKey(id));
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.apKey': { $in: keys } } }, { $unwind: '$lines' },
    { $match: { 'lines.apKey': { $in: keys } } },
    { $group: { _id: '$lines.apKey', open: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]);
  return new Map(rows.map((row) => [row._id.slice('BILL:'.length), row.open]));
}

// A cent or two left by rounding counts as paid
const paymentStatusOf = (bill, open) => (open <= 2 ? 'paid' : open >= (bill.totalUsd || 0) - 2 ? 'unpaid' : 'partial');

module.exports.listBills = handle(async (req, res) => {
  const query = listQuery(req);
  if (isObjectId(req.query.vendorId)) query.vendorId = req.query.vendorId;
  if (isObjectId(req.query.tripId)) query['lines.tripId'] = oid(req.query.tripId);
  if (isObjectId(req.query.orderId)) query['lines.orderId'] = oid(req.query.orderId);
  if (req.query.quick === 'true') query.isQuickExpense = true;
  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ number: pattern }, { vendorRef: pattern }, { 'lines.description': pattern }];
  }
  if (isObjectId(req.query.expenseTypeId)) query.expenseTypeId = oid(req.query.expenseTypeId);
  if (req.query.office) query.office = req.query.office;
  if (req.query.target) query['lines.target'] = req.query.target;
  // Paid, partly paid or unpaid (owner's request 2026-10-04): what is still owed on each posted bill
  if (['paid', 'partial', 'unpaid'].includes(req.query.payment)) {
    const posted = await docs.SupplierBill.find({ ...query, status: 'posted', isCreditNote: { $ne: true } }).select('_id totalUsd').lean();
    const open = await billsOpen(posted.map((b) => b._id));
    query._id = { $in: posted.filter((b) => paymentStatusOf(b, open.get(String(b._id)) || 0) === req.query.payment).map((b) => b._id) };
  }
  const result = await paged(docs.SupplierBill, query, req, [{ path: 'vendorId', select: 'name type' }]);
  const open = await billsOpen(result.results.filter((b) => b.status === 'posted' && !b.isCreditNote).map((b) => b._id));
  result.results.forEach((bill) => {
    if (bill.status !== 'posted' || bill.isCreditNote) return;
    bill.open = open.get(String(bill._id)) || 0;
    bill.paymentStatus = paymentStatusOf(bill, bill.open);
  });
  // The order number and trip name of each line, so the list says what the cost is for
  const lines = result.results.flatMap((bill) => bill.lines || []);
  const [trips, orders] = await Promise.all([
    Inventory.find({ _id: { $in: lines.map((l) => l.tripId).filter(Boolean) } }).select('voyage').lean(),
    Order.find({ _id: { $in: lines.map((l) => l.orderId).filter(Boolean) } }).select('orderId').setOptions({ withDeleted: true }).lean(),
  ]);
  const names = new Map([...trips.map((t) => [String(t._id), t.voyage]), ...orders.map((o) => [String(o._id), o.orderId])]);
  result.results.forEach((bill) => {
    bill.refs = [...new Set((bill.lines || []).map((l) => names.get(String(l.orderId || l.tripId || ''))).filter(Boolean))];
  });
  res.json(result);
});

module.exports.getBill = handle(async (req, res) => {
  const bill = await docs.SupplierBill.findById(req.params.id).populate('vendorId', 'name type').populate('createdBy', 'firstName lastName').lean();
  if (!bill) throw notFound('الفاتورة غير موجودة');
  const [payments, creditNotes, entries] = await Promise.all([
    docs.SupplierPayment.find({ 'allocations.billId': bill._id }).select('number day status allocations amount currency').lean(),
    docs.SupplierBill.find({ originalBillId: bill._id }).select('number day status totalUsd').lean(),
    JournalEntry.find({ 'source.model': 'AccountingSupplierBill', 'source.id': bill._id }).select('number day status reversalOf').lean(),
  ]);
  const open = bill.status === 'posted' && !bill.isCreditNote ? await payables.apBalance(payables.billKey(bill._id)) : null;
  const tripIds = bill.lines.map((line) => line.tripId).filter(Boolean);
  const orderIds = bill.lines.map((line) => line.orderId).filter(Boolean);
  const [trips, orders] = await Promise.all([
    Inventory.find({ _id: { $in: tripIds } }).select('voyage shippingType inventoryPlace status').lean(),
    Order.find({ _id: { $in: orderIds } }).select('orderId customerInfo.fullName isDeleted').setOptions({ withDeleted: true }).lean(),
  ]);
  res.json({ bill, payments, creditNotes, entries, open, paymentStatus: open === null ? null : paymentStatusOf(bill, open), trips, orders });
});

module.exports.createBill = handle(async (req, res) => {
  const bill = await inTx((session) => payables.createBill(req.body, { session, req, asDraft: !!req.body.asDraft }));
  res.status(201).json(bill);
});

module.exports.updateDraftBill = handle(async (req, res) => {
  res.json(await inTx((session) => payables.updateDraftBill(req.params.id, req.body, { session, req })));
});

module.exports.postDraftBill = handle(async (req, res) => {
  res.json(await inTx((session) => payables.postDraftBill(req.params.id, { session, req })));
});

module.exports.deleteDraftBill = handle(async (req, res) => {
  await inTx((session) => payables.deleteDraftBill(req.params.id, { session, req }));
  res.json({ success: true });
});

// ---- Simple documents: list + create ----

const LISTS = {
  payments: { Model: docs.SupplierPayment, populate: [{ path: 'vendorId', select: 'name' }, { path: 'fromAccountId', select: 'code name currency' }] },
  'customer-refunds': { Model: docs.CustomerRefund, populate: [{ path: 'partnerId', select: 'firstName lastName customerId' }, { path: 'orderId', select: 'orderId' }, { path: 'accountId', select: 'code name currency' }] },
  'yuan-purchases': { Model: docs.YuanPurchase, populate: [{ path: 'vendorId', select: 'name' }, { path: 'fromAccountId', select: 'code name currency' }, { path: 'toAccountId', select: 'code name' }] },
  'write-offs': { Model: docs.ClaimWriteOff, populate: [{ path: 'partnerId', select: 'firstName lastName customerId' }, { path: 'orderId', select: 'orderId' }] },
  receipts: { Model: docs.SupplierReceipt, populate: [{ path: 'vendorId', select: 'name' }, { path: 'toAccountId', select: 'code name currency' }, { path: 'allocations.billId', select: 'number' }] },
  transfers: { Model: docs.TreasuryTransfer, populate: [{ path: 'fromAccountId', select: 'code name currency' }, { path: 'toAccountId', select: 'code name currency' }, { path: 'employeeId', select: 'firstName lastName' }] },
  'cash-counts': { Model: docs.CashCount, populate: [{ path: 'accountId', select: 'code name currency' }] },
  salaries: { Model: docs.SalaryPayment, populate: [{ path: 'employeeId', select: 'firstName lastName' }, { path: 'paidFromAccountId', select: 'code name currency' }] },
  equity: { Model: docs.EquityTransaction, populate: [{ path: 'accountId', select: 'code name currency' }] },
  nettings: { Model: docs.Netting, populate: [{ path: 'vendorId', select: 'name' }, { path: 'customerId', select: 'firstName lastName customerId' }, { path: 'billId', select: 'number' }] },
};

module.exports.listDocuments = (kind) => handle(async (req, res) => {
  const { Model, populate } = LISTS[kind];
  const extra = {};
  if (isObjectId(req.query.vendorId)) extra.vendorId = req.query.vendorId;
  if (isObjectId(req.query.employeeId)) extra.employeeId = req.query.employeeId;
  if (isObjectId(req.query.accountId)) extra.$or = [{ accountId: oid(req.query.accountId) }, { fromAccountId: oid(req.query.accountId) }, { toAccountId: oid(req.query.accountId) }];
  // The document number or its note
  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(String(req.query.search)), 'i');
    extra.$and = [{ $or: [{ number: pattern }, { note: pattern }] }];
  }
  if (req.query.type) extra.type = req.query.type;
  res.json(await paged(Model, listQuery(req, extra), req, populate));
});

const CREATORS = {
  payments: payables.createPayment,
  receipts: payables.createReceipt,
  'customer-refunds': (input, context) => require('../services/posting/customerRefund').createCustomerRefund(input, context),
  'yuan-purchases': (input, context) => require('../services/posting/alipay').createYuanPurchase(input, context),
  'write-offs': (input, context) => require('../services/posting/writeOff').createWriteOff(input, context),
  transfers: treasury.createTransfer,
  'cash-counts': treasury.createCashCount,
  salaries: people.createSalary,
  equity: people.createEquity,
  nettings: people.createNetting,
};

module.exports.createDocument = (kind) => handle(async (req, res) => {
  const doc = await inTx((session) => CREATORS[kind](req.body, { session, req }));
  res.status(201).json(doc);
});

// ---- Cancel & attachments (any document) ----

module.exports.cancel = handle(async (req, res) => {
  const { model, id } = req.params;
  if (!CANCELABLE_MODELS.includes(model)) throw badRequest('نوع مستند غير معروف');
  const doc = await inTx((session) => cancelDocument(model, id, { session, req, reason: req.body?.reason, confirmNegative: !!req.body?.confirm }));
  res.json(doc);
});

module.exports.addAttachments = handle(async (req, res) => {
  const { model, id } = req.params;
  if (!CANCELABLE_MODELS.includes(model)) throw badRequest('نوع مستند غير معروف');
  const Model = mongoose.model(model);
  const doc = await Model.findById(id);
  if (!doc) throw notFound('المستند غير موجود');
  // Loaded here: the storage client reads its credentials when required
  const { uploadToGoogleCloud } = require('../../utils/googleClould');
  const files = [];
  for (const file of req.files || []) {
    const uploaded = await uploadToGoogleCloud(file, 'exios-admin-accounting');
    files.push({ path: uploaded.publicUrl, filename: uploaded.filename, folder: uploaded.folder, bytes: uploaded.bytes, fileType: file.mimetype });
  }
  if (!files.length) throw badRequest('لا توجد ملفات');
  await inTx(async (session) => {
    await Model.updateOne({ _id: doc._id }, { $push: { attachments: { $each: files } } }, { session });
    await logAudit({ req, action: 'document.attach', model, docId: doc._id, after: { files: files.map((f) => f.filename) } }, session);
  });
  res.json({ attachments: [...(doc.attachments || []), ...files] });
});

// ---- Fixed assets & prepaid ----

module.exports.listAssets = handle(async (req, res) => {
  const assets = await docs.FixedAsset.find(req.query.status ? { status: req.query.status } : {}).sort({ purchaseDay: -1 }).populate('accountId', 'code name').lean();
  res.json({
    results: assets.map((asset) => {
      const accumulated = asset.depreciationPosted.reduce((sum, item) => sum + item.amount, 0);
      return { ...asset, accumulated, bookValue: asset.cost - accumulated };
    }),
  });
});

module.exports.runDepreciation = handle(async (req, res) => {
  res.json(await inTx((session) => schedules.runDepreciation({ upToMonth: req.body?.upToMonth, session, user: req.user })));
});

module.exports.disposeAsset = handle(async (req, res) => {
  res.json(await inTx((session) => schedules.disposeAsset(req.params.id, req.body, { session, req })));
});

module.exports.listPrepaid = handle(async (req, res) => {
  const items = await docs.PrepaidExpense.find(req.query.status ? { status: req.query.status } : {}).sort({ startMonth: -1 }).populate('expenseAccountId', 'code name').lean();
  res.json({
    results: items.map((item) => {
      const amortized = item.amortizationPosted.reduce((sum, row) => sum + row.amount, 0);
      return { ...item, amortized, remaining: item.total - amortized };
    }),
  });
});

module.exports.runAmortization = handle(async (req, res) => {
  res.json(await inTx((session) => schedules.runPrepaidAmortization({ upToMonth: req.body?.upToMonth, session, user: req.user })));
});

// ---- Employees ----

module.exports.listEmployees = handle(async (req, res) => {
  const employees = await User.find({ $or: [{ 'roles.isEmployee': true }, { 'roles.isAdmin': true }, { 'roles.isAccountant': true }] })
    .select('firstName lastName customerId roles').sort({ firstName: 1 }).lean();
  // Custody and loans apart (owner's request 2026-10-04); the accounts the screen moves money to
  const custody = require('../services/custody');
  // Each kept in its own currency (USD, LYD): { custody: { USD: accountId, LYD: accountId }, loan: ... }
  const [held, lent, custodyAccounts, loanAccounts] = await Promise.all([custody.balances('custody'), custody.balances('loan'), custody.accountsOf('custody'), custody.accountsOf('loan')]);
  const ids = (rows) => Object.fromEntries(rows.map((row) => [row.currency, row.account._id]));
  const none = { USD: 0, LYD: 0 };
  res.json({
    accounts: { custody: ids(custodyAccounts), loan: ids(loanAccounts) },
    results: employees.map((employee) => ({ ...employee, custody: held.get(String(employee._id)) || none, loan: lent.get(String(employee._id)) || none })),
  });
});

// ---- Treasury ----

module.exports.accountBalance = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('الحساب غير صالح');
  res.json(await getBalance(req.params.id));
});

// ---- Bank reconciliation ----

module.exports.listBankLines = handle(async (req, res) => {
  if (!isObjectId(req.query.accountId)) throw badRequest('اختر الحساب');
  const query = { accountId: req.query.accountId };
  if (req.query.lineStatus) query.lineStatus = req.query.lineStatus;
  const lines = await docs.BankStatementLine.find(query).sort({ day: -1 }).limit(500)
    .populate({ path: 'matchedEntryIds', select: 'number day status lines.accountId', populate: { path: 'lines.accountId', select: 'code name' } })
    .populate({ path: 'entryId', select: 'number status lines.accountId', populate: { path: 'lines.accountId', select: 'code name' } })
    .populate('billId', 'number').populate('orderId', 'orderId').populate('customerRefundId', 'number walletUsd status').lean();
  const movements = await bank.unmatchedMovements(req.query.accountId);
  const balance = await getBalance(req.query.accountId);
  const lastWithBalance = await docs.BankStatementLine.findOne({ accountId: req.query.accountId, balanceAfter: { $ne: null } }).sort({ day: -1, createdAt: -1 }).lean();
  res.json({ lines, unmatchedMovements: movements, bookBalance: balance, statementBalance: lastWithBalance?.balanceAfter ?? null });
});

module.exports.importBankLines = handle(async (req, res) => {
  res.json(await bank.importStatement(req.body.accountId, req.body.rows, { req }));
});
module.exports.bankLineDetails = handle(async (req, res) => {
  res.json(await require('../services/posting/bankLineDetails').details(req.params.id));
});
module.exports.editBankLine = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('سطر الكشف غير صالح');
  res.json(await inTx(session => bank.editLine(req.params.id, req.body || {}, { session, req })));
});
module.exports.autoMatchBank = handle(async (req, res) => {
  res.json(await inTx((session) => bank.autoMatch(req.body.accountId, { session, req })));
});
module.exports.matchBankLine = handle(async (req, res) => {
  res.json(await inTx((session) => bank.manualMatch(req.params.id, req.body.entryIds || [], { session, req })));
});
module.exports.bankLineEntry = handle(async (req, res) => {
  res.json(await inTx((session) => bank.createEntryForLine(req.params.id, req.body, { session, req })));
});
module.exports.cancelBankLineEntry = handle(async (req, res) => {
  res.json(await inTx((session) => bank.cancelLineEntry(req.params.id, { session, req, reason: req.body?.reason })));
});
// The account each unmatched line most likely belongs to, and the lines that may already be in the books
module.exports.bankSuggestions = handle(async (req, res) => {
  if (!isObjectId(req.query.accountId)) throw badRequest('اختر الحساب');
  res.json(await bank.suggestions(req.query.accountId));
});

// The table before importing: each row's status and the account it would go to (nothing saved)
module.exports.classifyBankRows = handle(async (req, res) => {
  if (!isObjectId(req.body?.accountId)) throw badRequest('اختر الحساب');
  res.json({ results: await bank.classifyRows(req.body.accountId, req.body.rows) });
});

module.exports.listBankRules = handle(async (req, res) => res.json({ results: await bank.listRules(isObjectId(req.query.accountId) ? req.query.accountId : undefined) }));
module.exports.saveBankRule = handle(async (req, res) => res.status(201).json(await inTx((session) => bank.saveRule(req.body || {}, { session, req }))));
module.exports.deleteBankRule = handle(async (req, res) => res.json(await inTx((session) => bank.deleteRule(req.params.id, { session, req }))));

// Rows read from a PDF statement, for checking before they are imported
module.exports.parseBankPdf = handle(async (req, res) => {
  if (!req.file) throw badRequest('ارفع ملف PDF');
  const { rows, creditCard, format } = await bank.parsePdf(req.file.buffer);
  if (!rows.length) throw badRequest('لم يُقرأ أي سطر من الملف. إن كان الكشف صورة ممسوحة فاطلبه من البنك Excel أو PDF نصي.');
  res.json({ rows, creditCard, format: format || null });
});

module.exports.ignoreBankLine = (ignored) => handle(async (req, res) => {
  res.json(await inTx((session) => bank.setIgnored(req.params.id, ignored, { session, req })));
});
module.exports.deleteBankLine = handle(async (req, res) => res.json(await inTx((session) => bank.deleteLine(req.params.id, { session, req }))));

// ---- Expense types (quick expense list) ----

module.exports.listExpenseTypes = handle(async (req, res) => {
  const types = await docs.ExpenseType.find(req.query.active === 'true' ? { isActive: true } : {}).sort({ sortOrder: 1, name: 1 }).populate('accountId', 'code name').lean();
  res.json({ results: types });
});

module.exports.saveExpenseType = handle(async (req, res) => {
  const body = pick(req.body, ['name', 'nameEn', 'accountId', 'defaultOffice', 'isActive', 'sortOrder']);
  if (body.accountId) {
    const account = isObjectId(body.accountId) && await Account.findById(body.accountId).lean();
    if (!account || account.type !== 'expense' || account.isGroup) throw badRequest('اختر حساب مصروف تفصيلي');
  }
  const type = await inTx(async (session) => {
    if (req.params.id) {
      const existing = await docs.ExpenseType.findById(req.params.id).session(session);
      if (!existing) throw notFound('النوع غير موجود');
      const before = existing.toObject();
      Object.assign(existing, body);
      await existing.save({ session });
      await logAudit({ req, action: 'expenseType.update', model: 'AccountingExpenseType', docId: existing._id, before, after: existing }, session);
      return existing;
    }
    if (!body.name || !body.accountId) throw badRequest('الاسم والحساب مطلوبان');
    const [created] = await docs.ExpenseType.create([body], { session });
    await logAudit({ req, action: 'expenseType.create', model: 'AccountingExpenseType', docId: created._id, after: created }, session);
    return created;
  });
  res.json(type);
});

// ---- Lookups for forms ----

// Trips (not warehouses) with the costs recorded on them so far
module.exports.listTrips = handle(async (req, res) => {
  const query = { inventoryType: 'inventoryGoods' };
  if (req.query.status) query.status = req.query.status;
  if (req.query.search) query.voyage = new RegExp(escapeRegex(req.query.search), 'i');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const trips = await Inventory.find(query).select('voyage shippingType shippedCountry inventoryPlace status arrivalDate createdAt').sort({ createdAt: -1 }).limit(limit).lean();
  const wip = await resolveAccount('trip_cost_wip');
  const { settings } = await getConfig();
  const costRoles = ['cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic'].map((role) => settings.accountRoles?.[role]).filter(Boolean).map(oid);
  const ids = trips.map((t) => t._id);
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.tripId': { $in: ids } } },
    { $unwind: '$lines' },
    { $match: { 'lines.tripId': { $in: ids }, 'lines.accountId': { $in: [wip._id, ...costRoles] } } },
    {
      $group: {
        _id: '$lines.tripId',
        inProgress: { $sum: { $cond: [{ $eq: ['$lines.accountId', wip._id] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
        recognized: { $sum: { $cond: [{ $ne: ['$lines.accountId', wip._id] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
      },
    },
  ]);
  const costs = new Map(rows.map((row) => [String(row._id), row]));
  res.json({
    results: trips.map((trip) => {
      const cost = costs.get(String(trip._id)) || { inProgress: 0, recognized: 0 };
      return { ...trip, costInProgress: cost.inProgress, costRecognized: cost.recognized, totalCost: cost.inProgress + cost.recognized };
    }),
  });
});

module.exports.lookupOrders = handle(async (req, res) => {
  const search = String(req.query.search || '').trim();
  if (search.length < 2) return res.json({ results: [] });
  const orders = await Order.find({ orderId: new RegExp(escapeRegex(search), 'i') })
    .select('orderId placedAt totalInvoice isPayment isShipment isCanceled customerInfo.fullName').limit(20).lean();
  res.json({ results: orders });
});

// Open customer claims (receivable keys with a balance) for netting
module.exports.lookupClaims = handle(async (req, res) => {
  if (!isObjectId(req.query.partnerId)) return res.json({ results: [] });
  const receivable = await resolveAccount('customer_receivable');
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.partnerId': oid(req.query.partnerId), 'lines.accountId': receivable._id } },
    { $unwind: '$lines' },
    { $match: { 'lines.partnerId': oid(req.query.partnerId), 'lines.accountId': receivable._id } },
    { $group: { _id: '$lines.arKey', open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $match: { open: { $gt: 0 } } },
  ]);
  // Order number and tracking number, so a person can tell the claims apart
  const claims = rows.filter((row) => row._id);
  const orderIds = claims.map((row) => String(row._id).split(':')).filter(([kind]) => kind === 'PUR' || kind === 'SHP').map(([, id]) => id).filter(isObjectId);
  const orders = new Map((await Order.find({ _id: { $in: orderIds } }).select('orderId isDeleted paymentList._id paymentList.deliveredPackages.trackingNumber').setOptions({ withDeleted: true }).lean()).map((o) => [String(o._id), o]));
  const label = (arKey) => {
    const [kind, orderId, packageId] = String(arKey).split(':');
    const order = orders.get(orderId);
    if (kind === 'PUR') return `فاتورة شراء - طلب ${order?.orderId || ''}`;
    if (kind === 'SHP') return `شحن ${order?.paymentList?.find((p) => String(p._id) === packageId)?.deliveredPackages?.trackingNumber || ''} - طلب ${order?.orderId || ''}`;
    return 'دين عام';
  };
  res.json({ results: claims.map((row) => ({ arKey: row._id, open: row.open, label: label(row._id) })) });
});

// ---- Alipay (spec 19.5) ----

module.exports.alipayDashboard = handle(async (req, res) => {
  res.json(await require('../services/posting/alipay').dashboard({ from: req.query.from || undefined, to: req.query.to || undefined }));
});

module.exports.completeYuanPurchase = handle(async (req, res) => {
  res.json(await inTx((session) => require('../services/posting/alipay').completeYuanPurchase(req.params.id, req.body || {}, { session, req })));
});
