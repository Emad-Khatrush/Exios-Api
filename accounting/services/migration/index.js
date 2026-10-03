// Running the historical migration (spec 6-أ): dry run in the real books under a run id while the
// historical period is reserved for it; the owner reviews the report, then discards (everything
// the run wrote disappears and numbering goes back) or commits (catch-up + live posting on).
const crypto = require('crypto');
const ErrorHandler = require('../../../utils/errorHandler');
const { JournalEntry, Journal, Counter, CurrencyRate, MigrationRun, AccountingSettings, Voucher, AccountingEvent } = require('../../models');
const docs = require('../../models/documents');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const Balance = require('../../../models/balance');
const Expense = require('../../../models/expenses');
const Income = require('../../../models/income');
const { invalidateConfig } = require('../config');
const { toDay } = require('../dates');
const { replay } = require('./replay');
const { buildReport } = require('./report');
const { markCovered } = require('../events');
const { backfillTripLinks } = require('../tripLinks');

const ACTIVE = ['running', 'review', 'committing'];
const fail = (message) => new ErrorHandler(400, message);

async function setSettings(values) {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: values });
  invalidateConfig();
}

// Runs this process is working on; a run left 'running' by a restart is not here and can be discarded
const inProcess = new Set();

async function execute(run) {
  inProcess.add(run.runId);
  try {
    // Packages carried by a trip before the trip links existed get them first (spec 4.3)
    await MigrationRun.updateOne({ _id: run._id }, { $set: { progress: { phase: 'links', done: 0, total: 0 } } });
    await backfillTripLinks();
    const result = await replay(run);
    const fresh = await MigrationRun.findById(run._id);
    const report = await buildReport(fresh, result);
    await MigrationRun.updateOne({ _id: run._id }, { $set: { status: 'review', report, finishedAt: new Date(), progress: { phase: 'done', done: 1, total: 1 } } });
  } catch (error) {
    console.error('[accounting] migration failed:', error);
    await MigrationRun.updateOne({ _id: run._id }, { $set: { status: 'failed', message: error.message, finishedAt: new Date() } });
  } finally {
    inProcess.delete(run.runId);
  }
}

// Starts a dry run in the background; `wait` runs it inline (tests)
async function startRun({ user, config = {}, wait = false } = {}) {
  const { settings } = await require('../config').getConfig();
  if (settings?.migrationDate) throw fail('الترحيل التاريخي اعتُمد مسبقاً؛ لا يمكن تشغيله مرة أخرى.');
  if (await MigrationRun.exists({ status: { $in: ACTIVE } })) throw fail('يوجد تشغيل ترحيل قائم. اعتمده أو ألغِه أولاً.');
  const cutoff = new Date();
  const run = await MigrationRun.create({
    runId: `MIG-${toDay(cutoff)}-${crypto.randomBytes(3).toString('hex')}`,
    status: 'running', cutoff, config, createdBy: user?._id, startedAt: new Date(),
  });
  await setSettings({ migrationGuardDay: toDay(cutoff) });
  if (wait) await execute(run);
  else setImmediate(() => execute(run));
  return MigrationRun.findById(run._id);
}

// Counters go back to the highest number still used, so discarding leaves no gap
async function rebuildCounters() {
  const journals = await Journal.find({}).lean();
  for (const journal of journals) {
    await Counter.deleteMany({ _id: new RegExp(`^JE:${journal.code}(:|$)`) });
    const rows = await JournalEntry.aggregate([
      { $match: { journalId: journal._id } },
      { $group: { _id: { $substr: ['$day', 0, 4] }, numbers: { $push: '$number' } } },
    ]);
    for (const row of rows) {
      const max = Math.max(...row.numbers.map((n) => Number(String(n).split('/').pop()) || 0));
      const key = journal.sequenceResetYearly ? `JE:${journal.code}:${row._id}` : `JE:${journal.code}`;
      const existing = await Counter.findById(key);
      if (!existing || existing.seq < max) await Counter.updateOne({ _id: key }, { $set: { seq: max } }, { upsert: true });
    }
  }
  // Vouchers of entries that no longer exist go with them
  const orphaned = await Voucher.aggregate([
    { $lookup: { from: JournalEntry.collection.name, localField: 'entryId', foreignField: '_id', as: 'entry' } }, { $match: { entry: { $size: 0 } } }, { $project: { _id: 1 } },
  ]);
  if (orphaned.length) await Voucher.deleteMany({ _id: { $in: orphaned.map((v) => v._id) } });
  // Every document numbered by nextDocNumber: one left out would restart at 1 and collide with its
  // own existing numbers ('القيمة موجودة مسبقاً')
  const numbered = [Voucher, docs.SupplierBill, docs.SupplierPayment, docs.SupplierReceipt, docs.TreasuryTransfer, docs.CashCount, docs.FixedAsset, docs.PrepaidExpense, docs.SalaryPayment, docs.EquityTransaction, docs.Netting, docs.YuanPurchase, docs.CustomerRefund, docs.ClaimWriteOff];
  // Document numbers look like BILL/2026/0007
  const highest = new Map();
  for (const Model of numbered) {
    const numbers = await Model.distinct('number', { number: { $type: 'string' } });
    numbers.forEach((number) => {
      const [prefix, year, seq] = String(number).split('/');
      const key = `DOC:${prefix}:${year}`;
      highest.set(key, Math.max(highest.get(key) || 0, Number(seq) || 0));
    });
  }
  await Counter.deleteMany({ _id: /^DOC:/ });
  if (highest.size) await Counter.insertMany([...highest].map(([_id, seq]) => ({ _id, seq })));
}

async function discardRun(runId, { user } = {}) {
  const run = await MigrationRun.findOne({ runId });
  if (!run) throw new ErrorHandler(404, 'التشغيل غير موجود');
  const interrupted = run.status === 'running' && !inProcess.has(runId);
  if (!['review', 'failed'].includes(run.status) && !interrupted) throw fail('لا يمكن إلغاء هذا التشغيل في حالته الحالية');
  const [entries] = await Promise.all([
    JournalEntry.deleteMany({ migrationRunId: runId }),
    docs.SupplierBill.deleteMany({ migrationRunId: runId }),
    docs.SupplierPayment.deleteMany({ migrationRunId: runId }),
    CurrencyRate.deleteMany({ migrationRunId: runId, source: 'derived' }),
  ]);
  await rebuildCounters();
  // With the books empty again no rate is in use, so wrong rates can be corrected before the next run
  if (!(await JournalEntry.exists({}))) await CurrencyRate.updateMany({ isUsed: true }, { $set: { isUsed: false } });
  await setSettings({ migrationGuardDay: null });
  run.status = 'discarded';
  run.message = `أُلغي بواسطة ${user?.firstName || 'المدير'}؛ حُذف ${entries.deletedCount} قيداً`;
  await run.save();
  return run;
}

// Commit: live posting switches on first (new operations are queued from this instant), then the
// replay catches up everything that happened since the dry run started. Both are idempotent, so
// an operation seen by both is posted once.
// Spec 8.1.1: entry numbers without gaps. Dry runs take numbers from the same journals as entries
// made for real, so discarding one leaves holes; at commit every journal is numbered again in date
// order, once, before anything is exported or printed. Two passes (temporary numbers first)
// because numbers are unique. Live posting is paused meanwhile, so no entry takes a number in
// between.
async function renumberJournals() {
  const { settings } = await require('../config').getConfig();
  const wasLive = !!settings?.liveEnabled;
  if (wasLive) await setSettings({ liveEnabled: false });
  try {
    const journals = await Journal.find({}).lean();
    let changed = 0;
    for (const journal of journals) {
      const entries = await JournalEntry.find({ journalId: journal._id }).select('_id day number createdAt').sort({ day: 1, createdAt: 1, _id: 1 }).lean();
      const next = new Map();
      const plan = entries.map((entry) => {
        const year = String(entry.day || '').slice(0, 4);
        const key = journal.sequenceResetYearly ? year : '';
        const seq = (next.get(key) || 0) + 1;
        next.set(key, seq);
        const padded = String(seq).padStart(6, '0');
        return { _id: entry._id, from: entry.number, to: journal.sequenceResetYearly ? `${journal.sequencePrefix}/${year}/${padded}` : `${journal.sequencePrefix}/${padded}` };
      }).filter((row) => row.from !== row.to);
      if (plan.length) {
        await JournalEntry.bulkWrite(plan.map((row) => ({ updateOne: { filter: { _id: row._id }, update: { $set: { number: `TMP:${row._id}` } } } })));
        await JournalEntry.bulkWrite(plan.map((row) => ({ updateOne: { filter: { _id: row._id }, update: { $set: { number: row.to } } } })));
        changed += plan.length;
      }
      await Counter.deleteMany({ _id: new RegExp(`^JE:${journal.code}(:|$)`) });
      for (const [key, seq] of next) {
        await Counter.updateOne({ _id: journal.sequenceResetYearly ? `JE:${journal.code}:${key}` : `JE:${journal.code}` }, { $set: { seq } }, { upsert: true });
      }
    }
    return { changed };
  } finally {
    if (wasLive) await setSettings({ liveEnabled: true });
  }
}

async function commitRun(runId, { user } = {}) {
  const run = await MigrationRun.findOne({ runId });
  if (!run) throw new ErrorHandler(404, 'التشغيل غير موجود');
  if (run.status !== 'review') throw fail('يُعتمد التشغيل بعد انتهائه ومراجعة تقريره فقط');
  run.status = 'committing';
  run.countAt = run.cutoff;
  await run.save();
  const since = run.cutoff;
  try {
    run.cutoff = new Date();
    // cutoffAt: created before it = posted by the migration (dry run + catch-up), after it = live
    await setSettings({ liveEnabled: true, migrationGuardDay: null, cutoffAt: run.cutoff, historyStartDate: toDay(run.historyStart || since), migrationDate: toDay(run.cutoff) });
    // Events recorded before the dry run read the data describe states it already posted. Later
    // ones (an old statement edited during the review, say) stay in the queue and are posted.
    const covered = await markCovered(since);
    const catchUp = await replay(run, { since });
    const numbering = await renumberJournals();
    run.status = 'committed';
    run.committedAt = new Date();
    run.message = `اعتُمد؛ أُضيفت ${catchUp.events} عملية حدثت أثناء المراجعة`;
    run.report = { ...(run.report || {}), catchUp: { events: catchUp.events, walletDifferences: catchUp.walletDifferences.length, coveredEvents: covered }, renumbered: numbering.changed, committedBy: user?._id };
    await run.save();
    // The count day of this run now applies to new entries (config.count)
    invalidateConfig();
    return run;
  } catch (error) {
    run.cutoff = since;
    run.status = 'review';
    run.message = `تعذّر الاعتماد: ${error.message}`;
    await run.save();
    await setSettings({ liveEnabled: false, migrationDate: null, cutoffAt: null, migrationGuardDay: toDay(run.cutoff) });
    await AccountingEvent.updateMany({ status: 'covered', createdAt: { $lte: since } }, { $set: { status: 'pending' } });
    throw error;
  }
}

// Phase 0 style inventory of the data to migrate (spec 14, item 5)
async function inventory() {
  const [oldestStatement, oldestOrder, counts] = await Promise.all([
    UserStatement.findOne({}).sort({ createdAt: 1 }).select('createdAt').lean(),
    Order.findOne({}).sort({ createdAt: 1 }).select('createdAt').lean(),
    Promise.all([
      UserStatement.countDocuments(), Order.countDocuments({ unsureOrder: { $ne: true } }), OrderPaymentHistory.countDocuments({ paymentType: 'cash' }),
      Inventory.countDocuments({ inventoryType: 'inventoryGoods' }), Balance.countDocuments({ balanceType: 'debt' }), Expense.countDocuments(), Income.countDocuments(),
      UserStatement.countDocuments({ calculationType: '+', actionType: { $in: ['cash', 'bank', null] }, office: { $in: [null, ''] } }),
      Order.countDocuments({ isPayment: true, unsureOrder: { $ne: true }, isCanceled: { $ne: true }, 'purchaseItems.0': { $exists: false } }),
      Inventory.countDocuments({ inventoryType: 'inventoryGoods', 'expenses.0': { $exists: false } }),
      Order.countDocuments({ 'paymentList.status.received': true, 'paymentList.deliveredPackages.deliveredInfo.deliveredDate': { $exists: false } }),
    ]),
  ]);
  const lydDays = await UserStatement.aggregate([
    { $match: { currency: 'LYD' } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Africa/Tripoli' } } } },
  ]);
  const rateDays = new Set((await CurrencyRate.find({ currency: 'LYD' }).select('day').lean()).map((r) => r.day));
  const [statements, orders, cashPayments, trips, debts, expenses, incomes, depositsWithoutOffice, purchasesWithoutItems, tripsWithoutExpenses, deliveredWithoutDate] = counts;
  const oldest = [oldestStatement?.createdAt, oldestOrder?.createdAt].filter(Boolean).sort((a, b) => a - b)[0];
  return {
    oldest,
    counts: { statements, orders, cashPayments, trips, debts, expenses, incomes },
    warnings: {
      depositsWithoutOffice, purchasesWithoutItems, tripsWithoutExpenses, deliveredWithoutDate, cashPaymentsWithoutOffice: cashPayments,
      lydDaysWithoutRate: lydDays.filter((d) => !rateDays.has(d._id)).length,
    },
    runs: await MigrationRun.find({}).sort({ createdAt: -1 }).limit(10).select('-report -problems').lean(),
  };
}

// Pre-filled template for "which cash box paid the old costs" (spec 7-ب.3 step 4)
async function costTemplate() {
  const trips = await Inventory.find({ inventoryType: 'inventoryGoods', 'expenses.0': { $exists: true } }).select('voyage expenses').lean();
  const orders = await Order.find({ 'purchaseItems.0': { $exists: true }, unsureOrder: { $ne: true } }).select('orderId purchaseItems').lean();
  const sum = (items, field) => items.reduce((acc, item) => {
    const currency = item.currency || 'USD';
    acc[currency] = (acc[currency] || 0) + Number(item[field] || 0);
    return acc;
  }, {});
  return [
    ...trips.map((t) => ({ kind: 'trip', key: t.voyage, id: t._id, totals: sum(t.expenses, 'amount') })),
    ...orders.map((o) => ({ kind: 'order', key: o.orderId, id: o._id, totals: sum(o.purchaseItems, 'unitPrice') })),
  ];
}

module.exports = { startRun, discardRun, commitRun, inventory, costTemplate, rebuildCounters, renumberJournals };
