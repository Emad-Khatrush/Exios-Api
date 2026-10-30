const crypto = require('crypto');
const mongoose = require('mongoose');
const { HistoricalCashBatch: Batch, HistoricalCashMutex: Mutex } = require('../models/historicalCash');
const { JournalEntry } = require('../models');
const { getConfig } = require('./config');
const { isDay } = require('./dates');
const { logAudit } = require('./audit');
const ErrorHandler = require('../../utils/errorHandler');
const fail = (message, code = 400) => new ErrorHandler(code, message);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const id = value => String(value?._id || value || '');
const CATEGORIES = {
  customer_receipt: { label: 'مقبوضات عملاء / إيداع محفظة', direction: 'in', group: 'operating' },
  supplier_payment: { label: 'مدفوعات موردين ورحلات', direction: 'out', group: 'operating' },
  operating: { label: 'مدفوعات تشغيل ورواتب', direction: 'out', group: 'operating' },
  customer_refund: { label: 'سحب أو استرداد للعميل', direction: 'out', group: 'operating' },
  supplier_refund: { label: 'مبالغ مستردة من المورد', direction: 'in', group: 'operating' },
  transfer: { label: 'تحويل بين حسابات الشركة', group: 'transfer' },
  financing: { label: 'رأس مال وقروض ومسحوبات شركاء', group: 'financing' },
  investing: { label: 'أصول واستثمارات', group: 'investing' },
  unknown: { label: 'بانتظار التصنيف', group: 'unknown' },
};
const iso = value => {
  const day = text(value, 10);
  if (!isDay(day)) throw fail('استخدم تاريخًا صحيحًا بصيغة YYYY-MM-DD.');
  return day;
};
function minor(value, decimals, signed = false) {
  if (value === '' || value === undefined || value === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(String(value).trim())) throw fail('المبلغ يجب أن يكون رقمًا دون رموز أو فواصل آلاف.');
  const number = Number(value), scaled = number * 10 ** decimals, rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || (!signed && number <= 0) || Math.abs(scaled - rounded) > 0.000001) throw fail(`المبلغ غير صالح أو يتجاوز ${decimals} منازل عشرية.`);
  return rounded;
}
async function options() {
  const config = await getConfig();
  return { categories: CATEGORIES, offices: [...config.offices.values()].map(o => ({ code: o.code, name: o.name })),
    accounts: [...config.accountsById.values()].filter(a => a.isCash && a.isActive && !a.isGroup && a.type === 'asset')
      .map(a => ({ _id: a._id, code: a.code, name: a.name, office: a.office, currency: a.currency || 'USD', decimals: config.currencies.get(a.currency || 'USD')?.decimals ?? 2 })) };
}
async function normalize(input, file, session) {
  const config = await getConfig();
  if (!mongoose.isValidObjectId(input.accountId)) throw fail('اختر الحساب.');
  const account = config.accountsById.get(id(input.accountId));
  if (!account?.isActive || !account.isCash || account.isGroup || account.type !== 'asset') throw fail('اختر حساب خزينة أو بنك نقدي فعالًا. مشتريات بطاقة الائتمان ليست حركة نقدية؛ سجّل سدادها من كشف البنك الذي دفعها.');
  const office = config.offices.get(input.office);
  if (!office || (account.office && account.office !== office.code)) throw fail('المكتب لا يتوافق مع الحساب المختار.');
  const currency = account.currency || 'USD', decimals = config.currencies.get(currency)?.decimals ?? 2;
  const from = iso(input.from), to = iso(input.to);
  const scope = input.scope == null ? 'full' : input.scope;
  if (!['full', 'wallets'].includes(scope)) throw fail('اختر كشف خزينة كاملًا أو حركات محافظ تاريخية فقط.');
  if (from > to) throw fail('بداية الفترة بعد نهايتها.');
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 1000) throw fail('أدخل من سطر إلى 1000 سطر في كل كشف.');
  if (file && (file.size > 5 * 1024 * 1024 || !/\.(xlsx|xls|csv)$/i.test(file.originalname))) throw fail('ملف المصدر يجب أن يكون Excel أو CSV بحجم أقصى 5 MB.');
  const rows = input.rows.map((value, index) => {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    try {
      const day = iso(raw.day);
      if (day < from || day > to) throw fail('التاريخ خارج فترة الكشف.');
      const description = text(raw.description);
      if (!description) throw fail('البيان مطلوب.');
      const direction = raw.direction;
      if (!['in', 'out'].includes(direction)) throw fail('اختر قبض أو صرف.');
      const category = raw.category || 'unknown';
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category) || (CATEGORIES[category].direction && CATEGORIES[category].direction !== direction)) throw fail('التصنيف لا يتوافق مع اتجاه الحركة.');
      if (scope === 'wallets' && !['customer_receipt', 'customer_refund', 'unknown'].includes(category)) throw fail('كشف المحافظ يقبل إيداعات وسحوبات العملاء فقط. سجّل المصاريف في قسمها أو اختر كشف خزينة كاملًا.');
      const amountMinor = minor(raw.amount, decimals);
      if (amountMinor === null) throw fail('المبلغ مطلوب.');
      const reference = text(raw.reference, 150), transferRef = text(raw.transferRef, 150);
      const identity = reference ? ['reference', reference.toLowerCase().replace(/\s+/g, '')]
        : ['description', description.toLowerCase().replace(/\s+/g, ' ')];
      const fingerprint = hash([id(account), office.code, currency, day, direction, amountMinor, identity]);
      return { ...(mongoose.isValidObjectId(raw._id) && { _id: raw._id }), day, description, direction, category, amountMinor, reference, transferRef,
        fingerprint, duplicateReason: text(raw.duplicateReason), sourceRow: Number(raw.sourceRow) || index + 1 };
    } catch (error) { return { sourceRow: Number(raw.sourceRow) || index + 1, error: error.message }; }
  });
  return { title: text(input.title, 150) || `${account.name} · ${from} — ${to}`, office: office.code, officeName: office.name,
    accountId: account._id, accountName: account.name, accountCode: account.code, currency, decimals, from, to, scope,
    openingMinor: minor(input.opening, decimals, true), closingMinor: minor(input.closing, decimals, true), rows,
    sourceFile: file ? { name: text(file.originalname, 180), hash: hash(file.buffer), sheet: text(input.sheet, 100) } : undefined };
}
async function preview(input, file, { session, excludeId } = {}) {
  if (excludeId && !mongoose.isValidObjectId(excludeId)) throw fail('كشف غير صالح.');
  const draft = await normalize(input, file, session);
  const fingerprints = draft.rows.filter(r => !r.error).map(r => r.fingerprint);
  const wanted = new Set(fingerprints);
  const others = await Batch.find({ status: { $ne: 'void' }, ...(excludeId && { _id: { $ne: excludeId } }),
    'rows.fingerprint': { $in: fingerprints } }).select('title rows.fingerprint').session(session || null).lean();
  const duplicateMap = new Map();
  for (const batch of others) for (const row of batch.rows) if (wanted.has(row.fingerprint)) duplicateMap.set(row.fingerprint, batch.title);
  const seen = new Set();
  const rows = draft.rows.map(row => {
    if (row.error) return row;
    const duplicate = duplicateMap.get(row.fingerprint) || (seen.has(row.fingerprint) ? 'سطر مماثل داخل الملف نفسه' : null);
    seen.add(row.fingerprint);
    return { ...row, duplicate, error: duplicate && row.duplicateReason.length < 10 ? 'راجع التكرار أو اكتب سببًا مستقلًا لا يقل عن 10 أحرف.' : null };
  });
  // Show possible already-posted cash movements as references only. They are NOT
  // imported/posted again and are never added to this report a second time.
  const books = await JournalEntry.aggregate([
    { $match: { day: { $gte: draft.from, $lte: draft.to }, status: 'posted', reversalOf: null, 'lines.accountId': draft.accountId } },
    { $unwind: '$lines' }, { $match: { 'lines.accountId': draft.accountId } },
    { $project: { number: 1, day: 1, net: draft.currency === 'USD' ? { $subtract: ['$lines.debit', '$lines.credit'] } : '$lines.amountCurrency' } },
  ]).session(session || null);
  const bookMap = new Map();
  for (const entry of books) {
    const key = `${entry.day}:${entry.net}`, numbers = bookMap.get(key) || [];
    if (numbers.length < 5 && !numbers.includes(entry.number)) numbers.push(entry.number);
    bookMap.set(key, numbers);
  }
  const resultRows = rows.map(row => ({ ...row, bookMatches: row.error ? [] : bookMap.get(`${row.day}:${row.direction === 'in' ? row.amountMinor : -row.amountMinor}`) || [] }));
  const inflow = rows.reduce((s, r) => s + (!r.error && r.direction === 'in' ? r.amountMinor : 0), 0);
  const outflow = rows.reduce((s, r) => s + (!r.error && r.direction === 'out' ? r.amountMinor : 0), 0);
  if (![inflow, outflow, (draft.openingMinor || 0) + inflow - outflow].every(Number.isSafeInteger)) throw fail('إجمالي الكشف يتجاوز دقة المبالغ المدعومة.');
  const reconciliation = draft.scope === 'wallets' || draft.openingMinor === null || draft.closingMinor === null ? null : draft.openingMinor + inflow - outflow - draft.closingMinor;
  return { ...draft, rows: resultRows, inflow, outflow, reconciliation,
    errors: rows.filter(r => r.error).length,
    fingerprint: hash([draft, rows.map(r => [r.fingerprint, r.duplicate, r.error])]) };
}
async function lock(session) {
  await Mutex.updateOne({ key: 'main' }, { $inc: { version: 1 } }, { upsert: true, session });
}
async function assertTransferPeersEditable(refs, batchId, session) {
  if (await Batch.exists({ status: 'approved', ...(batchId && { _id: { $ne: batchId } }),
    'rows.transferRef': { $in: refs.filter(Boolean) } }).session(session)) {
    throw fail('يوجد طرف تحويل في كشف معتمد. أعد فتح الكشف المرتبط قبل تغيير التحويل.', 409);
  }
}
function rowInput(batch) {
  return { ...batch, opening: batch.openingMinor === null || batch.openingMinor === undefined ? null : batch.openingMinor / 10 ** batch.decimals,
    closing: batch.closingMinor === null || batch.closingMinor === undefined ? null : batch.closingMinor / 10 ** batch.decimals,
    rows: batch.rows.map(row => ({ ...row, amount: row.amountMinor / 10 ** batch.decimals })) };
}
async function save(input, file, { session, req, batchId } = {}) {
  await lock(session);
  let batch;
  if (batchId) {
    if (!mongoose.isValidObjectId(batchId)) throw fail('كشف غير صالح.');
    batch = await Batch.findById(batchId).session(session);
    if (!batch || batch.status !== 'draft') throw fail('الكشف غير موجود أو معتمد. أعد فتحه قبل التعديل.', 409);
    if (batch.revision !== Number(input.revision)) throw fail('تغير الكشف. أعد تحميله قبل التعديل.', 409);
  } else {
    const key = text(input.requestKey, 100);
    if (!/^[\w-]{16,100}$/.test(key)) throw fail('مفتاح حفظ غير صالح.');
    const existing = await Batch.findOne({ requestKey: key }).session(session);
    if (existing) {
      if (existing.requestFingerprint !== input.fingerprint) throw fail('استُخدم مفتاح الحفظ لبيانات مختلفة. أعد فتح نموذج جديد.', 409);
      return { _id: existing._id, replayed: true };
    }
  }
  const before = batch ? { title: batch.title, office: batch.office, accountId: batch.accountId, from: batch.from, to: batch.to,
    scope: batch.scope || 'full', openingMinor: batch.openingMinor, closingMinor: batch.closingMinor, rows: batch.toObject().rows, revision: batch.revision } : undefined;
  const result = await preview(input, file, { session, excludeId: batchId });
  if (result.fingerprint !== input.fingerprint) throw fail('تغيرت البيانات أو التكرارات. أعد معاينة الكشف.', 409);
  if (result.errors) throw fail('صحح أخطاء المعاينة قبل الحفظ.');
  await assertTransferPeersEditable([...(batch?.rows || []), ...result.rows].filter(r => r.category === 'transfer').map(r => r.transferRef), batchId, session);
  const { fingerprint, inflow, outflow, reconciliation, errors, ...fields } = result;
  fields.rows = fields.rows.map(({ duplicate, error, bookMatches, ...r }) => r);
  if (file) fields.sourceFile.data = file.buffer;
  else delete fields.sourceFile;
  if (batch) {
    batch.set(fields); batch.revision++; batch.updatedBy = req.user._id;
    await batch.save({ session });
  } else {
    [batch] = await Batch.create([{ ...fields, requestKey: input.requestKey, requestFingerprint: input.fingerprint, createdBy: req.user._id, updatedBy: req.user._id }], { session });
  }
  await logAudit({ req, action: batchId ? 'historicalCash.update' : 'historicalCash.create', model: 'AccountingHistoricalCashBatch', docId: batch._id, before,
    after: { title: batch.title, office: batch.office, accountId: batch.accountId, from: batch.from, to: batch.to,
      scope: batch.scope || 'full', openingMinor: batch.openingMinor, closingMinor: batch.closingMinor, rows: batch.toObject().rows,
      count: batch.rows.length, sourceHash: batch.sourceFile?.hash, revision: batch.revision } }, session);
  return { _id: batch._id, revision: batch.revision };
}
async function transferProblems(batch, session) {
  const refs = [...new Set(batch.rows.filter(r => r.category === 'transfer').map(r => r.transferRef))];
  if (!refs.length) return [];
  const others = await Batch.find({ status: { $ne: 'void' }, 'rows.transferRef': { $in: refs.filter(Boolean) } }).select('accountId currency rows').session(session || null).lean();
  return refs.filter(ref => {
    const legs = others.flatMap(b => b.rows.filter(r => r.category === 'transfer' && r.transferRef === ref).map(r => ({ ...r, account: id(b.accountId), currency: b.currency })));
    if (!ref || legs.length !== 2 || legs[0].account === legs[1].account || legs[0].direction === legs[1].direction) return true;
    if (Math.abs(new Date(legs[0].day) - new Date(legs[1].day)) > 7 * 86400000) return true;
    return legs[0].currency === legs[1].currency && legs[0].amountMinor !== legs[1].amountMinor;
  });
}
async function detail(batchId) {
  if (!mongoose.isValidObjectId(batchId)) throw fail('رقم كشف غير صالح.');
  const batch = await Batch.findById(batchId).lean();
  if (!batch) throw fail('الكشف غير موجود.', 404);
  const inflow = batch.rows.reduce((s, r) => s + (r.direction === 'in' ? r.amountMinor : 0), 0);
  const outflow = batch.rows.reduce((s, r) => s + (r.direction === 'out' ? r.amountMinor : 0), 0);
  return { ...batch, scope: batch.scope || 'full', inflow, outflow,
    reconciliation: batch.scope === 'wallets' || batch.openingMinor == null || batch.closingMinor == null ? null : batch.openingMinor + inflow - outflow - batch.closingMinor,
    transferProblems: await transferProblems(batch) };
}
async function changeStatus(batchId, input, { session, req }) {
  if (!mongoose.isValidObjectId(batchId)) throw fail('كشف غير صالح.');
  await lock(session);
  const batch = await Batch.findById(batchId).session(session);
  if (!batch || batch.revision !== Number(input.revision)) throw fail('تغير الكشف أو لم يعد موجودًا. أعد تحميله.', 409);
  const reason = text(input.reason);
  if (reason.length < 10) throw fail('اكتب ملاحظة مراجعة لا تقل عن 10 أحرف.');
  if (input.action === 'approve') {
    if (batch.status !== 'draft') throw fail('اعتماد الكشف متاح للمسودات فقط.');
    const check = await preview(rowInput(batch.toObject()), null, { session, excludeId: batch._id });
    if (check.errors || check.rows.some(r => r.category === 'unknown')) throw fail('أكمل التصنيف وعالج الأخطاء والتكرارات قبل الاعتماد.');
    if (check.scope === 'full' && check.reconciliation !== 0) throw fail('طابق رصيدي البداية والنهاية قبل اعتماد كشف الخزينة الكامل.');
    if ((await transferProblems(batch, session)).length) throw fail('اربط طرفي التحويل الداخلي بمرجع موحد ومبالغ متوافقة قبل الاعتماد.');
    batch.status = 'approved'; batch.approvedAt = new Date(); batch.approvedBy = req.user._id;
  } else if (input.action === 'reopen' && batch.status === 'approved') {
    batch.status = 'draft'; batch.approvedAt = undefined; batch.approvedBy = undefined;
  } else if (input.action === 'void' && batch.status === 'draft') {
    await assertTransferPeersEditable(batch.rows.filter(r => r.category === 'transfer').map(r => r.transferRef), batchId, session);
    batch.status = 'void'; batch.voidReason = reason;
  } else throw fail('الإجراء غير متاح لهذا الكشف.');
  batch.reviewNote = reason; batch.revision++; batch.updatedBy = req.user._id;
  await batch.save({ session });
  await logAudit({ req, action: `historicalCash.${input.action}`, model: 'AccountingHistoricalCashBatch', docId: batch._id,
    after: { revision: batch.revision, reason, scope: batch.scope || 'full' } }, session);
  return { status: batch.status, revision: batch.revision };
}
function filters(input) {
  const match = { status: input.status === 'approved' ? 'approved' : { $ne: 'void' } };
  if (input.from) match.to = { $gte: iso(input.from) };
  if (input.to) match.from = { $lte: iso(input.to) };
  if (input.from && input.to && input.from > input.to) throw fail('فترة غير صالحة.');
  if (input.office) match.office = text(input.office, 30);
  if (input.accountId) { if (!mongoose.isValidObjectId(input.accountId)) throw fail('حساب غير صالح.'); match.accountId = new mongoose.Types.ObjectId(input.accountId); }
  if (input.currency) match.currency = text(input.currency, 3);
  return match;
}
async function list(input = {}) {
  const match = filters(input), page = Math.max(1, Math.floor(Number(input.page) || 1));
  const [batches, count] = await Promise.all([
    Batch.find(match).select('-rows -sourceFile.data').sort({ from: -1, _id: -1 }).skip((page - 1) * 25).limit(25).lean(),
    Batch.countDocuments(match),
  ]);
  const rowMatch = {};
  if (input.from || input.to) rowMatch['rows.day'] = { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) };
  const groups = await Batch.aggregate([
    { $match: match }, { $unwind: '$rows' }, { $match: rowMatch },
    { $group: { _id: { month: { $substrBytes: ['$rows.day', 0, 7] }, office: '$office', currency: '$currency', decimals: '$decimals', category: '$rows.category' },
      incoming: { $sum: { $cond: [{ $eq: ['$rows.direction', 'in'] }, '$rows.amountMinor', 0] } },
      outgoing: { $sum: { $cond: [{ $eq: ['$rows.direction', 'out'] }, '$rows.amountMinor', 0] } },
      count: { $sum: 1 }, drafts: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } } } },
    { $sort: { '_id.month': 1, '_id.currency': 1, '_id.office': 1, '_id.category': 1 } },
  ]);
  const manualGroups = groups.map(g => ({ ...g._id, incoming: g.incoming, outgoing: g.outgoing, net: g.incoming - g.outgoing, count: g.count, drafts: g.drafts }));
  const sources = await require('./historicalCashSources').list(input);
  const combined = new Map();
  const add = (r, sign = 1) => {
    const key = JSON.stringify([r.month, r.office, r.currency, r.category]);
    const existing = combined.get(key) || { month: r.month, office: r.office, currency: r.currency, category: r.category, decimals: r.decimals, incoming: 0, outgoing: 0, net: 0, count: 0, drafts: 0 };
    for (const field of ['incoming', 'outgoing', 'count', 'drafts']) existing[field] += sign * r[field];
    existing.net = existing.incoming - existing.outgoing; combined.set(key, existing);
  };
  if (input.mode !== 'normal') {
    manualGroups.forEach(r => add(r)); sources.manualAdjustments.forEach(r => add(r, -1));
  }
  if (input.mode !== 'manual') sources.groups.forEach(r => add(r));
  return { batches, count, page, limit: 25, sources, groups: [...combined.values()].filter(r => r.count > 0) };
}
async function source(batchId) {
  if (!mongoose.isValidObjectId(batchId)) throw fail('كشف غير صالح.');
  const batch = await Batch.findById(batchId).select('+sourceFile.data');
  if (!batch?.sourceFile?.data) throw fail('لا يوجد ملف مصدر لهذا الكشف.', 404);
  return { name: batch.sourceFile.name, hash: batch.sourceFile.hash, sheet: batch.sourceFile.sheet, data: Buffer.from(batch.sourceFile.data) };
}
module.exports = { options, preview, save, detail, changeStatus, list, source, CATEGORIES, rowInput };
