const { AccountingSettings, Journal, Account } = require('../models');
const { handle, badRequest, isObjectId, pick } = require('./util');
const { getConfig, invalidateConfig } = require('../services/config');
const { roleProblem } = require('../services/roles');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');
const { isDay } = require('../services/dates');
const { runSetup, isSetupDone } = require('../seed/setup');
const { wizardStatus, markStep } = require('../services/wizard');
const { ROLE_DEFAULTS, ROLE_LABELS, EVENT_JOURNALS } = require('../seed/defaults');

const accountSummary = (account) => account && ({ _id: account._id, code: account.code, name: account.name, currency: account.currency, isActive: account.isActive });

module.exports.get = handle(async (req, res) => {
  const { settings, accountsById } = await getConfig();
  if (!settings) return res.json({ setupDone: false });

  const roleNames = [...new Set([...Object.keys(ROLE_DEFAULTS), ...Object.keys(settings.accountRoles || {})])];
  const roles = roleNames.map((role) => {
    const account = accountsById.get(String(settings.accountRoles?.[role] || ''));
    return { role, label: ROLE_LABELS[role] || role, account: accountSummary(account), problem: roleProblem(role, account) };
  });

  const officeAccounts = Object.entries(settings.officeAccounts || {}).flatMap(([office, map]) => (
    Object.entries(map || {}).map(([currency, id]) => ({
      office, currency, alias: settings.officeAliases?.[office] || null, account: accountSummary(accountsById.get(String(id))),
    }))
  ));

  res.json({
    setupDone: !!settings.setupCompletedAt,
    settings: pick(settings, ['lockDate', 'historyStartDate', 'migrationDate', 'fiscalYearStartMonth', 'writeOffAfterDays', 'rateFallbackNext', 'volumetricFactor', 'abandonAfterDays', 'cutoffAt', 'timezone', 'setupCompletedAt', 'wizard', 'officeAliases']),
    roles,
    officeAccounts,
    eventJournals: { ...EVENT_JOURNALS, ...(settings.eventJournals || {}) },
  });
});

module.exports.update = handle(async (req, res) => {
  const changes = pick(req.body, ['lockDate', 'fiscalYearStartMonth', 'writeOffAfterDays', 'rateFallbackNext', 'volumetricFactor', 'abandonAfterDays']);
  if (changes.lockDate !== undefined && changes.lockDate !== null && !isDay(changes.lockDate)) throw badRequest('تاريخ الإقفال غير صالح');
  if (changes.fiscalYearStartMonth !== undefined && !(changes.fiscalYearStartMonth >= 1 && changes.fiscalYearStartMonth <= 12)) {
    throw badRequest('شهر بداية السنة غير صالح');
  }
  if (changes.writeOffAfterDays !== undefined && !(Number.isInteger(Number(changes.writeOffAfterDays)) && Number(changes.writeOffAfterDays) >= 30)) {
    throw badRequest('عدد الأيام يجب أن يكون 30 أو أكثر');
  }
  if (changes.volumetricFactor !== undefined && !(Number(changes.volumetricFactor) > 0)) throw badRequest('معامل الوزن الحجمي غير صالح');
  if (changes.abandonAfterDays !== undefined && !(Number.isInteger(Number(changes.abandonAfterDays)) && Number(changes.abandonAfterDays) >= 30)) throw badRequest('عدد الأيام يجب أن يكون 30 أو أكثر');
  const settings = await AccountingSettings.findOne({ key: 'main' });
  const before = pick(settings.toObject(), Object.keys(changes));
  Object.assign(settings, changes);
  await runInTransaction(async (session) => {
    await settings.save({ session });
    await logAudit({ req, action: 'settings.update', model: 'AccountingSettings', docId: settings._id, before, after: changes }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

// Every role must stay linked to a valid account; changes only affect new entries
module.exports.updateRoles = handle(async (req, res) => {
  const input = req.body?.roles || {};
  const settings = await AccountingSettings.findOne({ key: 'main' });
  const roles = { ...(settings.accountRoles || {}) };
  Object.entries(input).forEach(([role, id]) => {
    if (!isObjectId(id)) throw badRequest(`الدور ${role}: حساب غير صالح`);
    roles[role] = id;
  });

  const accounts = await Account.find({ _id: { $in: Object.values(roles) } }).lean();
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const problems = [...new Set([...Object.keys(ROLE_DEFAULTS), ...Object.keys(roles)])]
    .map((role) => ({ role, problem: roleProblem(role, byId.get(String(roles[role] || ''))) }))
    .filter((item) => item.problem);
  if (problems.length) {
    return res.status(400).json({ success: false, message: 'لا يمكن الحفظ: أدوار بلا حساب صالح', problems });
  }

  const before = settings.accountRoles;
  settings.accountRoles = roles;
  settings.markModified('accountRoles');
  await runInTransaction(async (session) => {
    await settings.save({ session });
    await logAudit({ req, action: 'settings.roles', model: 'AccountingSettings', docId: settings._id, before, after: roles }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

// { officeAccounts: { tripoli: { USD: accountId, LYD: accountId } } }
module.exports.updateOfficeAccounts = handle(async (req, res) => {
  const input = req.body?.officeAccounts || {};
  const { offices } = await getConfig();
  const settings = await AccountingSettings.findOne({ key: 'main' });
  const aliases = settings.officeAliases || {};
  const officeAccounts = JSON.parse(JSON.stringify(settings.officeAccounts || {}));

  for (const [office, map] of Object.entries(input)) {
    if (!offices.has(office) && !aliases[office]) throw badRequest(`المكتب ${office} غير معرّف`);
    for (const [currency, id] of Object.entries(map || {})) {
      officeAccounts[office] = officeAccounts[office] || {};
      if (!id) { delete officeAccounts[office][currency]; continue; }
      const account = isObjectId(id) && await Account.findById(id).lean();
      if (!account || !account.isCash || !account.isActive) throw badRequest(`${office}/${currency}: اختر خزينة أو بنكاً نشطاً`);
      if (account.currency !== currency) throw badRequest(`${office}/${currency}: عملة الحساب ${account.currency}`);
      officeAccounts[office][currency] = account._id;
    }
  }

  const before = settings.officeAccounts;
  settings.officeAccounts = officeAccounts;
  settings.markModified('officeAccounts');
  await runInTransaction(async (session) => {
    await settings.save({ session });
    await logAudit({ req, action: 'settings.officeAccounts', model: 'AccountingSettings', docId: settings._id, before, after: officeAccounts }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

module.exports.updateEventJournals = handle(async (req, res) => {
  const input = req.body?.eventJournals || {};
  const settings = await AccountingSettings.findOne({ key: 'main' });
  const eventJournals = { ...(settings.eventJournals || {}) };
  for (const [event, code] of Object.entries(input)) {
    if (!EVENT_JOURNALS[event]) throw badRequest(`حدث غير معروف: ${event}`);
    if (code !== '@cash' && !(await Journal.exists({ code, isActive: true }))) throw badRequest(`الدفتر ${code} غير موجود أو مؤرشف`);
    eventJournals[event] = code;
  }
  const before = settings.eventJournals;
  settings.eventJournals = eventJournals;
  settings.markModified('eventJournals');
  await runInTransaction(async (session) => {
    await settings.save({ session });
    await logAudit({ req, action: 'settings.eventJournals', model: 'AccountingSettings', docId: settings._id, before, after: eventJournals }, session);
  });
  invalidateConfig();
  res.json({ success: true });
});

// The start wizard: every step with its state (read from the data), and marking a step
module.exports.wizard = handle(async (req, res) => res.json(await wizardStatus()));

module.exports.markWizardStep = handle(async (req, res) => {
  const { step, value } = req.body || {};
  const status = await markStep(step, value === undefined ? null : value);
  await runInTransaction((session) => logAudit({ req, action: 'wizard.mark', model: 'AccountingSettings', after: { step, value } }, session));
  res.json(status);
});

module.exports.setupStatus = handle(async (req, res) => {
  res.json({ setupDone: await isSetupDone() });
});

module.exports.runSetup = handle(async (req, res) => {
  const report = await runSetup({ user: req.user });
  await runInTransaction((session) => logAudit({ req, action: 'setup.run', model: 'AccountingSettings', after: { created: report.created } }, session));
  res.json(report);
});
