const { MigrationRun } = require('../models');
const { handle, badRequest, notFound, isObjectId } = require('./util');
const { getConfig } = require('../services/config');
const { isDay, today, addDays } = require('../services/dates');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const migration = require('../services/migration');

module.exports.overview = handle(async (req, res) => {
  const { settings, count } = await getConfig();
  res.json({ ...(await migration.inventory()), migrationDate: settings?.migrationDate || null, liveEnabled: !!settings?.liveEnabled,
    bankTrialAvailable: process.env.EXIOS_QA === '1',
    openingCountDay: count?.day || null, operationalStartDate: count?.endOfDay ? addDays(count.day, 1) : count?.day || null });
});

module.exports.costTemplate = handle(async (req, res) => {
  res.json({ results: await migration.costTemplate() });
});

// Body: { costAccounts: [{ kind, key, accountCode }], openingCounts: [{ accountId, amount }] }
module.exports.start = handle(async (req, res) => {
  const { accountsByCode, accountsById } = await getConfig();
  const costAccounts = (req.body?.costAccounts || []).map((row, index) => {
    const account = accountsByCode.get(String(row.accountCode || '').trim());
    if (!['trip', 'order'].includes(row.kind)) throw badRequest(`سطر الربط ${index + 1}: النوع يجب أن يكون trip أو order`);
    if (!account?.isCash) throw badRequest(`سطر الربط ${index + 1}: الحساب ${row.accountCode} ليس خزينة`);
    return { kind: row.kind, key: String(row.key).trim(), accountId: account._id };
  });
  const openingCounts = (req.body?.openingCounts || []).filter((row) => row.amount !== '' && row.amount !== null && row.amount !== undefined).map((row) => {
    if (!isObjectId(row.accountId) || !accountsById.get(String(row.accountId))?.isCash) throw badRequest('حساب غير صالح في الجرد');
    if (!Number.isFinite(Number(row.amount))) throw badRequest('مبلغ غير صالح في الجرد');
    return { accountId: row.accountId, amount: Number(row.amount) };
  });
  const countDay = req.body?.countDay || undefined;
  if (countDay && (!isDay(countDay) || countDay > today())) throw badRequest('تاريخ الجرد غير صالح أو في المستقبل');
  const run = await migration.startRun({ user: req.user, config: { costAccounts, openingCounts, countDay, closeSuspense: !!req.body?.closeSuspense, purchaseCostsFromStatements: !!req.body?.purchaseCostsFromStatements } });
  await runInTransaction((session) => logAudit({ req, action: 'migration.start', model: 'AccountingMigrationRun', docId: run._id, after: { runId: run.runId, costAccounts: costAccounts.length, openingCounts: openingCounts.length } }, session));
  res.status(201).json(run);
});

module.exports.get = handle(async (req, res) => {
  const run = await MigrationRun.findOne({ runId: req.params.runId }).populate('createdBy', 'firstName lastName').lean();
  if (!run) throw notFound('التشغيل غير موجود');
  res.json(run);
});

module.exports.enableBankTrial = handle(async (req, res) => {
  res.json(await require('../services/migration/bankTrial').enable(req.params.runId, req.user));
});

module.exports.discard = handle(async (req, res) => {
  const run = await migration.discardRun(req.params.runId, { user: req.user });
  await runInTransaction((session) => logAudit({ req, action: 'migration.discard', model: 'AccountingMigrationRun', docId: run._id }, session));
  res.json(run);
});

module.exports.commit = handle(async (req, res) => {
  const run = await migration.commitRun(req.params.runId, { user: req.user });
  await runInTransaction((session) => logAudit({ req, action: 'migration.commit', model: 'AccountingMigrationRun', docId: run._id }, session));
  res.json(run);
});
