const mongoose = require('mongoose');
const { JournalEntry, Journal, AuditLog } = require('../models');
const { handle, badRequest, notFound, isObjectId } = require('./util');
const { getConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { createManualEntry, cancelManualEntry } = require('../services/manualEntry');
const User = require('../../models/user');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const UserStatement = require('../../models/userStatement');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const { Vendor } = require('../models/documents');
const { visibleMatch } = require('../services/visibility');
const { logAudit } = require('../services/audit');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function withAccountNames(entries) {
  const { accountsById } = await getConfig();
  return entries.map((entry) => ({
    ...entry,
    lines: entry.lines.map((line) => {
      const account = accountsById.get(String(line.accountId));
      return { ...line, accountName: account?.name, accountCode: account?.code || line.accountCode, accountCurrency: account?.currency, isCash: !!account?.isCash };
    }),
  }));
}

// Pages of the accounting documents an entry can come from
const ACCOUNTING_PAGES = {
  AccountingSupplierBill: (id) => ({ label: 'فاتورة المورد', url: `/accounting/bills/${id}` }),
  AccountingSupplierPayment: () => ({ label: 'دفعات الموردين', url: '/accounting/payments' }),
  AccountingTreasuryTransfer: () => ({ label: 'الخزينة والتحويلات', url: '/accounting/treasury' }),
  AccountingCashCount: () => ({ label: 'جرد الخزائن', url: '/accounting/treasury' }),
  AccountingSalaryPayment: () => ({ label: 'الرواتب', url: '/accounting/employees' }),
  AccountingEquityTransaction: () => ({ label: 'رأس المال والقروض', url: '/accounting/equity' }),
  AccountingNetting: () => ({ label: 'المقاصة', url: '/accounting/netting' }),
  AccountingFixedAsset: () => ({ label: 'الأصول الثابتة', url: '/accounting/assets' }),
  AccountingPrepaidExpense: () => ({ label: 'المصروفات المقدمة', url: '/accounting/assets' }),
  AccountingBankStatementLine: () => ({ label: 'مطابقة البنك', url: '/accounting/bank' }),
  AccountingAccount: (id) => ({ label: 'كشف الحساب', url: `/accounting/accounts/${id}` }),
};

// Where an entry came from, and readable names for the orders, packages, trips and vendors on
// its lines, so the screen can link to each of them
async function entryLinks(entry) {
  const ids = (field) => [...new Set(entry.lines.map((line) => line[field]?._id || line[field]).filter(Boolean).map(String))];
  const { model, id } = entry.source || {};
  let source = null;
  const orderIds = ids('orderId');

  if (model === 'Order' && id) orderIds.push(String(id));
  if (model === 'OrderPaymentHistory' && id) {
    const payment = await OrderPaymentHistory.findById(id).select('order').lean();
    if (payment?.order) { orderIds.push(String(payment.order)); source = { kind: 'order', id: payment.order }; }
  }
  if (model === 'UserStatement' && id) {
    const statement = await UserStatement.findById(id).select('user').lean();
    if (statement?.user) source = { label: 'كشف حساب العميل', url: `/user/${statement.user}` };
  }
  if (model === 'User' && id) source = { label: 'صفحة العميل', url: `/user/${id}` };
  if (model === 'Balance') source = { label: 'الديون', url: '/balances' };
  if (model === 'Income' && id) source = { label: 'الإيراد (الشاشة القديمة)', url: `/income/${id}/edit` };
  if (ACCOUNTING_PAGES[model]) source = ACCOUNTING_PAGES[model](id);

  const [orders, trips, vendors] = await Promise.all([
    Order.find({ _id: { $in: [...new Set(orderIds)] } }).select('orderId isDeleted paymentList._id paymentList.deliveredPackages.trackingNumber').setOptions({ withDeleted: true }).lean(),
    Inventory.find({ _id: { $in: ids('tripId') } }).select('voyage').lean(),
    Vendor.find({ _id: { $in: ids('vendorId') } }).select('name').lean(),
  ]);
  const names = { orders: {}, packages: {}, trips: {}, vendors: {} };
  orders.forEach((order) => {
    names.orders[order._id] = order.orderId;
    (order.paymentList || []).forEach((pkg) => { names.packages[pkg._id] = pkg.deliveredPackages?.trackingNumber; });
  });
  trips.forEach((trip) => { names.trips[trip._id] = trip.voyage; });
  vendors.forEach((vendor) => { names.vendors[vendor._id] = vendor.name; });

  const sourceOrder = model === 'Order' ? id : source?.kind === 'order' ? source.id : null;
  if (sourceOrder) source = { label: `الطلب ${names.orders[sourceOrder] || ''}`.trim(), url: `/invoice/${sourceOrder}/edit` };
  return { source, names };
}

module.exports.list = handle(async (req, res) => {
  const { from, to, journalId, accountId, eventType, search, partnerId, showCanceled } = req.query;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const query = { ...visibleMatch(showCanceled) };
  if (from || to) {
    query.day = {};
    if (from) query.day.$gte = from;
    if (to) query.day.$lte = to;
  }
  if (isObjectId(journalId)) query.journalId = journalId;
  if (isObjectId(accountId)) query['lines.accountId'] = new mongoose.Types.ObjectId(accountId);
  if (isObjectId(partnerId)) query['lines.partnerId'] = new mongoose.Types.ObjectId(partnerId);
  if (eventType) query.eventType = eventType;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ number: pattern }, { description: pattern }, { eventKey: pattern }];
  }

  const [entries, total] = await Promise.all([
    JournalEntry.find(query).sort({ day: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('journalId', 'code name').populate('createdBy', 'firstName lastName').lean(),
    JournalEntry.countDocuments(query),
  ]);
  res.json({ results: await withAccountNames(entries), total, page, limit });
});

module.exports.get = handle(async (req, res) => {
  const entry = await JournalEntry.findById(req.params.id)
    .populate('journalId', 'code name').populate('createdBy', 'firstName lastName')
    .populate('lines.partnerId', 'firstName lastName customerId').lean();
  if (!entry) throw notFound('القيد غير موجود');
  const related = await JournalEntry.find({ _id: { $in: [entry.reversalOf, entry.reversedBy].filter(Boolean) } }).select('number day').lean();
  const [withNames] = await withAccountNames([entry]);
  res.json({ entry: withNames, related, ...(await entryLinks(entry)) });
});

module.exports.createManual = handle(async (req, res) => {
  const entry = await runInTransaction((session) => createManualEntry(req.body, { session, req }));
  res.status(201).json(entry);
});

module.exports.cancel = handle(async (req, res) => {
  const reversal = await runInTransaction((session) => cancelManualEntry(req.params.id, { reason: req.body?.reason, session, req }));
  res.json(reversal);
});

module.exports.eventTypes = handle(async (req, res) => {
  res.json({ results: await JournalEntry.distinct('eventType') });
});

module.exports.audit = handle(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const query = {};
  if (req.query.model) query.model = req.query.model;
  // Filters of the audit screen: what was done, by whom, between which days (Libya time)
  if (req.query.action) query.action = new RegExp(`^${String(req.query.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (req.query.userId && /^[0-9a-f]{24}$/i.test(req.query.userId)) query.userId = req.query.userId;
  if (req.query.from || req.query.to) {
    const { dayStart, dayEnd } = require('../services/dates');
    query.at = { ...(req.query.from && { $gte: dayStart(req.query.from) }), ...(req.query.to && { $lte: dayEnd(req.query.to) }) };
  }
  const [results, total] = await Promise.all([
    AuditLog.find(query).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'firstName lastName').lean(),
    AuditLog.countDocuments(query),
  ]);
  res.json({ results, total, page, limit });
});

// Customer and employee picker for entry lines
module.exports.lookupUsers = handle(async (req, res) => {
  const search = String(req.query.search || '').trim();
  if (search.length < 2) return res.json({ results: [] });
  const pattern = new RegExp(escapeRegex(search), 'i');
  const or = [{ customerId: pattern }, { firstName: pattern }, { lastName: pattern }];
  if (/^\d{4,}$/.test(search)) or.push({ phone: Number(search) });
  const users = await User.find({ $or: or }).select('firstName lastName customerId roles.isEmployee roles.isAdmin').limit(20).lean();
  res.json({ results: users });
});

module.exports.journalsForFilter = handle(async (req, res) => {
  res.json({ results: await Journal.find({}).select('code name type isActive').sort({ code: 1 }).lean() });
});

// A file kept with an entry: the signed count sheet on the opening cash entry, a receipt...
module.exports.addAttachments = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('القيد غير صالح');
  const entry = await JournalEntry.findById(req.params.id).select('attachments').lean();
  if (!entry) throw notFound('القيد غير موجود');
  // Loaded here: the storage client reads its credentials when required
  const { uploadToGoogleCloud } = require('../../utils/googleClould');
  const files = [];
  for (const file of req.files || []) {
    const uploaded = await uploadToGoogleCloud(file, 'exios-admin-accounting');
    files.push({ path: uploaded.publicUrl, filename: uploaded.filename, folder: uploaded.folder, bytes: uploaded.bytes, fileType: file.mimetype });
  }
  if (!files.length) throw badRequest('لا توجد ملفات');
  await runInTransaction(async (session) => {
    await JournalEntry.updateOne({ _id: entry._id }, { $push: { attachments: { $each: files } } }, { session });
    await logAudit({ req, action: 'entry.attach', model: 'AccountingJournalEntry', docId: entry._id, after: { files: files.map((f) => f.filename) } }, session);
  });
  res.json({ attachments: [...(entry.attachments || []), ...files] });
});
