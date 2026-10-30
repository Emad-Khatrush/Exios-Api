// Daily work: one place where the accountant reviews the day and works the open backlog, then
// closes the day with a saved report. A day can be closed several times (version 1, 2, ...) while
// the work is not finished. Closing locks nothing: anything changed later on a closed day shows in
// the next report as a change after closing.
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SupplierBill } = require('../models/documents');
const { CashTally, DailyItemReview, DailyClose } = require('../models/review');
const UserStatement = require('../../models/userStatement');
const DeletedStatement = require('../../models/deletedStatement');
const User = require('../../models/user');
const { getConfig } = require('./config');
const { isDay, addDays, today, toDay, dayStart, dayEnd } = require('./dates');
const { getBalance } = require('./carrying');
const { fromMinor } = require('./money');
const { fail, decimalsOf, toCurrencyMinor } = require('./posting/common');
const { logAudit } = require('./audit');

const id = (value) => String(value?._id || value || '');
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const nameOf = (user) => [user?.firstName, user?.lastName].filter(Boolean).join(' ');

// A single operation at or above this amount is shown for review on the day it was entered
const LARGE = { USD: 1000, LYD: 10000 };
const OVERPAID_LABEL = 'دفع زائد على الطلب: مكسب (قرار 119)';
// Scheduled catch-up postings are dated in the past on purpose; they are not "backdated" work
const SCHEDULED = ['DEPRECIATION', 'PREPAID_AMORT', 'YEAR_CLOSE', 'YEAR_CLOSE_SUPP', 'OPENING_CASH'];
// Daily checks the backlog already covers through its own items
const COVERED_CHECKS = ['purchases', 'tripsWithoutCost', 'bankLines', 'suspense', 'unidentifiedOverdue'];

const CATEGORIES = {
  cash: 'عدّ الخزائن', today: 'ملاحظات المراجعة اليومية', unidentified: 'حركات بنك قيد التحديد',
  cost: 'اكتمال التكاليف', duplicate: 'تكرار محتمل', purchase: 'مشتريات غير مرتبطة', bank: 'حركات الكشف',
  refund: 'استردادات', suspense: 'المعلّق', posting: 'تعثر الترحيل', integrity: 'أخطاء الحسابات', checks: 'فحوص يومية',
};

function dayOf(input) {
  const day = input || today();
  if (!isDay(day)) throw fail('التاريخ غير صالح');
  if (day > today()) throw fail('لا يمكن العمل على يوم لم يأتِ بعد');
  return day;
}

// ---- Cash boxes: in, out and the expected closing balance of each box on the day ----

async function cashBoxes(day) {
  const { accountsById, offices } = await getConfig();
  const accounts = [...accountsById.values()].filter((a) => a.isCash && a.isActive && a.cashKind === 'cash');
  const ids = accounts.map((a) => a._id);
  const sum = (match) => JournalEntry.aggregate([
    { $match: { ...match, 'lines.accountId': { $in: ids } } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': { $in: ids } } },
    { $group: { _id: '$lines.accountId', balance: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } },
      in: { $sum: { $cond: [{ $gt: ['$lines.amountCurrency', 0] }, '$lines.amountCurrency', 0] } },
      out: { $sum: { $cond: [{ $lt: ['$lines.amountCurrency', 0] }, { $multiply: ['$lines.amountCurrency', -1] }, 0] } } } },
  ]);
  const [moves, balances, tallies] = await Promise.all([sum({ day }), sum({ day: { $lte: day } }), CashTally.find({ day, accountId: { $in: ids } }).lean()]);
  const moved = new Map(moves.map((r) => [id(r._id), r]));
  const closing = new Map(balances.map((r) => [id(r._id), r.balance]));
  const groups = new Map();
  for (const account of accounts) {
    const move = moved.get(id(account)) || { in: 0, out: 0 };
    const balance = closing.get(id(account)) || 0;
    const tally = tallies.find((t) => id(t.accountId) === id(account));
    if (!balance && !move.in && !move.out && !tally) continue;
    const currency = account.currency || 'USD';
    const office = account.office || 'other';
    if (!groups.has(office)) groups.set(office, { office, name: offices.get(office)?.name || (office === 'other' ? 'بدون مكتب' : office), boxes: [] });
    groups.get(office).boxes.push({
      accountId: account._id, code: account.code, name: account.name, currency, decimals: await decimalsOf(currency), subBox: !!account.subBox,
      opening: balance - move.in + move.out, in: move.in, out: move.out, expected: balance,
      tally: tally && { _id: tally._id, counted: tally.counted, difference: tally.difference, status: tally.status, note: tally.note },
    });
  }
  return [...groups.values()];
}

// ---- The day's operations that need a look (the rest is accepted when the boxes match) ----

async function todayItems(day) {
  const range = { $gte: dayStart(day), $lte: dayEnd(day) };
  const [bills, statements, edited, deleted, backdated, overpaid] = await Promise.all([
    SupplierBill.find({ officeExpense: true, status: 'posted', createdAt: range }).populate('expenseTypeId', 'name').lean(),
    UserStatement.find({ createdAt: range }).populate('user', 'firstName lastName customerId').lean(),
    UserStatement.find({ editHistory: { $elemMatch: { editedAt: range } } }).populate('user', 'firstName lastName customerId').lean(),
    DeletedStatement.find({ deletedAt: range }).populate('user', 'firstName lastName customerId').lean(),
    JournalEntry.find({ createdAt: range, day: { $lt: day }, isHistorical: { $ne: true }, migrationRunId: null, eventType: { $nin: SCHEDULED } })
      .select('number day description eventType createdBy createdAt').sort({ createdAt: 1 }).limit(200).lean(),
    JournalEntry.find({ createdAt: range, 'lines.label': OVERPAID_LABEL }).select('number day description lines createdBy').lean(),
  ]);
  const items = [];
  const add = (item) => items.push({ day, severity: 'warn', ...item });
  const customer = (s) => [nameOf(s.user), s.user?.customerId].filter(Boolean).join(' · ');
  for (const bill of bills) {
    if ((bill.attachments || []).length) continue;
    add({ key: `today:receipt:${bill._id}`, kind: 'receipt', title: 'مصروف مكتب بدون إيصال', office: bill.office, by: bill.createdBy,
      description: `${bill.number || ''} · ${bill.expenseTypeId?.name || ''} ${bill.note ? `· ${bill.note}` : ''}`, amount: bill.total, currency: bill.currency, url: '/accounting/office-expenses' });
  }
  for (const s of statements) {
    const limit = LARGE[s.currency];
    const url = `/user/${id(s.user)}`;
    if (s.actionType === 'compensation') add({ key: `today:comp:${s._id}`, kind: 'compensation', title: 'تعويض لعميل', office: s.office, by: s.createdBy,
      description: `${customer(s)} · ${s.description || ''}`, amount: s.amount, currency: s.currency, url });
    else if (limit && s.amount >= limit && s.calculationType === '+' && ['cash', 'bank'].includes(s.actionType || s.paymentType)) add({ key: `today:bigIn:${s._id}`, kind: 'large',
      title: 'إيداع بمبلغ كبير', office: s.office, by: s.createdBy, description: `${customer(s)} · ${s.description || ''}`, amount: s.amount, currency: s.currency, url });
    else if (limit && s.amount >= limit && s.paymentType === 'withdrawal') add({ key: `today:bigOut:${s._id}`, kind: 'large',
      title: 'سحب نقدي بمبلغ كبير', office: s.office, by: s.createdBy, description: `${customer(s)} · ${s.description || ''}`, amount: s.amount, currency: s.currency, url });
  }
  for (const s of edited) {
    for (const edit of (s.editHistory || []).filter((e) => e.editedAt >= range.$gte && e.editedAt <= range.$lte)) {
      add({ key: `today:edit:${s._id}:${new Date(edit.editedAt).getTime()}`, kind: 'edit', title: 'تعديل كشف محفظة', office: s.office, by: edit.editedBy,
        description: `${customer(s)} · ${s.description || ''}`, amount: s.amount, currency: s.currency, url: `/user/${id(s.user)}` });
    }
  }
  for (const d of deleted) {
    add({ key: `today:del:${d._id}`, kind: 'delete', title: 'حذف كشف محفظة', office: d.statement?.office, by: d.deletedBy,
      description: `${customer(d)} · ${d.statement?.description || ''}`, amount: d.statement?.amount, currency: d.currency, url: '/deleted-payments' });
  }
  for (const e of backdated) {
    add({ key: `today:back:${e._id}`, kind: 'backdated', title: 'عملية بتاريخ سابق', by: e.createdBy,
      description: `${e.number} · بتاريخ ${e.day} · ${e.description || ''}`, url: `/accounting/entries/${e._id}` });
  }
  for (const e of overpaid) {
    const usd = e.lines.filter((l) => l.label === OVERPAID_LABEL).reduce((s, l) => s + (l.credit || 0), 0);
    add({ key: `today:overpaid:${e._id}`, kind: 'overpaid', title: 'دفع زائد سُجّل مكسباً', by: e.createdBy,
      description: `${e.number} · ${e.description || ''}`, amount: usd / 100, currency: 'USD', url: `/accounting/entries/${e._id}` });
  }
  const users = new Map((await User.find({ _id: { $in: items.map((i) => i.by).filter(Boolean) } }).select('firstName lastName').lean()).map((u) => [id(u), nameOf(u)]));
  const reviews = new Map((await DailyItemReview.find({ key: { $in: items.map((i) => i.key) } }).populate('reviewedBy', 'firstName lastName').lean()).map((r) => [r.key, r]));
  return items.map((item) => {
    const review = reviews.get(item.key);
    return { ...item, by: users.get(id(item.by)) || '', state: review ? review.state : 'pending', note: review?.note || '', reviewedBy: review && nameOf(review.reviewedBy) };
  });
}

// ---- Entries added later on a day that was already closed ----

async function changesAfterClose({ since } = {}) {
  const closes = await DailyClose.aggregate([{ $match: { day: { $gte: addDays(today(), -120) } } },
    { $group: { _id: '$day', at: { $max: '$createdAt' } } }]);
  if (!closes.length) return [];
  const closedAt = new Map(closes.map((c) => [c._id, c.at]));
  const earliest = new Date(Math.min(...closes.map((c) => c.at.getTime()), since ? since.getTime() : Infinity));
  const after = since && since > earliest ? since : earliest;
  const entries = await JournalEntry.find({ day: { $in: [...closedAt.keys()] }, createdAt: { $gt: after } })
    .select('number day description eventType createdBy createdAt').sort({ createdAt: 1 }).limit(500).lean();
  const found = entries.filter((e) => e.createdAt > closedAt.get(e.day) && toDay(e.createdAt) > e.day && (!since || e.createdAt > since));
  const users = new Map((await User.find({ _id: { $in: found.map((e) => e.createdBy).filter(Boolean) } }).select('firstName lastName').lean()).map((u) => [id(u), nameOf(u)]));
  return found.slice(0, 200).map((e) => ({ _id: e._id, number: e.number, day: e.day, description: e.description, eventType: e.eventType,
    createdAt: e.createdAt, by: users.get(id(e.createdBy)) || '', url: `/accounting/entries/${e._id}` }));
}

async function today_(input = {}) {
  const day = dayOf(input.day);
  const [offices, items, closes, last] = await Promise.all([
    cashBoxes(day), todayItems(day),
    DailyClose.find({ day }).sort({ version: -1 }).populate('closedBy', 'firstName lastName').select('day version note closedBy createdAt').lean(),
    DailyClose.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);
  const boxes = offices.flatMap((o) => o.boxes);
  return {
    day, offices, items, closes: closes.map((c) => ({ ...c, closedBy: nameOf(c.closedBy) })),
    changes: await changesAfterClose({ since: last?.createdAt }),
    summary: {
      boxes: boxes.length, counted: boxes.filter((b) => b.tally).length, matched: boxes.filter((b) => b.tally?.status === 'matched').length,
      differences: boxes.filter((b) => b.tally?.status === 'difference').length,
      items: items.length, pending: items.filter((i) => i.state === 'pending').length, issues: items.filter((i) => i.state === 'issue').length,
    },
  };
}

// ---- Backlog: every open item from the review list, daily checks, unidentified lines and cash counts ----

async function backlog(input = {}) {
  const review = require('./accountingReview');
  const exceptions = require('./reports/exceptions');
  const [queue, stored, unidentified, tallies, issues] = await Promise.all([
    review.queue({ storedChecks: true }),
    exceptions.latest(),
    require('./posting/unidentified').list({ state: 'open' }),
    CashTally.find({ status: 'difference' }).populate('accountId', 'name code currency').sort({ day: 1 }).lean(),
    DailyItemReview.find({ state: 'issue' }).populate('reviewedBy', 'firstName lastName').sort({ day: 1 }).lean(),
  ]);
  const items = queue.allItems.map((i) => ({ ...i, source: 'review' }));
  for (const check of (stored?.results || []).filter((c) => c.count && c.severity !== 'error' && !COVERED_CHECKS.includes(c.key))) {
    items.push({ key: `check:${check.key}`, source: 'check', category: 'checks', severity: check.severity === 'info' ? 'info' : 'warn', blocking: false, state: 'open',
      title: check.title, description: `${check.count} حالة${check.hint ? ` · ${check.hint}` : ''}`, examples: (check.items || []).slice(0, 5).map((x) => x.label),
      url: check.link || '/accounting/exceptions' });
  }
  for (const line of unidentified.results) {
    items.push({ key: `unidentified:${line._id}`, source: 'unidentified', category: 'unidentified', severity: line.overdue ? 'error' : 'warn', blocking: line.overdue, state: 'open',
      day: line.day, title: line.overdue ? 'حركة بنك قيد التحديد تجاوزت مدة الانتظار' : 'حركة بنك قيد التحديد',
      description: `${line.bank?.name || ''} · ${line.description || ''} · تنتهي المهلة ${line.dueDay}`, amount: line.amount, currency: line.bank?.currency, url: '/accounting/unidentified' });
  }
  for (const tally of tallies) {
    const currency = tally.accountId?.currency || 'USD';
    const decimals = await decimalsOf(currency);
    items.push({ key: `tally:${tally._id}`, source: 'tally', category: 'cash', severity: 'error', blocking: true, state: 'open', day: tally.day, tallyId: tally._id,
      title: tally.difference < 0 ? 'عجز في عدّ الخزينة' : 'زيادة في عدّ الخزينة', amount: fromMinor(tally.difference, decimals), currency,
      description: `${tally.accountId?.name || ''} · المتوقع ${fromMinor(tally.expected, decimals)} · المعدود ${fromMinor(tally.counted, decimals)}${tally.note ? ` · ${tally.note}` : ''}`,
      url: `/accounting/accounts/${id(tally.accountId)}` });
  }
  for (const issue of issues) {
    items.push({ key: `issue:${issue.key}`, reviewKey: issue.key, source: 'issue', category: 'today', severity: 'warn', blocking: false, state: 'open', day: issue.day,
      title: issue.title || 'ملاحظة من المراجعة اليومية', description: `${issue.note}${issue.reviewedBy ? ` · ${nameOf(issue.reviewedBy)}` : ''}`, url: issue.url });
  }
  const now = today();
  items.forEach((i) => { i.age = i.day ? Math.max(0, Math.round((Date.parse(now) - Date.parse(i.day)) / 86400000)) : null; });
  const rank = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => Number(b.blocking) - Number(a.blocking) || rank[a.severity] - rank[b.severity] || (a.day || '9').localeCompare(b.day || '9'));
  const byCategory = {};
  items.forEach((i) => { byCategory[i.category] = (byCategory[i.category] || 0) + 1; });
  const q = String(input.q || '').trim().toLowerCase();
  const visible = items.filter((i) => (!input.category || input.category === 'all' || i.category === input.category)
    && (!input.state || input.state === 'all' || i.state === input.state)
    && (!q || [i.title, i.description].join(' ').toLowerCase().includes(q)));
  return {
    results: visible, categories: CATEGORIES, checksRanAt: stored?.ranAt || null, period: queue.period,
    summary: { total: items.length, blocking: items.filter((i) => i.blocking).length, errors: items.filter((i) => i.severity === 'error').length,
      deferred: items.filter((i) => i.state === 'deferred').length, byCategory },
    all: items,
  };
}

// ---- Actions ----

async function saveTally(input, { session, req }) {
  const day = dayOf(input.day);
  const account = (await getConfig()).accountsById.get(id(input.accountId));
  if (!account?.isCash || account.cashKind !== 'cash') throw fail('اختر خزينة نقدية');
  if (input.counted === '' || input.counted === null || !Number.isFinite(Number(input.counted))) throw fail('اكتب المبلغ المعدود');
  const existing = await CashTally.findOne({ day, accountId: account._id }).session(session);
  if (existing && ['explained', 'adopted'].includes(existing.status)) throw fail('عُولج فرق هذا العدّ؛ لا يُعاد العدّ لنفس اليوم');
  const currency = account.currency || 'USD';
  const counted = (Number(input.counted) < 0 ? -1 : 1) * await toCurrencyMinor(Math.abs(Number(input.counted)), currency);
  const { foreign: expected } = await getBalance(account._id, { session, upToDay: day });
  const difference = counted - expected;
  const doc = await CashTally.findOneAndUpdate({ day, accountId: account._id }, { $set: { expected, counted, difference, note: String(input.note || '').trim(),
    status: difference === 0 ? 'matched' : 'difference', countedBy: req?.user?._id } }, { upsert: true, new: true, session });
  await logAudit({ req, action: 'daily.tally', model: 'AccountingCashTally', docId: doc._id, after: doc.toObject() }, session);
  return doc;
}

// The difference has a cause (an operation entered later, a mistake in counting): no entry
async function explainTally(tallyId, input, { session, req }) {
  const tally = await CashTally.findById(tallyId).session(session);
  if (!tally || tally.status !== 'difference') throw fail('هذا العدّ ليس فيه فرق مفتوح');
  const note = String(input.note || '').trim();
  if (note.length < 10) throw fail('اكتب سبب الفرق بوضوح (10 أحرف على الأقل)');
  Object.assign(tally, { status: 'explained', note: [tally.note, note].filter(Boolean).join(' · '), resolvedBy: req?.user?._id, resolvedAt: new Date() });
  await tally.save({ session });
  await logAudit({ req, action: 'daily.tally.explain', model: 'AccountingCashTally', docId: tally._id, after: { note } }, session);
  return tally;
}

// No explanation found: the difference becomes a real count today, posted as shortage or overage
async function adoptTally(tallyId, input, { session, req }) {
  const tally = await CashTally.findById(tallyId).session(session);
  if (!tally || tally.status !== 'difference') throw fail('هذا العدّ ليس فيه فرق مفتوح');
  const account = (await getConfig()).accountsById.get(id(tally.accountId));
  const currency = account.currency || 'USD';
  const { foreign: current } = await getBalance(account._id, { session });
  const countedAmount = fromMinor(current + tally.difference, await decimalsOf(currency));
  const count = await require('./posting/treasury').createCashCount({ day: today(), accountId: account._id, countedAmount,
    note: `فرق عدّ يوم ${tally.day}${input.note ? ` · ${input.note}` : ''}`, idempotencyKey: `daily-tally:${tally._id}` }, { session, req });
  Object.assign(tally, { status: 'adopted', cashCountId: count._id, resolvedBy: req?.user?._id, resolvedAt: new Date() });
  await tally.save({ session });
  return { tally, cashCountId: count._id };
}

async function reviewItem(input, { session, req }) {
  if (!/^today:/.test(String(input.key || ''))) throw fail('البند غير معروف');
  const day = dayOf(input.day);
  const state = input.state;
  const note = String(input.note || '').trim();
  if (input.state === 'pending') {
    await DailyItemReview.deleteOne({ key: input.key }).session(session);
    return { success: true };
  }
  if (!['ok', 'issue'].includes(state)) throw fail('الحالة غير صالحة');
  if (state === 'issue' && note.length < 5) throw fail('اكتب ما المشكلة');
  const resolving = state === 'ok' && await DailyItemReview.exists({ key: input.key, state: 'issue' }).session(session);
  await DailyItemReview.updateOne({ key: input.key }, { $set: { day, state, note, title: input.title, url: input.url,
    ...(resolving ? { resolvedBy: req?.user?._id, resolvedAt: new Date() } : { reviewedBy: req?.user?._id }) } }, { upsert: true, session });
  await logAudit({ req, action: 'daily.item', model: 'AccountingDailyItemReview', after: { key: input.key, state, note } }, session);
  return { success: true };
}

// ---- Closing the day ----

async function closeDay(input, { req }) {
  const day = dayOf(input.day);
  const previous = await DailyClose.findOne({}).sort({ createdAt: -1 }).lean();
  const [data, work] = await Promise.all([today_({ day }), backlog({})]);
  const keys = new Set(work.all.map((i) => i.key));
  const before = previous?.report?.backlog?.items || [];
  const beforeKeys = new Set(before.map((i) => i.key));
  const resolved = before.filter((i) => !keys.has(i.key));
  const added = work.all.filter((i) => !beforeKeys.has(i.key));
  const report = {
    day, closedAt: new Date(), offices: data.offices, items: data.items, summary: data.summary, changes: data.changes,
    backlog: {
      ...work.summary, sincePrevious: previous ? { at: previous.createdAt, day: previous.day, version: previous.version } : null,
      resolvedCount: resolved.length, addedCount: added.length, resolved: resolved.slice(0, 100), added: added.slice(0, 100).map(({ key, title, category }) => ({ key, title, category })),
      items: work.all.slice(0, 3000).map((i) => ({ key: i.key, title: i.title, category: i.category, severity: i.severity, blocking: i.blocking, description: i.description, day: i.day })),
    },
  };
  const version = (await DailyClose.countDocuments({ day })) + 1;
  const doc = await DailyClose.create({ day, version, note: String(input.note || '').trim(), closedBy: req?.user?._id, report });
  await logAudit({ req, action: 'daily.close', model: 'AccountingDailyClose', docId: doc._id, after: { day, version } });
  return { _id: doc._id, day, version };
}

async function listCloses(input = {}) {
  const query = {};
  if (input.from || input.to) query.day = { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) };
  const rows = await DailyClose.find(query).sort({ day: -1, version: -1 }).limit(200).populate('closedBy', 'firstName lastName')
    .select('day version note closedBy createdAt report.summary report.backlog.total report.backlog.blocking report.backlog.resolvedCount report.backlog.addedCount report.changes').lean();
  return { results: rows.map((r) => ({ _id: r._id, day: r.day, version: r.version, note: r.note, closedBy: nameOf(r.closedBy), createdAt: r.createdAt,
    summary: r.report?.summary, backlog: r.report?.backlog, changes: (r.report?.changes || []).length })) };
}

async function getClose(closeId) {
  if (!mongoose.isValidObjectId(closeId)) throw fail('التقرير غير صالح');
  const doc = await DailyClose.findById(oid(closeId)).populate('closedBy', 'firstName lastName').lean();
  if (!doc) throw fail('التقرير غير موجود');
  return { ...doc, closedBy: nameOf(doc.closedBy) };
}

module.exports = { today: today_, backlog, saveTally, explainTally, adoptTally, reviewItem, closeDay, listCloses, getClose, CATEGORIES };
