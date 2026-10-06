// Everyday operations entered from the system's own screens, not from the accounting section
// (spec 19.1): a trip's costs from the trip page, purchases for an order from the order page, and
// office expenses from the Expenses screen. Staff fill in plain fields (supplier, amount, currency,
// paid from which box); behind each one is an ordinary supplier bill, posted at once.
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const { Vendor, SupplierBill, ExpenseType } = require('../models/documents');
const Inventory = require('../../models/inventory');
const Order = require('../../models/order');
const User = require('../../models/user');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { createBill } = require('./posting/payables');
const { cancelDocument } = require('./cancel');
const { listMoneyAccounts, moneyAccount } = require('./moneyAccounts');
const { assertOpenPeriod } = require('./periodGuard');
const { isOwner, accessOf } = require('./access');
const { resolveSubCashAccount } = require('./roles');
const { today, toDay, isDay } = require('./dates');

const fail = (message, status = 400) => new ErrorHandler(status, message);
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const validId = (value) => value && mongoose.isValidObjectId(String(value));

const dayOf = (value) => {
  const day = value ? String(value).slice(0, 10) : today();
  if (!isDay(day)) throw fail('التاريخ غير صالح');
  if (day > today()) throw fail('لا يمكن تسجيل عملية بتاريخ في المستقبل');
  return day;
};

// The office and accounting role of whoever is working
async function staffProfile(user) {
  const owner = await isOwner(user);
  const access = await accessOf(user).catch(() => ({ permissions: [] }));
  const fresh = await User.findById(user._id).select('office roles').lean();
  return {
    office: fresh?.office || null,
    // The owner and the accountant record for any office and change anything from accounting
    anyOffice: owner || !!fresh?.roles?.isAccountant,
    canCancel: owner || access.permissions.includes('cancel'),
  };
}

// ---- What the forms list ----

async function options(user, { currency } = {}) {
  const { currencies, offices, settings } = await getConfig();
  const [vendors, accounts, profile] = await Promise.all([
    Vendor.find({ isActive: true, seedKey: { $in: [null, undefined] } }).select('name type defaultCurrency').sort({ name: 1 }).lean(),
    listMoneyAccounts({ currency }),
    staffProfile(user),
  ]);
  // Staff do not choose the cash box (spec v8): cash is their office's sub box; banks and partner
  // accounts stay a choice. The owner and the accountant see every box.
  let shown = accounts;
  if (!profile.anyOffice) {
    const subIds = new Set(Object.values(settings?.subOfficeAccounts?.[profile.office] || {}).map(String));
    shown = accounts.filter((a) => a.kind !== 'cash' || subIds.has(String(a._id)));
  }
  return {
    vendors,
    accounts: shown,
    currencies: [...currencies.values()].filter((c) => c.isActive).map((c) => ({ code: c.code, name: c.name })),
    offices: [...offices.values()].filter((o) => o.isActive !== false).map((o) => ({ code: o.code, name: o.name })),
    office: profile.office,
    anyOffice: profile.anyOffice,
  };
}

async function createVendor({ name, type }) {
  const clean = String(name || '').trim();
  if (clean.length < 2) throw fail('اكتب اسم المورد');
  const existing = await Vendor.findOne({ name: new RegExp(`^${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (existing) return existing;
  return Vendor.create({ name: clean, type: ['carrier', 'supplier', 'service', 'funder', 'other'].includes(type) ? type : 'supplier' });
}

// ---- Trip costs and order purchases ----

const billView = (bill, field, id) => {
  const lines = bill.lines.filter((line) => !field || String(line[field]) === String(id));
  return {
    _id: bill._id, number: bill.number, day: bill.day, vendor: bill.vendorId?.name || '', status: bill.status, currency: bill.currency,
    amount: lines.reduce((sum, line) => sum + line.amount, 0), usd: lines.reduce((sum, line) => sum + (line.usd || 0), 0),
    description: lines.map((line) => line.description).join('، '), paid: !!bill.paidImmediatelyFrom, costCategory: lines[0]?.costCategory || null,
    paidFrom: bill.paidImmediatelyFrom?.name || null, createdBy: bill.createdBy ? `${bill.createdBy.firstName || ''} ${bill.createdBy.lastName || ''}`.trim() : '',
    createdById: bill.createdBy?._id || null, createdAt: bill.createdAt, attachments: bill.attachments || [], note: bill.note || '',
  };
};

async function billsOn(field, id) {
  const bills = await SupplierBill.find({ [`lines.${field}`]: oid(id), status: { $ne: 'draft' } })
    .populate('vendorId', 'name').populate('createdBy', 'firstName lastName').populate('paidImmediatelyFrom', 'name')
    .sort({ day: -1, createdAt: -1 }).lean();
  return bills.map((bill) => billView(bill, field, id));
}

async function tripCosts(tripId) {
  if (!validId(tripId)) throw fail('الرحلة غير موجودة', 404);
  const trip = await Inventory.findById(tripId).select('voyage shippingType inventoryType expenses').lean();
  if (!trip || trip.inventoryType !== 'inventoryGoods') throw fail('الرحلة غير موجودة', 404);
  // Recorded on the trip before accounting: shown as they are until the historical migration has
  // turned them into bills (then the bill is shown instead, never both)
  const migrated = new Set((await SupplierBill.find({ 'lines.tripId': oid(tripId), idempotencyKey: /^MIG:TRIPEXP:/ }).select('idempotencyKey').lean())
    .map((bill) => bill.idempotencyKey.split(':')[2]));
  return {
    trip: { _id: trip._id, voyage: trip.voyage, shippingType: trip.shippingType },
    legacy: (trip.expenses || []).filter((e) => !migrated.has(String(e._id)))
      .map((e) => ({ _id: e._id, description: e.description, amount: e.amount, currency: e.currency, rate: e.rate, date: e.date })),
    bills: await billsOn('tripId', tripId),
  };
}

async function orderCosts(orderId) {
  if (!validId(orderId)) throw fail('الطلب غير موجود', 404);
  const order = await Order.findById(orderId).select('orderId').lean();
  if (!order) throw fail('الطلب غير موجود', 404);
  return { order: { _id: order._id, orderId: order.orderId }, bills: await billsOn('orderId', orderId) };
}

// One cost line on a trip or an order: paid on the spot from a box (in that box's currency), or
// owed to the supplier (paid later from Supplier payments)
async function addCost(target, targetId, input, req) {
  const user = req.user;
  const day = dayOf(input.day);
  await assertOpenPeriod(user, day);
  const amount = Number(input.amount);
  if (!(amount > 0)) throw fail('المبلغ يجب أن يكون أكبر من صفر');
  let vendorId = input.vendorId;
  if (!validId(vendorId)) vendorId = (await createVendor({ name: input.vendorName, type: target === 'trip' ? 'carrier' : 'supplier' }))._id;
  let payFrom = input.payFromAccountId ? await moneyAccount(input.payFromAccountId, { what: 'دُفعت من' }) : null;
  // Cash paid by staff comes out of their office's sub box (spec v8)
  if (payFrom && (payFrom.cashKind || 'cash') === 'cash' && !payFrom.subBox) {
    const profile = await staffProfile(user);
    const sub = !profile.anyOffice && profile.office && await resolveSubCashAccount(profile.office, payFrom.currency || 'USD');
    if (sub) payFrom = sub;
  }
  const currency = payFrom ? (payFrom.currency || 'USD') : String(input.currency || 'USD');
  const rate = Number(input.rate) > 0 ? Number(input.rate) : undefined;
  const label = target === 'trip' ? 'مصروف رحلة' : 'مشتريات الطلب';
  return runInTransaction(async (session) => {
    await assertOpenPeriod(req.user, day, { session });
    return createBill({
    vendorId, day, currency, rate, idempotencyKey: input.idempotencyKey || undefined,
    paidImmediatelyFrom: payFrom?._id, note: input.note, enteredFrom: target,
    lines: [{
      description: String(input.description || '').trim() || label, amount, target, [target === 'trip' ? 'tripId' : 'orderId']: targetId,
      // A trip's cost by kind (spec v8): customs is a cost of the trip itself, shared by weight
      ...(target === 'trip' && ['shipping', 'customs', 'clearance', 'transport', 'other'].includes(input.costCategory) && { costCategory: input.costCategory }),
    }],
  }, { session, req });
  });
}

const addTripCost = (tripId, input, req) => addCost('trip', tripId, input, req);
const addOrderCost = (orderId, input, req) => addCost('order', orderId, input, req);

// Staff may take back what they entered themselves, the same day (Libya time) and in an open
// period. Anything else is cancelled by the accountant or the owner from accounting.
async function assertOwnSameDay(bill, user) {
  const profile = await staffProfile(user);
  if (profile.canCancel) return profile;
  if (String(bill.createdBy) !== String(user._id)) throw fail('يمكنك تعديل أو حذف ما أدخلته أنت فقط. اطلب من المحاسب.', 403);
  if (toDay(bill.createdAt) !== today()) throw fail('التعديل والحذف في نفس يوم الإدخال فقط. بعده يطلب من المحاسب.', 403);
  await assertOpenPeriod(user, bill.day);
  return profile;
}

async function cancelOwnBill(billId, req, reason) {
  if (!validId(billId)) throw fail('الفاتورة غير موجودة', 404);
  const bill = await SupplierBill.findById(billId).lean();
  if (!bill || bill.status === 'draft') throw fail('الفاتورة غير موجودة', 404);
  if (bill.status === 'canceled') throw fail('ملغاة مسبقاً');
  await assertOwnSameDay(bill, req.user);
  return runInTransaction((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: reason || 'حذف من شاشة الإدخال' }));
}

// ---- Office expenses (the system's Expenses screen) ----

// The cash boxes of an office by currency: an office expense is paid from the office's own box
async function officeBoxes(office) {
  const { settings, accountsById } = await getConfig();
  // The office's sub boxes when it has them (spec v8), else its main boxes
  const map = { ...(settings?.officeAccounts?.[office] || {}), ...(settings?.subOfficeAccounts?.[office] || {}) };
  return Object.entries(map)
    .map(([currency, id]) => accountsById.get(String(id)))
    .filter((account) => account && account.isActive && account.isCash && (account.cashKind || 'cash') === 'cash')
    .map((account) => ({ currency: account.currency || 'USD', accountId: account._id, name: account.name }));
}

async function officeFor(user, requested) {
  const profile = await staffProfile(user);
  const { offices } = await getConfig();
  const office = profile.anyOffice && requested ? requested : profile.office;
  if (!office) throw fail('لم يُحدَّد مكتبك بعد. اطلب من المالك تحديد مكتبك من المحاسبة ← الصلاحيات.');
  if (!offices.has(office)) throw fail('المكتب غير معروف');
  return { office, profile };
}

async function officeExpenseOptions(user, requestedOffice) {
  const profile = await staffProfile(user);
  const { offices } = await getConfig();
  const office = profile.anyOffice ? (requestedOffice || profile.office) : profile.office;
  const types = await ExpenseType.find({ isActive: true }).select('name nameEn sortOrder').sort({ sortOrder: 1, name: 1 }).lean();
  return {
    office,
    officeName: office ? offices.get(office)?.name || office : null,
    anyOffice: profile.anyOffice,
    offices: profile.anyOffice ? [...offices.values()].filter((o) => o.isActive !== false).map((o) => ({ code: o.code, name: o.name })) : [],
    types: types.map((t) => ({ _id: t._id, name: t.name })),
    currencies: office ? (await officeBoxes(office)).map((b) => b.currency) : [],
    // The custody this staff member holds, which they may pay expenses from: { USD, LYD }
    custody: (await require('./custody').balances('custody')).get(String(user._id)) || { USD: 0, LYD: 0 },
  };
}

const expenseView = (bill) => ({
  _id: bill._id, number: bill.number, day: bill.day, office: bill.office, type: bill.expenseTypeId?.name || '', expenseTypeId: bill.expenseTypeId?._id || bill.expenseTypeId,
  amount: bill.total ?? bill.lines.reduce((sum, line) => sum + line.amount, 0), currency: bill.currency, usd: bill.totalUsd, note: bill.note || '',
  attachments: bill.attachments || [], status: bill.status, createdAt: bill.createdAt,
  paidFrom: bill.employeeId ? 'custody' : 'box',
  createdBy: bill.createdBy?._id ? { _id: bill.createdBy._id, name: `${bill.createdBy.firstName || ''} ${bill.createdBy.lastName || ''}`.trim() } : bill.createdBy,
  editable: bill.status === 'posted' && toDay(bill.createdAt) === today(),
  cancelReason: bill.cancelReason, replaces: bill.replaces,
});

// What a staff member sees: only their own expenses, no totals
async function myExpenses(user, { limit = 100 } = {}) {
  const bills = await SupplierBill.find({ officeExpense: true, createdBy: user._id, status: 'posted' })
    .populate('expenseTypeId', 'name').sort({ day: -1, createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
  return bills.map(expenseView);
}

async function buildExpense(input, user, files) {
  const { office } = await officeFor(user, input.office);
  const day = dayOf(input.day);
  await assertOpenPeriod(user, day);
  if (!validId(input.expenseTypeId)) throw fail('اختر نوع المصروف');
  const type = await ExpenseType.findById(input.expenseTypeId).lean();
  if (!type || !type.isActive) throw fail('نوع المصروف غير متاح');
  const amount = Number(input.amount);
  if (!(amount > 0)) throw fail('المبلغ يجب أن يكون أكبر من صفر');
  const currency = String(input.currency || '');
  const vendor = await Vendor.findOne({ seedKey: 'cash_expenses' }).lean();
  if (!vendor) throw fail('إعداد المحاسبة غير مكتمل (مورد المصروفات النقدية)');
  const note = String(input.note || '').trim();
  // Paid from the custody the staff member holds (owner's request 2026-10-04), in the custody's own
  // currency: a dinar expense from the dinar custody, valued at what that custody cost
  if (input.payFrom === 'custody') {
    const custody = require('./custody');
    const account = await custody.accountOf('custody', currency);
    if (!account) throw fail(`لا توجد عهدة بعملة ${currency || ''}`);
    const decimals = await require('./posting/common').decimalsOf(currency);
    const held = (await custody.heldMinor(account, user._id)) / 10 ** decimals;
    if (Math.round(amount * 10 ** decimals) > Math.round(held * 10 ** decimals)) throw fail(`عهدتك بعملة ${currency} (${held}) لا تكفي لهذا المصروف`);
    return {
      vendorId: vendor._id, day, currency, paidImmediatelyFrom: account._id, employeeId: user._id, isQuickExpense: true, officeExpense: true, office,
      expenseTypeId: type._id, enteredFrom: 'officeExpense', note, attachments: files,
      lines: [{ description: note ? `${type.name} - ${note}` : type.name, amount, target: 'expense', accountId: type.accountId, office }],
    };
  }
  const box = (await officeBoxes(office)).find((b) => b.currency === currency);
  if (!box) throw fail(`لا توجد خزينة ${currency || ''} لهذا المكتب`);
  return {
    vendorId: vendor._id, day, currency, paidImmediatelyFrom: box.accountId, isQuickExpense: true, officeExpense: true, office,
    expenseTypeId: type._id, enteredFrom: 'officeExpense', note, attachments: files,
    lines: [{ description: note ? `${type.name} - ${note}` : type.name, amount, target: 'expense', accountId: type.accountId, office }],
  };
}

async function createOfficeExpense(input, files, req) {
  const data = await buildExpense(input, req.user, files || []);
  return runInTransaction(async (session) => {
    await assertOpenPeriod(req.user, data.day, { session });
    return createBill({ ...data, idempotencyKey: input.idempotencyKey || undefined }, { session, req });
  });
}

async function loadExpense(id) {
  if (!validId(id)) throw fail('المصروف غير موجود', 404);
  const bill = await SupplierBill.findOne({ _id: id, officeExpense: true }).lean();
  if (!bill) throw fail('المصروف غير موجود', 404);
  if (bill.status !== 'posted') throw fail('المصروف ملغى');
  return bill;
}

// An edit is a cancellation (its entry reversed) and a new expense in its place, in one go
async function updateOfficeExpense(id, input, files, req) {
  const old = await loadExpense(id);
  await assertOwnSameDay(old, req.user);
  const data = await buildExpense({
    office: old.office, day: old.day, expenseTypeId: old.expenseTypeId, amount: old.total, currency: old.currency, note: old.note,
    payFrom: old.employeeId ? 'custody' : undefined,
    // A field sent empty keeps its old value, except the note, which may be cleared
    ...Object.fromEntries(Object.entries(input).filter(([field, value]) => value !== undefined && (value !== '' || field === 'note'))),
  }, req.user, files?.length ? files : old.attachments || []);
  return runInTransaction(async (session) => {
    await assertOpenPeriod(req.user, data.day, { session });
    await cancelDocument('AccountingSupplierBill', old._id, { session, req, reason: 'تعديل من شاشة المصروفات' });
    const created = await createBill({ ...data, replaces: old._id }, { session, req });
    await SupplierBill.updateOne({ _id: old._id }, { $set: { replacedBy: created._id } }, { session });
    return created;
  });
}

async function deleteOfficeExpense(id, req) {
  const bill = await loadExpense(id);
  await assertOwnSameDay(bill, req.user);
  return runInTransaction((session) => cancelDocument('AccountingSupplierBill', bill._id, { session, req, reason: 'حذف من شاشة المصروفات' }));
}

// The accountant's and owner's review: every office's expenses, with receipts
async function reviewOfficeExpenses({ office, createdBy, expenseTypeId, from, to, status, limit = 300 } = {}) {
  const query = { officeExpense: true };
  if (office) query.office = office;
  if (validId(createdBy)) query.createdBy = oid(createdBy);
  if (validId(expenseTypeId)) query.expenseTypeId = oid(expenseTypeId);
  if (status) query.status = status;
  if (from || to) {
    query.day = {};
    if (from) query.day.$gte = from;
    if (to) query.day.$lte = to;
  }
  const bills = await SupplierBill.find(query).populate('expenseTypeId', 'name').populate('createdBy', 'firstName lastName')
    .sort({ day: -1, createdAt: -1 }).limit(Math.min(Number(limit) || 300, 2000)).lean();
  const staff = await SupplierBill.distinct('createdBy', { officeExpense: true });
  const people = await User.find({ _id: { $in: staff } }).select('firstName lastName').lean();
  return {
    results: bills.map(expenseView),
    staff: people.map((p) => ({ _id: p._id, name: `${p.firstName || ''} ${p.lastName || ''}`.trim() })),
    types: (await ExpenseType.find({}).select('name').sort({ sortOrder: 1 }).lean()).map((t) => ({ _id: t._id, name: t.name })),
  };
}

// ---- Staff offices (owner, Accounting > Access) ----

async function staffOffices() {
  const users = await User.find({ $or: [{ 'roles.isEmployee': true }, { 'roles.isAdmin': true }, { 'roles.isAccountant': true }] })
    .select('firstName lastName username roles office').sort({ firstName: 1 }).lean();
  return users.map((u) => ({
    _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim(), username: u.username, office: u.office || null,
    role: u.roles?.isAdmin ? 'admin' : u.roles?.isAccountant ? 'accountant' : 'employee',
  }));
}

async function setStaffOffice(userId, office) {
  if (!validId(userId)) throw fail('المستخدم غير صالح');
  const { offices } = await getConfig();
  if (office && !offices.has(office)) throw fail('المكتب غير معروف');
  const user = await User.findById(userId).select('roles').lean();
  if (!user || !(user.roles?.isEmployee || user.roles?.isAdmin || user.roles?.isAccountant)) throw fail('المكتب يُحدَّد للموظفين فقط');
  await User.updateOne({ _id: userId }, office ? { $set: { office } } : { $unset: { office: 1 } });
  return { userId, office: office || null };
}

module.exports = {
  options, createVendor, tripCosts, orderCosts, addTripCost, addOrderCost, cancelOwnBill,
  officeExpenseOptions, myExpenses, createOfficeExpense, updateOfficeExpense, deleteOfficeExpense, reviewOfficeExpenses,
  staffOffices, setStaffOffice, staffProfile,
};
