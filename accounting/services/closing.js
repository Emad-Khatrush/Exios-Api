// Closing the books (spec 11, E33): a month is closed by moving the lock date after a checklist;
// a year is closed by one entry that moves every income and expense balance into retained earnings.
const moment = require('moment-timezone');
const ErrorHandler = require('../../utils/errorHandler');
const { JournalEntry, AccountingSettings, AccountingEvent } = require('../models');
const { FixedAsset, PrepaidExpense, CashCount, BankStatementLine } = require('../models/documents');
const { lockPeriod } = require('./periodLock');
const { getConfig, invalidateConfig } = require('./config');
const { resolveAccount } = require('./roles');
const { postEntry, reverseEntry } = require('./ledger');
const { accountTotals } = require('./balances');
const { logAudit } = require('./audit');
const { TZ, today, monthOf } = require('./dates');
const { monthsBetween, monthEnd } = require('./posting/schedules');
const { runChecks } = require('./reports/exceptions');
const { incomeStatement } = require('./reports/statements');

const MONTH = /^\d{4}-\d{2}$/;
const fail = (message) => new ErrorHandler(400, message);

// The cached settings are refreshed by the caller once its transaction has committed
// (refreshConfig), so nobody reads the old lock date back into the cache in between
async function setLockDate(day, session) {
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { lockDate: day } }, { session });
}
const refreshConfig = () => invalidateConfig();

// What should be done before a month is locked. `blocking` items stop the close; the others are
// shown for the accountant to decide.
async function monthChecklist(month, { session } = {}) {
  if (!MONTH.test(month)) throw fail('الشهر غير صالح');
  const { accountsById } = await getConfig();
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session || null).lean();
  const end = monthEnd(month);
  const start = `${month}-01`;

  const assets = await FixedAsset.find({ status: 'posted', assetStatus: 'active', purchaseDay: { $lte: end } }).select('name purchaseDay depreciationPosted').lean();
  const missingDepreciation = assets.filter((asset) => {
    const done = new Set(asset.depreciationPosted.map((p) => p.month));
    return monthsBetween(monthOf(asset.purchaseDay), month).some((m) => !done.has(m));
  });
  const prepaid = await PrepaidExpense.find({ status: 'posted', startMonth: { $lte: month } }).select('description startMonth months amortizationPosted').lean();
  const missingPrepaid = prepaid.filter((schedule) => {
    const done = new Set(schedule.amortizationPosted.map((p) => p.month));
    return monthsBetween(schedule.startMonth, month).slice(0, schedule.months).some((m) => !done.has(m));
  });

  const cash = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup && a.isActive);
  const totals = await accountTotals({ to: end, accountIds: cash.map((a) => a._id) });
  const counted = new Set((await CashCount.distinct('accountId', { status: 'posted', day: { $gte: start, $lte: end } })).map(String));
  const uncounted = cash.filter((a) => (totals.get(String(a._id))?.closingUsd || 0) !== 0 && !counted.has(String(a._id)));

  const [unmatchedBank, failedEvents, checks] = await Promise.all([
    BankStatementLine.countDocuments({ lineStatus: 'unmatched', day: { $lte: end } }),
    AccountingEvent.countDocuments({ status: { $in: ['failed', 'pending'] } }).session(session || null),
    runChecks({ only: ['balanced', 'wallets', 'cashBoxes', 'unrecognized', 'roles'] }),
  ]);
  const statement = await incomeStatement({ from: start, to: end });

  const items = [
    { key: 'ended', title: 'الشهر انتهى', ok: end < today(), blocking: true, detail: end < today() ? null : `ينتهي ${end}` },
    { key: 'depreciation', title: 'الإهلاك مُرحَّل حتى هذا الشهر', ok: !missingDepreciation.length, blocking: true, detail: missingDepreciation.map((a) => a.name).slice(0, 10).join('، ') || null, link: '/accounting/assets' },
    { key: 'prepaid', title: 'أقساط المصروفات المقدمة مُرحَّلة', ok: !missingPrepaid.length, blocking: true, detail: missingPrepaid.map((s) => s.description).slice(0, 10).join('، ') || null, link: '/accounting/assets' },
    { key: 'events', title: 'كل عمليات المنظومة مُرحَّلة', ok: !failedEvents, blocking: true, detail: failedEvents ? `${failedEvents} عملية تنتظر أو فشلت` : null, link: '/accounting/settings?tab=live' },
    { key: 'checks', title: 'لا أخطاء في المطابقة', ok: !checks.errorCount, blocking: false, detail: checks.results.filter((r) => r.count && r.severity === 'error').map((r) => `${r.title} (${r.count})`).join(' · ') || null, link: '/accounting/exceptions' },
    { key: 'cashCounts', title: 'كل الخزائن مجرودة في هذا الشهر', ok: !uncounted.length, blocking: false, detail: uncounted.map((a) => a.name).slice(0, 10).join('، ') || null, link: '/accounting/treasury' },
    { key: 'bank', title: 'كشوف البنوك مطابقة', ok: !unmatchedBank, blocking: false, detail: unmatchedBank ? `${unmatchedBank} سطراً غير مطابق` : null, link: '/accounting/bank' },
  ];
  return {
    month, end, lockDate: settings.lockDate, alreadyLocked: !!settings.lockDate && settings.lockDate >= end, items,
    canClose: items.filter((i) => i.blocking).every((i) => i.ok),
    netProfit: statement.summary.netProfit.total, revenue: statement.summary.revenue.total,
  };
}

async function closeMonth(month, { session, req }) {
  await lockPeriod(session);
  const checklist = await monthChecklist(month, { session });
  if (checklist.alreadyLocked) throw fail(`الفترة مقفلة مسبقاً حتى ${checklist.lockDate}`);
  if (!checklist.canClose) throw fail(`لا يمكن الإقفال: ${checklist.items.filter((i) => i.blocking && !i.ok).map((i) => i.title).join('، ')}`);
  await setLockDate(checklist.end, session);
  await logAudit({ req, action: 'close.month', model: 'AccountingSettings', before: { lockDate: checklist.lockDate }, after: { lockDate: checklist.end, month } }, session);
  return { lockDate: checklist.end };
}

// The fiscal year named `year` ends in that calendar year
async function fiscalYear(year) {
  const { settings } = await getConfig();
  const startMonth = settings.fiscalYearStartMonth || 1;
  if (!/^\d{4}$/.test(String(year))) throw fail('السنة غير صالحة');
  // Starting in January the year ends on 31 December; otherwise on the day before the start month
  const firstOfNext = startMonth === 1 ? `${Number(year) + 1}-01-01` : `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const end = moment.tz(firstOfNext, 'YYYY-MM-DD', TZ).subtract(1, 'day');
  const start = moment.tz(firstOfNext, 'YYYY-MM-DD', TZ).subtract(1, 'year');
  return { start: start.format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') };
}

// Balances of every income and expense account (and partner withdrawals) at the year end, per
// office, so each office's result is closed too
async function closingBalances(end, { session } = {}) {
  const { accountsById, settings } = await getConfig();
  const withdrawals = await resolveAccount('partner_withdrawals');
  const ids = [...accountsById.values()].filter((a) => !a.isGroup && (['income', 'expense'].includes(a.type) || String(a._id) === String(withdrawals._id))).map((a) => a._id);
  const rows = await JournalEntry.aggregate([
    { $match: { day: { $lte: end }, 'lines.accountId': { $in: ids } } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': { $in: ids } } },
    { $group: { _id: { accountId: '$lines.accountId', office: { $ifNull: ['$lines.office', null] } }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    { $match: { net: { $ne: 0 } } },
  ]).session(session || null);
  return rows.map((row) => {
    const account = accountsById.get(String(row._id.accountId));
    const needsOffice = (account.requires || []).includes('office');
    return { account, office: row._id.office || (needsOffice ? settings.defaultOffice : undefined), net: row.net, isWithdrawal: String(account._id) === String(withdrawals._id) };
  });
}

async function yearStatus(year, { session } = {}) {
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session || null).lean();
  const { start, end } = await fiscalYear(year);
  const entry = await JournalEntry.findOne({ eventKey: new RegExp(`^YEAR_CLOSE:${year}(:|$)`), status: 'posted' }).select('number day totalDebit').session(session || null).lean();
  const balances = await closingBalances(end, { session });
  const profit = -balances.filter((b) => !b.isWithdrawal).reduce((sum, b) => sum + b.net, 0);
  const withdrawals = balances.filter((b) => b.isWithdrawal).reduce((sum, b) => sum + b.net, 0);
  return { year, start, end, ended: end < today(), closed: !!entry, entry, lockDate: settings.lockDate, profit, withdrawals, toRetained: profit - withdrawals, accounts: balances.length };
}

// E33: one entry on the last day of the year zeroes every income and expense account (and
// partner withdrawals) into retained earnings, then the year is locked. Balances are cumulative,
// so an earlier year that was never closed is closed with it.
async function closeYear(year, { session, req }) {
  await lockPeriod(session);
  const status = await yearStatus(year, { session });
  if (!status.ended) throw fail(`السنة المالية لم تنتهِ بعد (تنتهي ${status.end})`);
  if (status.closed) throw fail(`السنة ${year} مقفلة مسبقاً بالقيد ${status.entry.number}`);
  if (await AccountingEvent.exists({ status: { $in: ['pending', 'failed'] } }).session(session)) throw fail('Accounting operations must be posted before closing the year');
  const balances = await closingBalances(status.end, { session });
  if (!balances.length) throw fail('لا توجد أرصدة إيرادات أو مصروفات لإقفالها');

  const retained = await resolveAccount('retained_earnings');
  const lines = balances.map((b) => ({
    accountId: b.account._id, [b.net > 0 ? 'credit' : 'debit']: Math.abs(b.net), ...(b.office && { office: b.office }), label: `إقفال ${year}`,
  }));
  const total = balances.reduce((sum, b) => sum + b.net, 0);
  if (total !== 0) lines.push({ accountId: retained._id, [total > 0 ? 'debit' : 'credit']: Math.abs(total), label: `نتيجة السنة ${year} بعد المسحوبات` });

  const attempt = await JournalEntry.countDocuments({ eventKey: new RegExp(`^YEAR_CLOSE:${year}(:|$)`) }).session(session);
  const entry = await postEntry({
    eventType: 'YEAR_CLOSE', eventKey: attempt ? `YEAR_CLOSE:${year}:${attempt}` : `YEAR_CLOSE:${year}`, date: status.end,
    description: `إقفال السنة المالية ${year}: ترحيل الإيرادات والمصروفات والمسحوبات إلى الأرباح المحتجزة`,
    source: { model: 'AccountingAccount', id: retained._id }, lines,
  }, { session, user: req?.user, onLocked: 'allow' });

  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session).lean();
  if (!settings.lockDate || settings.lockDate < status.end) await setLockDate(status.end, session);
  await logAudit({ req, action: 'close.year', model: 'AccountingJournalEntry', docId: entry._id, after: { year, profit: status.profit, withdrawals: status.withdrawals, lockDate: status.end } }, session);
  return { ...status, entry, closed: true };
}

// Undoing a year close (spec 11): the closing entry is reversed on the same day and the lock
// moves back to the day before the year end, so corrections can be posted and the year closed again
async function reopenYear(year, { session, req, reason }) {
  if (!String(reason || '').trim()) throw fail('سبب إعادة فتح السنة مطلوب');
  const status = await yearStatus(year);
  if (!status.closed) throw fail(`السنة ${year} غير مقفلة`);
  const previousLock = moment.tz(status.start, 'YYYY-MM-DD', TZ).subtract(1, 'day').format('YYYY-MM-DD');
  const reversal = await reverseEntry(status.entry._id, { session, user: req?.user, reason, eventKey: `YEAR_REOPEN:${status.entry._id}`, eventType: 'YEAR_CLOSE', onLocked: 'allow' });
  await setLockDate(previousLock, session);
  await logAudit({ req, action: 'close.reopenYear', model: 'AccountingJournalEntry', docId: status.entry._id, after: { year, reason, lockDate: previousLock } }, session);
  return { reversal, lockDate: previousLock };
}

module.exports = { monthChecklist, closeMonth, yearStatus, closeYear, reopenYear, fiscalYear, refreshConfig };
