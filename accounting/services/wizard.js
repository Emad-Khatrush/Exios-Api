// The start wizard (spec 7-ب.3): the eight steps from a fresh setup to live posting. Each step's
// state is read from the real data (rates entered, the migration run and its counts, live
// posting on); only what cannot be seen in the data (offices reviewed, optional steps skipped)
// is kept in settings.wizard.
const { AccountingSettings, AccountingOffice, Account, Currency, CurrencyRate, MigrationRun } = require('../models');
const ErrorHandler = require('../../utils/errorHandler');
const { today } = require('./dates');
const { invalidateConfig } = require('./config');

// What a person can mark in the wizard, and the value it takes
const MARKS = {
  offices: ['done'],
  historicalRates: ['done', 'skipped'],
  tripCosts: ['done', 'skipped'],
  counts: ['skipped'],
};

async function wizardStatus() {
  const day = today();
  const [settings, offices, cashAccounts, currencies, latestRun] = await Promise.all([
    AccountingSettings.findOne({ key: 'main' }).lean(),
    AccountingOffice.find({ isActive: true }).select('code name').sort({ code: 1 }).lean(),
    Account.find({ isCash: true, isGroup: false, isActive: true }).select('code name office currency cashKind').sort({ code: 1 }).lean(),
    Currency.find({ isActive: true, isBase: { $ne: true } }).select('code name').sort({ code: 1 }).lean(),
    MigrationRun.findOne({ status: { $nin: ['discarded', 'failed'] } }).sort({ createdAt: -1 }).select('runId status config.openingCounts config.costAccounts config.countDay createdAt committedAt').lean(),
  ]);
  const marks = settings?.wizard || {};

  const todayRates = await CurrencyRate.find({ day, currency: { $in: currencies.map((c) => c.code) } }).select('currency rate').lean();
  const rateOf = new Map(todayRates.map((r) => [r.currency, r.rate]));
  const needed = new Set(['LYD', ...cashAccounts.map((a) => a.currency).filter((c) => c && c !== 'USD')]);
  const olderRates = await CurrencyRate.countDocuments({ day: { $lt: day }, source: 'entered' });

  const committed = !!settings?.migrationDate && latestRun?.status === 'committed';
  const hasRun = !!latestRun && ['running', 'review', 'committing', 'committed'].includes(latestRun.status);
  const counts = latestRun?.config?.openingCounts?.length || 0;
  const costLinks = latestRun?.config?.costAccounts?.length || 0;

  const steps = [
    {
      key: 'offices', title: 'مراجعة المكاتب والخزائن', optional: false,
      done: marks.offices === 'done',
      detail: { offices: offices.length, cashAccounts: cashAccounts.length, list: offices.map((o) => ({ ...o, boxes: cashAccounts.filter((a) => a.office === o.code).length })) },
    },
    {
      key: 'todayRates', title: 'أسعار اليوم', optional: false,
      // Needed: the dinar, and every currency a cash box holds. Other active currencies are optional
      done: currencies.filter((c) => needed.has(c.code)).every((c) => rateOf.has(c.code)),
      detail: { day, currencies: currencies.map((c) => ({ code: c.code, name: c.name, rate: rateOf.get(c.code) ?? null, required: needed.has(c.code) })).sort((a, b) => Number(b.required) - Number(a.required)) },
    },
    {
      key: 'historicalRates', title: 'ملف الأسعار التاريخية', optional: true,
      done: ['done', 'skipped'].includes(marks.historicalRates), skipped: marks.historicalRates === 'skipped',
      detail: { enteredBefore: olderRates },
    },
    {
      key: 'tripCosts', title: 'ربط تكاليف الرحلات القديمة بالخزائن', optional: true,
      done: ['done', 'skipped'].includes(marks.tripCosts) || costLinks > 0, skipped: marks.tripCosts === 'skipped' && !costLinks,
      detail: { links: costLinks },
    },
    {
      key: 'counts', title: 'جرد الخزائن والبنوك يوم البدء', optional: false,
      done: (hasRun && counts > 0) || marks.counts === 'skipped', skipped: marks.counts === 'skipped' && !counts,
      detail: { counts, countDay: latestRun?.config?.countDay || null },
    },
    {
      key: 'dryRun', title: 'الترحيل التاريخي التجريبي', optional: false,
      done: hasRun && latestRun.status !== 'running',
      detail: { runId: latestRun?.runId || null, status: latestRun?.status || null },
    },
    {
      key: 'commit', title: 'مراجعة التقرير واعتماده', optional: false,
      done: committed,
      detail: { migrationDate: settings?.migrationDate || null },
    },
    {
      key: 'live', title: 'تم: النظام يعمل', optional: false,
      done: committed && !!settings?.liveEnabled,
      detail: { liveEnabled: !!settings?.liveEnabled },
    },
  ];

  // Steps 3 and 4 can wait, but not past the commit (spec 7-ب.3)
  // Once finished it stays finished while the migration stands: a new day without its rates is a
  // dashboard warning, not a reason to send the accountant back to the wizard every morning
  const completed = (!!marks.completedAt && committed) || steps.every((step) => step.done);
  if (completed && !marks.completedAt) {
    await AccountingSettings.updateOne({ key: 'main' }, { $set: { 'wizard.completedAt': new Date() } });
    invalidateConfig();
  }
  const current = steps.find((step) => !step.done)?.key || null;
  return {
    steps, current, completed,
    completedAt: marks.completedAt || (completed ? new Date() : null),
    progress: { done: steps.filter((s) => s.done).length, total: steps.length },
  };
}

async function markStep(step, value) {
  if (!MARKS[step]) throw new ErrorHandler(400, 'خطوة غير معروفة');
  if (value !== null && !MARKS[step].includes(value)) throw new ErrorHandler(400, 'قيمة غير صالحة لهذه الخطوة');
  await AccountingSettings.updateOne({ key: 'main' }, value === null ? { $unset: { [`wizard.${step}`]: '' } } : { $set: { [`wizard.${step}`]: value } });
  invalidateConfig();
  return wizardStatus();
}

module.exports = { wizardStatus, markStep };
