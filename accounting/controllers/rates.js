const { CurrencyRate, Currency } = require('../models');
const { handle, badRequest, notFound } = require('./util');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const { isDay, today } = require('../services/dates');
const { recordSettingsRate } = require('../services/settingsRate');

module.exports.list = handle(async (req, res) => {
  const query = {};
  if (req.query.currency) query.currency = req.query.currency;
  if (req.query.from || req.query.to) {
    query.day = {};
    if (req.query.from) query.day.$gte = req.query.from;
    if (req.query.to) query.day.$lte = req.query.to;
  }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rates = await CurrencyRate.find(query).sort({ day: -1, currency: 1 }).limit(limit).populate('createdBy', 'firstName lastName').lean();
  res.json({ results: rates });
});

// For every active foreign currency: today's rate, or the last one before it (flagged as missing)
module.exports.today = handle(async (req, res) => {
  const day = today();
  const currencies = await Currency.find({ isActive: true, isBase: { $ne: true } }).sort({ code: 1 }).lean();
  const results = await Promise.all(currencies.map(async (currency) => {
    const last = await CurrencyRate.findOne({ currency: currency.code, day: { $lte: day } }).sort({ day: -1 }).lean();
    return { currency: currency.code, name: currency.name, day, rate: last?.rate ?? null, rateDay: last?.day ?? null, isToday: last?.day === day };
  }));
  res.json({ day, results });
});

// Creates or replaces the rate of a day, unless an entry already used it
module.exports.upsert = handle(async (req, res) => {
  const { currency, day } = req.body;
  const rate = Number(req.body.rate);
  if (!isDay(day)) throw badRequest('التاريخ غير صالح');
  if (!(rate > 0)) throw badRequest('السعر يجب أن يكون أكبر من صفر');
  const known = await Currency.findOne({ code: currency, isActive: true }).lean();
  if (!known || known.isBase) throw badRequest('العملة غير متاحة');
  // Today's dinar rate is the settings rate: both are written together (spec 2.1)
  if (currency === 'LYD' && day === today()) {
    res.json(await recordSettingsRate(rate, { req }));
    return;
  }

  const result = await runInTransaction(async (session) => {
    const existing = await CurrencyRate.findOne({ currency, day }).session(session);
    if (existing?.isUsed && existing.rate !== rate) {
      throw badRequest('هذا السعر استُخدم في قيود مُرحَّلة ولا يمكن تغييره؛ التصحيح يكون بقيد');
    }
    if (existing) {
      const before = existing.toObject();
      existing.rate = rate;
      await existing.save({ session });
      await logAudit({ req, action: 'rate.update', model: 'AccountingCurrencyRate', docId: existing._id, before, after: existing }, session);
      return existing;
    }
    const [created] = await CurrencyRate.create([{ currency, day, rate, createdBy: req.user._id }], { session });
    await logAudit({ req, action: 'rate.create', model: 'AccountingCurrencyRate', docId: created._id, after: created }, session);
    return created;
  });
  res.json(result);
});

// Historical rates from a spreadsheet: [{ currency, day, rate }]. Rates already used by posted
// entries are kept as they are; everything else is created or replaced.
module.exports.importRates = handle(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw badRequest('الملف فارغ');
  const currencies = new Set((await Currency.find({ isActive: true, isBase: { $ne: true } }).lean()).map((c) => c.code));
  const result = { created: 0, updated: 0, keptUsed: 0, invalid: [] };
  await runInTransaction(async (session) => {
    for (const [index, row] of rows.entries()) {
      const currency = String(row.currency || '').trim().toUpperCase();
      const rate = Number(row.rate);
      if (!currencies.has(currency) || !isDay(row.day) || !(rate > 0)) { result.invalid.push(index + 2); continue; }
      const existing = await CurrencyRate.findOne({ currency, day: row.day }).session(session);
      if (existing?.isUsed) { result.keptUsed++; continue; }
      if (existing) {
        existing.rate = rate;
        existing.source = 'entered';
        existing.migrationRunId = undefined;
        await existing.save({ session });
        result.updated++;
      } else {
        await CurrencyRate.create([{ currency, day: row.day, rate, createdBy: req.user._id }], { session });
        result.created++;
      }
    }
    await logAudit({ req, action: 'rate.import', model: 'AccountingCurrencyRate', after: { ...result, invalid: result.invalid.length } }, session);
  });
  res.json(result);
});

module.exports.remove = handle(async (req, res) => {
  const rate = await CurrencyRate.findById(req.params.id);
  if (!rate) throw notFound('السعر غير موجود');
  if (rate.isUsed) throw badRequest('هذا السعر استُخدم في قيود مُرحَّلة ولا يمكن حذفه');
  await runInTransaction(async (session) => {
    await CurrencyRate.deleteOne({ _id: rate._id }, { session });
    await logAudit({ req, action: 'rate.delete', model: 'AccountingCurrencyRate', docId: rate._id, before: rate }, session);
  });
  res.json({ success: true });
});
