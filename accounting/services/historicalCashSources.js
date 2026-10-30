// Live references only: no copying or posting normal financial documents.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { BankStatementLine, SupplierBill } = require('../models/documents');
const { HistoricalCashBatch: Batch, HistoricalCashMutex: Mutex, HistoricalCashSourceReview: Review } = require('../models/historicalCash');
const { getConfig } = require('./config');
const { isDay } = require('./dates');
const { logAudit } = require('./audit');
const ErrorHandler = require('../../utils/errorHandler');
const id = v => String(v?._id || v || '');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (message, code = 400) => new ErrorHandler(code, message);
const LIMIT = 10000;
const OPENINGS = ['OPENING', 'OPENING_CASH', 'CASHCOUNT', 'YEAR_CLOSE'];
const inRange = (day, q) => day >= q.from && day <= q.to;
function category(type, net, cashCount) {
  if (cashCount > 1 && type === 'TRANSFER') return 'transfer';
  if (['DEPOSIT', 'CASH_PAYMENT'].includes(type)) return 'customer_receipt';
  if (['WITHDRAWAL', 'REFUND', 'CASH_REFUND'].includes(type)) return 'customer_refund';
  if (['BILL', 'BILL_EDIT', 'VENDOR_PAYMENT', 'ALIPAY_PAYMENT'].includes(type)) return 'supplier_payment';
  if (['VENDOR_RECEIPT'].includes(type)) return 'supplier_refund';
  if (['SALARY', 'COMMISSION'].includes(type)) return 'operating';
  if (['CAPITAL_IN', 'CAPITAL_OUT', 'EQUITY', 'LOAN', 'LOAN_PAYMENT'].includes(type)) return 'financing';
  return 'unknown';
}
async function collect(input, { session } = {}) {
  const q = { ...input, from: input.from || '2026-01-01', to: input.to || '2026-04-03' };
  if (!isDay(q.from) || !isDay(q.to) || q.from > q.to) throw fail('اختر فترة مراجعة صحيحة.');
  if (q.accountId && !mongoose.isValidObjectId(q.accountId)) throw fail('حساب غير صالح.');
  const config = await getConfig();
  const accounts = [...config.accountsById.values()].filter(a => a.isCash && !a.isGroup && a.type === 'asset' &&
    (!q.accountId || id(a) === q.accountId) && (!q.currency || (a.currency || 'USD') === q.currency));
  const accountMap = new Map(accounts.map(a => [id(a), a]));
  const accountIds = accounts.map(a => a._id), range = { $gte: q.from, $lte: q.to };
  const [entries, banks, bills] = await Promise.all([
    JournalEntry.find({ status: 'posted', reversalOf: null, eventType: { $nin: OPENINGS },
      $or: [{ day: range }, { originalDay: range }], 'lines.accountId': { $in: accountIds } })
      .select('number day originalDay description eventType source lines updatedAt').limit(LIMIT + 1).session(session || null).lean(),
    BankStatementLine.find({ accountId: { $in: accountIds }, day: range, lineStatus: { $ne: 'ignored' } })
      .select('accountId day description reference amount lineStatus entryId matchedEntryIds billId movementKind updatedAt')
      .limit(LIMIT + 1).session(session || null).lean(),
    SupplierBill.find({ day: range, status: { $ne: 'canceled' } }).select('number day currency total totalUsd status lines paidImmediatelyFrom entryId officeExpense isQuickExpense updatedAt')
      .limit(LIMIT + 1).session(session || null).lean(),
  ]);
  if ([entries, banks, bills].some(rows => rows.length > LIMIT)) throw fail('الفترة كبيرة للمراجعة الموحدة. اختر شهرًا أو حسابًا محددًا؛ لم تُعرض إجماليات جزئية.');
  const make = (account, values) => {
    const currency = account.currency || 'USD';
    const office = account.office || values.office || config.settings?.defaultOffice || '';
    return { accountId: id(account), accountName: account.name, accountCode: account.code, office,
      officeName: config.offices.get(office)?.name || office, currency, decimals: config.currencies.get(currency)?.decimals ?? 2, ...values };
  };
  const ledger = [];
  for (const entry of entries) {
    const day = entry.originalDay || entry.day;
    if (!inRange(day, q)) continue;
    const allCash = new Set(entry.lines.filter(l => config.accountsById.get(id(l.accountId))?.isCash && config.accountsById.get(id(l.accountId))?.type === 'asset').map(l => id(l.accountId)));
    for (const account of accounts) {
      const lines = entry.lines.filter(l => id(l.accountId) === id(account));
      if (!lines.length) continue;
      const net = lines.reduce((s, l) => s + ((account.currency || 'USD') === 'USD' ? (l.debit || 0) - (l.credit || 0) : Number(l.amountCurrency || 0)), 0);
      if (!net) continue;
      ledger.push(make(account, { key: `JE:${entry._id}:${account._id}`, sourceModel: 'JournalEntry', sourceId: id(entry), number: entry.number, day,
        description: entry.description || lines.map(l => l.label).filter(Boolean).join(' · '), net, amountMinor: Math.abs(net), direction: net > 0 ? 'in' : 'out',
        category: category(entry.eventType, net, allCash.size), cash: true, contributes: true,
        url: `/accounting/entries/${entry._id}`, entryIds: [id(entry)], fingerprint: hash([entry, id(account)]) }));
    }
  }
  const bankRows = banks.filter(b => b.amount).map(b => make(accountMap.get(id(b.accountId)), {
    key: `BANK:${b._id}`, sourceModel: 'BankStatementLine', sourceId: id(b), number: b.reference || 'سطر كشف بنك', day: b.day, description: b.description,
    net: b.amount, amountMinor: Math.abs(b.amount), direction: b.amount > 0 ? 'in' : 'out',
    category: b.movementKind === 'purchase' || b.billId ? 'supplier_payment' : b.movementKind === 'purchase_refund' ? 'supplier_refund' : 'unknown',
    cash: true, contributes: true, lineStatus: b.lineStatus,
    entryIds: [...new Set([id(b.entryId), ...(b.matchedEntryIds || []).map(id)].filter(Boolean))],
    url: `/accounting/bank?accountId=${b.accountId}&lineId=${b._id}`, fingerprint: hash(b),
  }));
  // A bank may match several entries and vice versa. Compare connected groups per
  // cash account, not entire journals (which might contain the other transfer leg).
  const parent = new Map(), find = k => { if (!parent.has(k)) parent.set(k, k); if (parent.get(k) !== k) parent.set(k, find(parent.get(k))); return parent.get(k); };
  const union = (a, b) => parent.set(find(a), find(b));
  const ledgerMap = new Map(ledger.map(r => [r.key, r]));
  for (const row of bankRows) {
    find(row.key);
    for (const entryId of row.entryIds) { const key = `JE:${entryId}:${row.accountId}`; if (ledgerMap.has(key)) union(row.key, key); }
  }
  const components = new Map();
  for (const row of [...bankRows, ...ledger]) {
    const root = find(row.key); if (!components.has(root)) components.set(root, []); components.get(root).push(row);
  }
  const rows = [];
  for (const members of components.values()) {
    const b = members.filter(r => r.sourceModel === 'BankStatementLine'), j = members.filter(r => r.sourceModel === 'JournalEntry');
    if (b.length && j.length) {
      const bankNet = b.reduce((s, r) => s + r.net, 0), ledgerNet = j.reduce((s, r) => s + r.net, 0);
      if (bankNet === ledgerNet) {
        for (const row of b) {
          const inferred = [...new Set(j.map(r => r.category))];
          if (row.category === 'unknown' && inferred.length === 1) row.category = inferred[0];
          row.relatedEntries = j.map(r => ({ number: r.number, url: r.url }));
          row.fingerprint = hash([row.fingerprint, j.map(r => r.fingerprint).sort()]);
          rows.push(row);
        }
      } else {
        for (const row of [...b, ...j]) {
          row.warning = 'مجموع سطور البنك المرتبطة لا يساوي حركة الدفاتر. صحح المطابقة من المصدر قبل اعتماد المراجعة.';
          if (row.sourceModel === 'BankStatementLine') row.contributes = false;
          rows.push(row);
        }
      }
    } else rows.push(...members);
  }
  // Unpaid cost documents still appear for review, but never as a second cash outflow.
  for (const bill of bills) {
    const offices = [...new Set((bill.lines || []).map(l => l.office).filter(Boolean))];
    if (q.office && !offices.includes(q.office)) continue;
    if (q.accountId || (q.currency && bill.currency !== q.currency)) continue;
    const decimals = config.currencies.get(bill.currency)?.decimals ?? 2;
    rows.push({ key: `BILL:${bill._id}`, sourceModel: 'SupplierBill', sourceId: id(bill), number: bill.number, day: bill.day,
      office: offices.length === 1 ? offices[0] : '', officeName: offices.map(o => config.offices.get(o)?.name || o).join('، '),
      currency: bill.currency, decimals, amountMinor: Math.round(bill.total * 10 ** decimals), direction: 'out', category: 'supplier_payment',
      description: (bill.lines || []).map(l => l.description).filter(Boolean).join(' · '), cash: false, contributes: false,
      url: `/accounting/bills/${bill._id}`, fingerprint: hash(bill) });
  }
  const filtered = rows.filter(r => !q.office || r.office === q.office || (!r.cash && r.officeName && !r.office));
  if (filtered.length > LIMIT) throw fail('الحركات كثيرة. اختر شهرًا أو حسابًا محددًا؛ لم تُعرض إجماليات جزئية.');
  return filtered;
}
function fits(row, batch, movement) {
  return batch.status !== 'void' && id(batch.accountId) === row.accountId && batch.office === row.office && batch.currency === row.currency &&
    movement.day === row.day && movement.direction === row.direction && movement.amountMinor === row.amountMinor;
}
async function view(input, { session, candidates = true } = {}) {
  const rows = await collect(input, { session });
  const batchFilter = { status: { $ne: 'void' }, ...(input.accountId && { accountId: input.accountId }), ...(input.office && { office: input.office }), ...(input.currency && { currency: input.currency }),
    from: { $lte: input.to || '2026-04-03' }, to: { $gte: input.from || '2026-01-01' } };
  const batches = await Batch.find(batchFilter).select('title status revision accountId office currency decimals rows').limit(1001).session(session || null).lean();
  if (batches.length > 1000 || batches.reduce((s, b) => s + b.rows.length, 0) > 20000) throw fail('اختر فترة أو حسابًا أصغر لمراجعة الربط.');
  const reviews = await Review.find({ $or: [{ key: { $in: rows.map(r => r.key) } }, { state: 'linked', batchId: { $in: batches.map(b => b._id) } }] }).session(session || null).lean();
  const adjustments = [];
  // An old manual copy cannot keep contributing after its linked original changed
  // or disappeared. The current original takes over pending review; history is kept.
  for (const saved of reviews.filter(r => r.state === 'linked')) {
    const batch = batches.find(b => id(b) === id(saved.batchId)), movement = batch?.rows.find(r => id(r) === id(saved.rowId));
    if (!movement) continue;
    const original = rows.find(r => r.key === saved.key);
    const valid = original && saved.fingerprint === original.fingerprint && fits(original, batch, movement);
    if (!valid) {
      if (!(input.status === 'approved' && batch.status !== 'approved') && inRange(movement.day, { from: input.from || '2026-01-01', to: input.to || '2026-04-03' })) {
        adjustments.push({ month: movement.day.slice(0, 7), office: batch.office, currency: batch.currency, decimals: batch.decimals,
          category: movement.category, incoming: movement.direction === 'in' ? movement.amountMinor : 0,
          outgoing: movement.direction === 'out' ? movement.amountMinor : 0, count: 1, drafts: batch.status === 'draft' ? 1 : 0 });
      }
      if (!original) rows.push({ key: saved.key, fingerprint: hash([saved.fingerprint, 'missing']), sourceModel: 'MissingSource', sourceId: '',
        number: 'مصدر مرتبط تغيّر أو أُلغي', day: movement.day, description: movement.description, cash: false, contributes: false,
        amountMinor: movement.amountMinor, direction: movement.direction, category: movement.category, currency: batch.currency, decimals: batch.decimals,
        office: batch.office, officeName: batch.office, url: `/accounting/historical-cash?batch=${batch._id}`, orphanLink: true,
        warning: 'مصدر هذه الحركة لم يعد متاحًا ضمن الفترة. استُبعدت نسختها التاريخية من الإجماليات حتى تصحيح الكشف أو الربط.' });
    }
  }
  for (const row of rows) {
    const saved = reviews.find(r => r.key === row.key);
    const current = saved?.fingerprint === row.fingerprint ? saved : null;
    row.state = current?.state || 'pending'; row.note = current?.note || ''; row.category = current?.category || row.category;
    row.changedSinceReview = !!saved && !current;
    row.candidates = [];
    if (row.cash) for (const batch of batches) for (const movement of batch.rows) if (fits(row, batch, movement)) {
      row.candidates.push({ batchId: id(batch), rowId: id(movement), batchRevision: batch.revision, title: batch.title, description: movement.description, category: movement.category });
    }
    if (current?.state === 'linked') {
      const candidate = row.candidates.find(c => c.batchId === id(current.batchId) && c.rowId === id(current.rowId));
      if (candidate) { row.contributes = false; row.manualLink = candidate; }
      else { row.state = 'pending'; row.changedSinceReview = true; row.warning = 'تغيّرت الحركة التاريخية المرتبطة. راجع الربط مجددًا.'; }
    }
    if (row.state === 'excluded') row.contributes = false;
    if (row.warning && row.state !== 'excluded') { row.state = row.state === 'linked' ? 'linked' : 'issue'; }
    if (!candidates) delete row.candidates;
  }
  return { rows, manualAdjustments: adjustments };
}
function summarize(rows, approvedOnly = false) {
  const result = new Map();
  for (const row of rows) {
    if (!row.cash || !row.contributes || (approvedOnly && row.state !== 'reviewed')) continue;
    const group = { month: row.day.slice(0, 7), office: row.office, currency: row.currency, decimals: row.decimals, category: row.category };
    const key = JSON.stringify(group), existing = result.get(key) || { ...group, incoming: 0, outgoing: 0, count: 0, drafts: 0 };
    existing[row.direction === 'in' ? 'incoming' : 'outgoing'] += row.amountMinor; existing.count++;
    if (row.state !== 'reviewed') existing.drafts++;
    result.set(key, existing);
  }
  return [...result.values()].map(r => ({ ...r, net: r.incoming - r.outgoing }));
}
async function list(input = {}) {
  const result = await view(input), rows = result.rows, page = Math.max(1, Math.floor(Number(input.sourcePage) || 1));
  rows.sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key));
  return { rows: rows.slice((page - 1) * 30, page * 30), total: rows.length, page, limit: 30,
    pending: rows.filter(r => ['pending', 'issue'].includes(r.state)).length,
    groups: summarize(rows, input.status === 'approved'), manualAdjustments: result.manualAdjustments };
}
async function review(input, { session, req }) {
  if (!['reviewed', 'issue', 'excluded', 'linked'].includes(input.state)) throw fail('حالة مراجعة غير صالحة.');
  const note = String(input.note || '').trim().slice(0, 500);
  if (note.length < 10) throw fail('اكتب سبب المراجعة، عشرة أحرف على الأقل.');
  await Mutex.updateOne({ key: 'main' }, { $inc: { version: 1 } }, { upsert: true, session });
  const { rows } = await view(input.query || {}, { session });
  const row = rows.find(r => r.key === input.key);
  if (!row || row.fingerprint !== input.fingerprint) throw fail('تغيّرت الحركة الأصلية. حدّث التقرير قبل المراجعة.', 409);
  if (row.orphanLink) throw fail('صحح الحركة أو احذفها من الكشف التاريخي المرتبط أولًا.');
  const categories = require('./historicalCash').CATEGORIES;
  const selectedCategory = input.category || row.category;
  if (!Object.prototype.hasOwnProperty.call(categories, selectedCategory) || (categories[selectedCategory].direction && categories[selectedCategory].direction !== row.direction)) throw fail('التصنيف لا يناسب اتجاه الحركة.');
  if (input.state === 'reviewed' && (row.warning || selectedCategory === 'unknown')) throw fail('عالج التنبيه وحدد التصنيف قبل اعتماد المراجعة.');
  if (input.state === 'reviewed' && row.candidates.length && !input.independent) throw fail('توجد حركة تاريخية مطابقة. اربطها أو أكد أن هذه حركة مستقلة مع السبب.');
  let manual = {};
  if (input.state === 'linked') {
    if (row.warning) throw fail('صحح تنبيه المصدر قبل ربط الحركة التاريخية.');
    const c = row.candidates.find(c => c.batchId === input.batchId && c.rowId === input.rowId);
    if (!row.cash || !c) throw fail('اختر حركة تاريخية بنفس الحساب والتاريخ والعملة والمبلغ.');
    const manualKey = `${c.batchId}:${c.rowId}`;
    const taken = await Review.findOne({ key: { $ne: row.key }, state: 'linked', manualKey }).session(session).lean();
    if (taken && rows.some(r => r.key === taken.key && !r.orphanLink)) throw fail('الحركة التاريخية مرتبطة بسجل آخر بالفعل.');
    if (taken) await Review.updateOne({ _id: taken._id }, { $set: { state: 'excluded', note: `استُبدل الربط بمصدره الحالي: ${row.key}` },
      $unset: { manualKey: '', batchId: '', rowId: '', batchRevision: '' } }, { session });
    manual = { manualKey, batchId: c.batchId, rowId: c.rowId, batchRevision: c.batchRevision };
  }
  await Review.updateOne({ key: row.key }, { $set: { fingerprint: row.fingerprint, state: input.state, category: selectedCategory,
    note, independent: !!input.independent, reviewedBy: req.user._id, reviewedAt: new Date(), ...manual },
    ...(input.state !== 'linked' && { $unset: { manualKey: '', batchId: '', rowId: '', batchRevision: '' } }) }, { upsert: true, session });
  await logAudit({ req, action: 'historicalCash.sourceReview', model: 'AccountingHistoricalCashSourceReview', after: {
    key: row.key, fingerprint: row.fingerprint, state: input.state, category: selectedCategory, note, ...manual } }, session);
  return { success: true };
}
module.exports = { list, review, collect, view, summarize };
