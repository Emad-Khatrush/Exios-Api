const { handle, badRequest, isObjectId } = require('./util');
const { Account, Journal } = require('../models');
const { isDay, today } = require('../services/dates');
const { logAudit } = require('../services/audit');
const odoo = require('../services/odoo');

// Everything the export screen shows: settings, the Odoo codes of accounts and journals, what
// the next export would take, and the batches already exported
module.exports.overview = handle(async (req, res) => {
  const upTo = req.query.upTo || today();
  if (!isDay(upTo)) throw badRequest('التاريخ غير صالح');
  const [settings, pending, accounts, journals, exports] = await Promise.all([
    odoo.odooSettings(),
    odoo.pendingSummary(upTo),
    Account.find({ isGroup: false }).select('code name odooCode isActive').sort({ code: 1 }).lean(),
    Journal.find({}).select('code name odooJournal isActive').sort({ code: 1 }).lean(),
    odoo.listExports(),
  ]);
  res.json({ upTo, settings, pending, accounts, journals, exports, companyCurrencies: odoo.COMPANY_CURRENCIES });
});

module.exports.saveSettings = handle(async (req, res) => {
  const settings = await odoo.saveSettings(req.body || {});
  await logAudit({ req, action: 'odoo.settings', model: 'AccountingSettings', after: settings });
  res.json(settings);
});

// { accounts: [{ _id, odooCode }], journals: [{ _id, odooJournal }] }
module.exports.saveMapping = handle(async (req, res) => {
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
  const journals = Array.isArray(req.body?.journals) ? req.body.journals : [];
  if ([...accounts, ...journals].some((row) => !isObjectId(row?._id))) throw badRequest('عنصر غير صالح');
  for (const row of accounts) await Account.updateOne({ _id: row._id }, { $set: { odooCode: String(row.odooCode || '').trim() } });
  for (const row of journals) await Journal.updateOne({ _id: row._id }, { $set: { odooJournal: String(row.odooJournal || '').trim() } });
  await logAudit({ req, action: 'odoo.mapping', model: 'AccountingAccount', after: { accounts: accounts.length, journals: journals.length } });
  res.json({ accounts: accounts.length, journals: journals.length });
});

module.exports.createExport = handle(async (req, res) => {
  const upTo = req.body?.upTo || today();
  if (!isDay(upTo)) throw badRequest('التاريخ غير صالح');
  const result = await odoo.createExport({ upTo, user: req.user });
  await logAudit({ req, action: 'odoo.export', model: 'AccountingOdooExport', docId: result.export._id, after: { number: result.export.number, count: result.export.count } });
  res.status(201).json(result);
});

module.exports.exportRows = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('الدفعة غير صالحة');
  res.json(await odoo.exportRows(req.params.id));
});

module.exports.undoExport = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('الدفعة غير صالحة');
  const batch = await odoo.undoExport(req.params.id, req.user);
  await logAudit({ req, action: 'odoo.undo', model: 'AccountingOdooExport', docId: batch._id, after: { number: batch.number } });
  res.json(batch);
});

// The weekly comparison with Odoo: our three figures on a day, and the comparisons saved so far
module.exports.comparison = handle(async (req, res) => {
  const day = req.query.day || today();
  if (!isDay(day)) throw badRequest('التاريخ غير صالح');
  const [ours, history] = await Promise.all([odoo.ourFigures(day), odoo.listComparisons()]);
  res.json({ day, ours, history });
});

module.exports.saveComparison = handle(async (req, res) => {
  const day = req.body?.day;
  if (!isDay(day)) throw badRequest('التاريخ غير صالح');
  const doc = await odoo.saveComparison(req.body, req.user);
  await logAudit({ req, action: 'odoo.compare', model: 'AccountingOdooComparison', docId: doc._id, after: doc });
  res.status(201).json(doc);
});
