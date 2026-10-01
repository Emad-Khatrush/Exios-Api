const { Account, Journal, JournalEntry } = require('../models');
const { ACCOUNT_TYPES } = require('../models/Account');
const { handle, badRequest, notFound, isObjectId, pick } = require('./util');
const { chartWithTotals } = require('../services/balances');
const { accountUsage, canDeleteAccount, canArchiveAccount } = require('../services/usage');
const { invalidateConfig, getConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const { toDay } = require('../services/dates');

const DIMENSIONS = ['partner', 'vendor', 'employee', 'trip', 'order', 'package', 'office'];
const CASH_KINDS = ['cash', 'bank', 'ewallet'];
const JOURNAL_PREFIX = { cash: 'CASH', bank: 'BANK', ewallet: 'EWAL' };

async function validateParent(parentId, type, selfId) {
  if (!parentId) return null;
  if (!isObjectId(parentId)) throw badRequest('المجموعة الأب غير صالحة');
  const parent = await Account.findById(parentId).lean();
  if (!parent) throw badRequest('المجموعة الأب غير موجودة');
  if (!parent.isGroup) throw badRequest('الأب يجب أن يكون مجموعة');
  if (parent.type !== type) throw badRequest('نوع الحساب يجب أن يطابق نوع مجموعته');
  // Not under itself or one of its own children
  let cursor = parent;
  while (cursor) {
    if (selfId && String(cursor._id) === String(selfId)) throw badRequest('لا يمكن نقل الحساب تحت أحد أبنائه');
    cursor = cursor.parentId ? await Account.findById(cursor.parentId).lean() : null;
  }
  return parent;
}

async function validateFields(body) {
  const { currencies, offices } = await getConfig();
  if (body.currency && !currencies.has(body.currency)) throw badRequest('العملة غير معرّفة');
  if (body.office && !offices.has(body.office)) throw badRequest('المكتب غير معرّف');
  if (body.requires && (!Array.isArray(body.requires) || body.requires.some((d) => !DIMENSIONS.includes(d)))) {
    throw badRequest('أبعاد غير معروفة');
  }
  if (body.cashKind && !CASH_KINDS.includes(body.cashKind)) throw badRequest('نوع الخزينة غير صالح');
}

async function createCashJournal(account, session) {
  const base = `${JOURNAL_PREFIX[account.cashKind] || 'CASH'}-${account.code}`;
  let code = base;
  for (let n = 2; await Journal.exists({ code }).session(session); n++) code = `${base}-${n}`;
  await Journal.create([{
    code, name: account.name, type: account.cashKind || 'cash', defaultAccountId: account._id, office: account.office, sequencePrefix: code,
  }], { session });
}

module.exports.list = handle(async (req, res) => {
  const from = req.query.from ? toDay(req.query.from) : undefined;
  const to = req.query.to ? toDay(req.query.to) : undefined;
  const accounts = await chartWithTotals({ from, to });
  res.json({ results: accounts });
});

module.exports.get = handle(async (req, res) => {
  const account = await Account.findById(req.params.id).lean();
  if (!account) throw notFound('الحساب غير موجود');
  const usage = await accountUsage(account);
  const [deletable, archivable] = await Promise.all([canDeleteAccount(account), canArchiveAccount(account)]);
  res.json({
    account,
    usage: { items: usage.items, balance: usage.balance },
    canDelete: deletable,
    canArchive: { allowed: archivable.allowed, reasons: archivable.reasons },
  });
});

module.exports.create = handle(async (req, res) => {
  const body = pick(req.body, ['code', 'name', 'nameEn', 'type', 'isGroup', 'parentId', 'currency', 'isCash', 'cashKind', 'office', 'requires', 'allowManualEntry', 'cashFlowCategory', 'sortOrder']);
  if (!body.code || !body.name) throw badRequest('الرقم والاسم مطلوبان');
  if (!ACCOUNT_TYPES.includes(body.type)) throw badRequest('نوع الحساب مطلوب');
  if (await Account.exists({ code: String(body.code).trim() })) throw badRequest('رقم الحساب مستخدم');
  await validateFields(body);
  await validateParent(body.parentId, body.type);
  if (body.isGroup && (body.isCash || body.currency)) throw badRequest('المجموعة لا تكون خزينة ولا بعملة');
  if (body.isCash) {
    if (!body.currency) throw badRequest('الخزينة تحتاج عملة');
    if (!body.office) throw badRequest('الخزينة تحتاج مكتباً');
    if (body.type !== 'asset') throw badRequest('الخزينة حساب أصول');
    body.cashKind = body.cashKind || 'cash';
    body.requires = [...new Set([...(body.requires || []), 'office'])];
  }

  const account = await runInTransaction(async (session) => {
    const [created] = await Account.create([body], { session });
    if (created.isCash) await createCashJournal(created, session);
    await logAudit({ req, action: 'account.create', model: 'AccountingAccount', docId: created._id, after: created }, session);
    return created;
  });
  invalidateConfig();
  res.status(201).json(account);
});

module.exports.update = handle(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw notFound('الحساب غير موجود');
  const before = account.toObject();
  const body = pick(req.body, ['code', 'name', 'nameEn', 'type', 'parentId', 'currency', 'office', 'requires', 'allowManualEntry', 'cashFlowCategory', 'sortOrder', 'cashKind']);
  await validateFields(body);

  const hasEntries = !!(await JournalEntry.exists({ 'lines.accountId': account._id }));
  if (hasEntries && body.type !== undefined && body.type !== account.type) {
    throw badRequest('لا يمكن تغيير نوع حساب عليه قيود. أنشئ حساباً جديداً وحوّل الرصيد.');
  }
  if (hasEntries && body.currency !== undefined && (body.currency || null) !== (account.currency || null)) {
    throw badRequest('لا يمكن تغيير عملة حساب عليه قيود. أنشئ حساباً جديداً وحوّل الرصيد.');
  }
  if (body.code && body.code !== account.code && await Account.exists({ code: body.code })) throw badRequest('رقم الحساب مستخدم');
  if (body.type && body.type !== account.type && await Account.exists({ parentId: account._id })) {
    throw badRequest('لا يمكن تغيير نوع مجموعة فيها حسابات');
  }
  if (body.parentId !== undefined || body.type !== undefined) {
    await validateParent(body.parentId === undefined ? account.parentId : body.parentId, body.type || account.type, account._id);
  }

  Object.assign(account, body);
  if (account.isCash) account.requires = [...new Set([...(account.requires || []), 'office'])];
  await runInTransaction(async (session) => {
    await account.save({ session });
    await logAudit({ req, action: 'account.update', model: 'AccountingAccount', docId: account._id, before, after: account }, session);
  });
  invalidateConfig();
  res.json(account);
});

module.exports.archive = handle(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw notFound('الحساب غير موجود');
  const check = await canArchiveAccount(account);
  if (!check.allowed) return res.status(400).json({ success: false, message: 'لا يمكن الأرشفة', reasons: check.reasons });
  await runInTransaction(async (session) => {
    account.isActive = false;
    await account.save({ session });
    await Journal.updateMany({ defaultAccountId: account._id }, { $set: { isActive: false } }, { session });
    await logAudit({ req, action: 'account.archive', model: 'AccountingAccount', docId: account._id }, session);
  });
  invalidateConfig();
  res.json(account);
});

module.exports.unarchive = handle(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw notFound('الحساب غير موجود');
  if (account.parentId && !(await Account.exists({ _id: account.parentId, isActive: true }))) {
    throw badRequest('المجموعة الأب مؤرشفة؛ ألغِ أرشفتها أولاً');
  }
  await runInTransaction(async (session) => {
    account.isActive = true;
    await account.save({ session });
    await Journal.updateMany({ defaultAccountId: account._id }, { $set: { isActive: true } }, { session });
    await logAudit({ req, action: 'account.unarchive', model: 'AccountingAccount', docId: account._id }, session);
  });
  invalidateConfig();
  res.json(account);
});

module.exports.remove = handle(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) throw notFound('الحساب غير موجود');
  const check = await canDeleteAccount(account);
  if (!check.allowed) {
    return res.status(400).json({ success: false, message: 'لا يمكن الحذف - الحساب مستخدم', reasons: check.reasons, canArchive: true });
  }
  await runInTransaction(async (session) => {
    await Journal.deleteMany({ defaultAccountId: account._id }, { session });
    await Account.deleteOne({ _id: account._id }, { session });
    await logAudit({ req, action: 'account.delete', model: 'AccountingAccount', docId: account._id, before: account }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});
