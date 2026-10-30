// Currencies, offices and journals: added and changed from the UI (spec 7-أ), deleted only when
// unused, otherwise archived (spec 7-ج).
const { Currency, AccountingOffice, Journal, Account, CurrencyRate, AccountingSettings, JOURNAL_TYPES } = require('../models');
const { handle, badRequest, notFound, isObjectId, pick } = require('./util');
const { invalidateConfig, getConfig } = require('../services/config');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const { currencyUsage, officeUsage, journalUsage } = require('../services/usage');
const { getBalance } = require('../services/carrying');

// ---- Currencies ----

module.exports.listCurrencies = handle(async (req, res) => {
  const currencies = await Currency.find({}).sort({ isBase: -1, code: 1 }).lean();
  res.json({ results: currencies });
});

module.exports.createCurrency = handle(async (req, res) => {
  const body = pick(req.body, ['code', 'name', 'decimals', 'symbol']);
  body.code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(body.code)) throw badRequest('رمز العملة 3 أحرف (مثل AED)');
  if (!body.name) throw badRequest('اسم العملة مطلوب');
  body.decimals = Number(body.decimals ?? 2);
  const currency = await runInTransaction(async (session) => {
    const [created] = await Currency.create([body], { session });
    await logAudit({ req, action: 'currency.create', model: 'AccountingCurrency', docId: created._id, after: created }, session);
    return created;
  });
  invalidateConfig();
  res.status(201).json(currency);
});

module.exports.updateCurrency = handle(async (req, res) => {
  const currency = await Currency.findOne({ code: req.params.code });
  if (!currency) throw notFound('العملة غير موجودة');
  const body = pick(req.body, ['name', 'symbol', 'decimals']);
  if (body.decimals !== undefined && Number(body.decimals) !== currency.decimals) {
    const usage = await currencyUsage(currency.code);
    if (usage.entries || usage.accounts) throw badRequest('لا يمكن تغيير عدد الخانات لعملة مستخدمة');
  }
  const before = currency.toObject();
  Object.assign(currency, body);
  await runInTransaction(async (session) => {
    await currency.save({ session });
    await logAudit({ req, action: 'currency.update', model: 'AccountingCurrency', docId: currency._id, before, after: currency }, session);
  });
  invalidateConfig();
  res.json(currency);
});

module.exports.setCurrencyActive = (isActive) => handle(async (req, res) => {
  const currency = await Currency.findOne({ code: req.params.code });
  if (!currency) throw notFound('العملة غير موجودة');
  if (currency.isBase) throw badRequest('العملة الأساسية لا تُؤرشف');
  if (!isActive) {
    const usage = await currencyUsage(currency.code);
    if (usage.activeAccounts || usage.walletsWithBalance) {
      throw badRequest(`لا يمكن الأرشفة: ${usage.activeAccounts} حساباً نشطاً و${usage.walletsWithBalance} محفظة برصيد بهذه العملة`);
    }
  }
  currency.isActive = isActive;
  await runInTransaction(async (session) => {
    await currency.save({ session });
    await logAudit({ req, action: isActive ? 'currency.unarchive' : 'currency.archive', model: 'AccountingCurrency', docId: currency._id }, session);
  });
  invalidateConfig();
  res.json(currency);
});

module.exports.deleteCurrency = handle(async (req, res) => {
  const currency = await Currency.findOne({ code: req.params.code });
  if (!currency) throw notFound('العملة غير موجودة');
  if (currency.isBase) throw badRequest('العملة الأساسية لا تُحذف');
  const usage = await currencyUsage(currency.code);
  if (usage.accounts || usage.entries || usage.wallets || usage.statements) {
    return res.status(400).json({ success: false, message: 'لا يمكن الحذف - العملة مستخدمة', usage, canArchive: true });
  }
  await runInTransaction(async (session) => {
    await CurrencyRate.deleteMany({ currency: currency.code }, { session });
    await Currency.deleteOne({ _id: currency._id }, { session });
    await logAudit({ req, action: 'currency.delete', model: 'AccountingCurrency', docId: currency._id, before: currency }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

// ---- Offices ----

module.exports.listOffices = handle(async (req, res) => {
  const offices = await AccountingOffice.find({}).sort({ createdAt: 1 }).lean();
  const cash = await Account.find({ isCash: true }).select('code name currency office cashKind isActive').lean();
  res.json({ results: offices.map((office) => ({ ...office, cashAccounts: cash.filter((account) => account.office === office.code) })) });
});

// A new office gets a cash box and a journal for each chosen currency, and becomes the
// cash box used for that office's operations.
module.exports.createOffice = handle(async (req, res) => {
  const body = pick(req.body, ['code', 'name', 'nameEn', 'country']);
  body.code = String(body.code || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,30}$/.test(body.code)) throw badRequest('رمز المكتب بالإنجليزية بدون مسافات (مثل misurata2)');
  if (!body.name) throw badRequest('اسم المكتب مطلوب');
  const currencies = Array.isArray(req.body.currencies) ? req.body.currencies : [];
  const { currencies: known } = await getConfig();
  currencies.forEach((code) => { if (!known.get(code)?.isActive) throw badRequest(`العملة ${code} غير متاحة`); });

  const group = await Account.findOne({ seedKey: '1101' }) || await Account.findOne({ code: '1101' });
  if (currencies.length && !group) throw badRequest('مجموعة الخزائن غير موجودة؛ شغّل الإعداد أولاً');

  const office = await runInTransaction(async (session) => {
    const [created] = await AccountingOffice.create([body], { session });
    const settings = await AccountingSettings.findOne({ key: 'main' }).session(session);
    const officeAccounts = JSON.parse(JSON.stringify(settings.officeAccounts || {}));
    officeAccounts[body.code] = officeAccounts[body.code] || {};

    for (const currency of currencies) {
      const siblings = await Account.find({ parentId: group._id }).select('code').session(session).lean();
      const max = siblings.reduce((top, { code }) => (code.startsWith(group.code) ? Math.max(top, Number(code.slice(group.code.length)) || 0) : top), 0);
      const code = `${group.code}${String(max + 1).padStart(2, '0')}`;
      const [account] = await Account.create([{
        code, name: `خزينة ${body.name} - ${currency}`, nameEn: `${body.nameEn || body.code} cash - ${currency}`,
        type: 'asset', parentId: group._id, currency, isCash: true, cashKind: 'cash', office: body.code, requires: ['office'],
      }], { session });
      const journalCode = `CASH-${body.code.slice(0, 6).toUpperCase()}-${currency}`;
      await Journal.create([{
        code: journalCode, name: account.name, type: 'cash', defaultAccountId: account._id, office: body.code, sequencePrefix: journalCode,
      }], { session });
      officeAccounts[body.code][currency] = account._id;
    }

    settings.officeAccounts = officeAccounts;
    settings.markModified('officeAccounts');
    await settings.save({ session });
    await logAudit({ req, action: 'office.create', model: 'AccountingOffice', docId: created._id, after: { ...created.toObject(), currencies } }, session);
    return created;
  });
  invalidateConfig();
  res.status(201).json(office);
});

module.exports.updateOffice = handle(async (req, res) => {
  const office = await AccountingOffice.findOne({ code: req.params.code });
  if (!office) throw notFound('المكتب غير موجود');
  const before = office.toObject();
  Object.assign(office, pick(req.body, ['name', 'nameEn', 'country']));
  await runInTransaction(async (session) => {
    await office.save({ session });
    await logAudit({ req, action: 'office.update', model: 'AccountingOffice', docId: office._id, before, after: office }, session);
  });
  invalidateConfig();
  res.json(office);
});

// Archiving an office archives its cash boxes and their journals too, but only when all of
// them are at zero in their currency and in USD.
module.exports.setOfficeActive = (isActive) => handle(async (req, res) => {
  const office = await AccountingOffice.findOne({ code: req.params.code });
  if (!office) throw notFound('المكتب غير موجود');
  const accounts = await Account.find({ office: office.code, isCash: true });
  if (!isActive) {
    for (const account of accounts) {
      const balance = await getBalance(account._id);
      if (balance.usd || balance.foreign) throw badRequest(`لا يمكن الأرشفة: رصيد ${account.code} ${account.name} ليس صفراً`);
    }
  }
  await runInTransaction(async (session) => {
    office.isActive = isActive;
    await office.save({ session });
    await Account.updateMany({ _id: { $in: accounts.map((a) => a._id) } }, { $set: { isActive } }, { session });
    await Journal.updateMany({ defaultAccountId: { $in: accounts.map((a) => a._id) } }, { $set: { isActive } }, { session });
    await logAudit({ req, action: isActive ? 'office.unarchive' : 'office.archive', model: 'AccountingOffice', docId: office._id }, session);
  });
  invalidateConfig();
  res.json(office);
});

module.exports.deleteOffice = handle(async (req, res) => {
  const office = await AccountingOffice.findOne({ code: req.params.code });
  if (!office) throw notFound('المكتب غير موجود');
  const settings = await AccountingSettings.findOne({ key: 'main' });
  const usage = await officeUsage(office.code, settings?.officeAliases);
  if (usage.accounts || usage.entries || usage.statements || usage.journals) {
    return res.status(400).json({ success: false, message: 'لا يمكن الحذف - المكتب مستخدم', usage, canArchive: true });
  }
  await runInTransaction(async (session) => {
    const officeAccounts = { ...(settings.officeAccounts || {}) };
    delete officeAccounts[office.code];
    settings.officeAccounts = officeAccounts;
    settings.markModified('officeAccounts');
    await settings.save({ session });
    await AccountingOffice.deleteOne({ _id: office._id }, { session });
    await logAudit({ req, action: 'office.delete', model: 'AccountingOffice', docId: office._id, before: office }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

// ---- Journals ----

module.exports.listJournals = handle(async (req, res) => {
  const journals = await Journal.find({}).sort({ type: 1, code: 1 }).populate('defaultAccountId', 'code name').lean();
  res.json({ results: journals });
});

module.exports.createJournal = handle(async (req, res) => {
  const body = pick(req.body, ['code', 'name', 'type', 'defaultAccountId', 'office', 'sequencePrefix', 'sequenceResetYearly']);
  body.code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,20}$/.test(body.code)) throw badRequest('رمز الدفتر بأحرف إنجليزية كبيرة وأرقام');
  if (!body.name) throw badRequest('اسم الدفتر مطلوب');
  if (!JOURNAL_TYPES.includes(body.type)) throw badRequest('نوع الدفتر غير صالح');
  if (body.defaultAccountId) {
    const account = isObjectId(body.defaultAccountId) && await Account.findById(body.defaultAccountId).lean();
    if (!account?.isCash) throw badRequest('الحساب الافتراضي يجب أن يكون خزينة أو بنكاً');
  }
  body.sequencePrefix = body.sequencePrefix || body.code;
  const journal = await runInTransaction(async (session) => {
    const [created] = await Journal.create([body], { session });
    await logAudit({ req, action: 'journal.create', model: 'AccountingJournal', docId: created._id, after: created }, session);
    return created;
  });
  res.status(201).json(journal);
});

module.exports.updateJournal = handle(async (req, res) => {
  const journal = await Journal.findById(req.params.id);
  if (!journal) throw notFound('الدفتر غير موجود');
  const body = pick(req.body, ['code', 'name', 'sequencePrefix', 'sequenceResetYearly', 'office']);
  const usage = await journalUsage(journal);
  if (usage.entries && ['code', 'sequencePrefix', 'sequenceResetYearly'].some((f) => body[f] !== undefined && body[f] !== journal[f])) {
    throw badRequest('لا يمكن تغيير رمز الدفتر أو ترقيمه بعد أول قيد');
  }
  if (usage.events.length && body.code && body.code !== journal.code) throw badRequest('الدفتر مربوط بأحداث؛ غيّر الربط أولاً');
  const before = journal.toObject();
  Object.assign(journal, body);
  await runInTransaction(async (session) => {
    await journal.save({ session });
    await logAudit({ req, action: 'journal.update', model: 'AccountingJournal', docId: journal._id, before, after: journal }, session);
  });
  res.json(journal);
});

module.exports.setJournalActive = (isActive) => handle(async (req, res) => {
  const journal = await Journal.findById(req.params.id);
  if (!journal) throw notFound('الدفتر غير موجود');
  if (!isActive) {
    const usage = await journalUsage(journal);
    if (usage.events.length) throw badRequest(`الدفتر مربوط بأحداث (${usage.events.join('، ')})؛ غيّر الربط أولاً`);
    if (journal.defaultAccountId && await Account.exists({ _id: journal.defaultAccountId, isActive: true })) {
      throw badRequest('الدفتر الافتراضي لخزينة نشطة؛ أرشف الخزينة بدلاً منه');
    }
  }
  journal.isActive = isActive;
  await runInTransaction(async (session) => {
    await journal.save({ session });
    await logAudit({ req, action: isActive ? 'journal.unarchive' : 'journal.archive', model: 'AccountingJournal', docId: journal._id }, session);
  });
  res.json(journal);
});

module.exports.deleteJournal = handle(async (req, res) => {
  const journal = await Journal.findById(req.params.id);
  if (!journal) throw notFound('الدفتر غير موجود');
  const usage = await journalUsage(journal);
  if (usage.entries || usage.events.length || journal.defaultAccountId) {
    return res.status(400).json({ success: false, message: 'لا يمكن الحذف - الدفتر مستخدم', usage, canArchive: true });
  }
  await runInTransaction(async (session) => {
    await Journal.deleteOne({ _id: journal._id }, { session });
    await logAudit({ req, action: 'journal.delete', model: 'AccountingJournal', docId: journal._id, before: journal }, session);
  });
  res.json({ success: true });
});
