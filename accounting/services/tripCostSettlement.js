const crypto = require('crypto');
const mongoose = require('mongoose');
const Inventory = require('../../models/inventory');
const Order = require('../../models/order');
const { Account, JournalEntry } = require('../models');
const { BankStatementLine, Vendor, SupplierPayment } = require('../models/documents');
const Settlement = require('../models/TripCostSettlement');
const { getConfig } = require('./config');
const { isDay } = require('./dates');
const { fail, resolveAccount } = require('./posting/common');
const { logAudit } = require('./audit');
const payables = require('./posting/payables');
const { convertToUsdMinor, fromMinor } = require('./money');
const { getRate, markRateUsed } = require('./rates');
const COUNTRIES = ['CN', 'UAE', 'TR', 'USA', 'UK', 'LY'];
const id = value => String(value?._id || value);
const ids = values => [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function kind(line) {
  const text = String(line.description || '');
  if (/خدمية|خدميه|service\s*invoice/i.test(text)) return 'service';
  if (/بحري|بحرى|sea\s*(freight|shipping)|ocean\s*freight/i.test(text)) return 'sea';
  if (/جوي|جوى|air\s*(freight|shipping)/i.test(text)) return 'air';
  return 'review';
}
async function source(accountId, session) {
  if (!mongoose.isValidObjectId(accountId)) throw fail('اختر الحساب الجاري للشركة');
  const account = await Account.findOne({ _id: accountId, isActive: true, isGroup: false, isCash: true, cashKind: 'current' }).session(session || null).lean();
  if (!account) throw fail('الحساب الجاري المختار غير متاح');
  return account;
}
async function options(input, session) {
  if (!['air', 'sea'].includes(input.mode)) throw fail('اختر الجوي أو البحري');
  if (input.seaLoadType && !['FCL', 'LCL', 'unknown'].includes(input.seaLoadType)) throw fail('نوع الحاوية غير صالح');
  if ((input.from && !isDay(input.from)) || (input.to && !isDay(input.to)) || (input.from && input.to && input.from > input.to)) throw fail('راجع فترة الكشف');
  const account = await source(input.accountId, session);
  if (!mongoose.isValidObjectId(input.vendorId) || !await Vendor.exists({ _id: input.vendorId, isActive: { $ne: false } }).session(session || null)) throw fail('اختر المورد صاحب الكشف من الموردين النشطين');
  const countries = ids(Array.isArray(input.countries) ? input.countries : String(input.countries || '').split(',').filter(Boolean));
  if (!countries.length || countries.some(c => !COUNTRIES.includes(c))) throw fail('اختر دول الرحلات');
  const currency = account.currency || 'USD';
  const config = await getConfig();
  const currencyInfo = config.currencies.get(currency);
  if (!currencyInfo?.isActive) throw fail('عملة الحساب غير مفعلة');
  const period = input.from || input.to ? { day: { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) } } : {};
  const query = { accountId: account._id, lineStatus: 'unmatched', amount: { $lt: 0 }, ...period };
  const [rawLines, accountCount, periodCount, periodStates] = await Promise.all([
    BankStatementLine.find(query).sort({ day: 1, _id: 1 }).session(session || null).lean(),
    BankStatementLine.countDocuments({ accountId: account._id }).session(session || null),
    BankStatementLine.countDocuments({ accountId: account._id, ...period }).session(session || null),
    BankStatementLine.aggregate([{ $match: { accountId: account._id, ...period } }, { $group: { _id: '$lineStatus', count: { $sum: 1 } } }]).session(session || null),
  ]);
  const classified = rawLines.map(l => ({ ...l, kind: kind(l) }));
  const lines = classified.filter(l => l.kind === input.mode || l.kind === 'review' || ((input.services === true || input.services === 'true') && l.kind === 'service'));
  let emptyReason = '';
  if (!lines.length) emptyReason = !accountCount ? 'no_statement' : !periodCount ? 'outside_period'
    : !rawLines.length ? 'no_available_costs' : 'excluded_by_type';
  let statementAccounts = [];
  if (!lines.length) {
    const counts = await BankStatementLine.aggregate([{ $group: { _id: '$accountId', count: { $sum: 1 } } }]).session(session || null);
    const otherAccounts = await Account.find({ _id: { $in: counts.map(c => c._id), $ne: account._id }, isActive: true, isCash: true, cashKind: 'current' }).select('code name currency').session(session || null).lean();
    statementAccounts = otherAccounts.map(a => ({ ...a, count: counts.find(c => id(c._id) === id(a))?.count || 0 })).sort((a, b) => b.count - a.count);
  }
  const tripQuery = { inventoryType: 'inventoryGoods', shippedCountry: { $in: countries }, shippingType: input.mode };
  if (input.mode === 'sea' && input.seaLoadType) tripQuery.seaLoadType = input.seaLoadType === 'unknown' ? null : input.seaLoadType;
  const trips = await Inventory.find(tripQuery).select('voyage shippedCountry shippingType seaLoadType status arrivalDate createdAt').sort({ createdAt: -1, _id: 1 }).session(session || null).lean();
  const tripKeys = trips.map(t => t._id);
  const weights = tripKeys.length ? await Order.aggregate([
    { $match: { isCanceled: { $ne: true }, 'paymentList.tripId': { $in: tripKeys } } }, { $unwind: '$paymentList' },
    { $match: { 'paymentList.tripId': { $in: tripKeys }, 'paymentList.deliveredPackages.weight.measureUnit': input.mode === 'sea' ? 'CBM' : 'KG' } },
    { $group: { _id: '$paymentList.tripId', weight: { $sum: '$paymentList.deliveredPackages.weight.total' } } },
  ]).session(session || null) : [];
  const weightMap = new Map(weights.map(w => [id(w._id), w.weight]));
  const costAccounts = [(await resolveAccount('trip_cost_wip'))._id,
    (await resolveAccount('cost_shipping_air'))._id, (await resolveAccount('cost_shipping_sea'))._id,
    (await resolveAccount('cost_shipping_domestic'))._id, (await resolveAccount('cost_purchase_invoices'))._id];
  const costs = await JournalEntry.aggregate([
    { $match: { 'lines.tripId': { $in: trips.map(t => t._id) } } }, { $unwind: '$lines' },
    { $match: { 'lines.tripId': { $in: trips.map(t => t._id) }, 'lines.accountId': { $in: costAccounts } } },
    { $group: { _id: '$lines.tripId', cost: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]).session(session || null);
  const costMap = new Map(costs.map(c => [id(c._id), c.cost]));
  const report = await require('./reports/operations').tripProfitability({ shippingType: input.mode, tripIds: tripKeys });
  const revenues = new Map((report.results || []).map(t => [id(t.tripId), t]));
  const matches = await require('./tripCostMatches').candidates(lines.filter(l => l.kind !== 'service'), account, trips, input.vendorId, session);
  return { account: { _id: account._id, name: account.name, currency, decimals: currencyInfo.decimals, office: account.office }, countries,
    diagnostics: { emptyReason, accountCount, periodCount, periodStates, availableCosts: rawLines.length,
      excludedShipping: classified.filter(l => ['air', 'sea'].includes(l.kind) && l.kind !== input.mode).length,
      excludedServices: classified.filter(l => l.kind === 'service' && !lines.includes(l)).length }, statementAccounts,
    lines: lines.map(l => ({ _id: l._id, day: l.day, description: l.description, reference: l.reference, amount: l.amount, kind: l.kind, tripMatches: matches.get(id(l)) || [] })),
    trips: trips.map(t => ({ ...t, existingCost: costMap.get(id(t)) || 0,
      totalRevenue: revenues.get(id(t))?.totalRevenue || 0, recognizedRevenue: revenues.get(id(t))?.revenue || 0,
      weight: Math.round((weightMap.get(id(t)) || 0) * 1000) / 1000 })) };
}
// Largest remainder allocation: whole cents, preserved exactly, deterministic ties.
function split(total, trips, method) {
  const weights = trips.map(t => method === 'equal' ? 1 : t.weight);
  if (weights.some(w => !Number.isFinite(w) || w <= 0)) throw fail('كل رحلة تحتاج وزنًا/حجمًا موجبًا؛ أو اختر التوزيع بالتساوي');
  const sum = weights.reduce((s, w) => s + w, 0);
  const shares = weights.map((w, i) => ({ i, amount: Math.floor(total * w / sum), fraction: total * w / sum % 1 }));
  let left = total - shares.reduce((s, a) => s + a.amount, 0);
  [...shares].sort((a, b) => b.fraction - a.fraction || a.i - b.i).forEach(a => { if (left-- > 0) a.amount++; });
  return shares.map(a => ({ tripId: trips[a.i]._id, amount: a.amount }));
}
async function preview(input, session) {
  if (!['weight', 'equal'].includes(input.method)) throw fail('اختر طريقة التوزيع');
  const data = await options(input, session);
  const lineIds = ids(input.lineIds), tripIds = ids(input.tripIds);
  const lines = data.lines.filter(l => lineIds.includes(id(l)));
  for (const line of lines) {
    const chosen = input.lineKinds?.[id(line)] || line.kind;
    if (![input.mode, 'service'].includes(chosen)) throw fail(`${line.day}: حدد هل السطر تكلفة شحن أو فاتورة خدمية قبل اختياره`);
    line.kind = chosen;
  }
  const trips = data.trips.filter(t => tripIds.includes(id(t))).sort((a, b) => id(a).localeCompare(id(b)));
  if (!lines.length || lines.length !== lineIds.length || trips.length !== tripIds.length) throw fail('بعض السطور أو الرحلات تغيرت أو لم تعد متاحة؛ حدّث الخيارات');
  if (lines.some(l => l.kind !== 'service') && !trips.length) throw fail('اختر الرحلات التي تخص هذه التكلفة');
  if (!mongoose.isValidObjectId(input.vendorId)) throw fail('اختر المورد صاحب الكشف');
  const vendor = await Vendor.findOne({ _id: input.vendorId, isActive: { $ne: false } }).session(session || null).lean();
  if (!vendor) throw fail('المورد المختار غير متاح');
  const planned = [], allocations = new Map(trips.map(t => [id(t), 0]));
  const purchase = await resolveAccount('cost_services');
  const config = await getConfig();
  for (const line of lines) {
    const total = -line.amount;
    if (!Number.isSafeInteger(total) || total <= 0) throw fail('مبلغ السطر غير صالح');
    const shares = line.kind === 'service' ? [] : split(total, trips, input.method);
    const quote = await getRate(data.account.currency, line.day, { session, nearest: true });
    const usd = minor => convertToUsdMinor(minor, data.account.decimals, quote.rate);
    if (shares.some(s => s.amount > 0 && usd(s.amount) <= 0)) throw fail('حصة إحدى الرحلات أقل من سنت بالدولار؛ قلل عدد الرحلات المختارة');
    const totalUsd = shares.length ? shares.reduce((sum, s) => sum + usd(s.amount), 0) : usd(total);
    if (totalUsd <= 0) throw fail('التكلفة بالدولار صفر؛ راجع المبلغ وسعر الصرف');
    shares.forEach(s => allocations.set(id(s.tripId), allocations.get(id(s.tripId)) + usd(s.amount)));
    const old = !!config.count && (line.day < config.count.day || line.day === config.count.day && config.count.endOfDay);
    if (old && !config.count.accountIds.has(id(data.account))) throw fail('سجّل جرد الحساب المختار أولًا؛ لا يمكن منع تكرار الرصيد القديم دون جرد الحساب');
    if (old && !config.settings?.cutoffAt) throw fail('اعتمد الترحيل التاريخي أولًا قبل تسوية التكاليف الداخلة في الرصيد الافتتاحي');
    const billLines = line.kind === 'service'
      ? [{ target: 'expense', accountId: purchase._id, office: input.expenseOffice || data.account.office, amount: fromMinor(total, data.account.decimals), description: line.description }]
      : shares.filter(s => s.amount > 0).map(s => ({ target: 'trip', tripId: s.tripId, amount: fromMinor(s.amount, data.account.decimals), description: `${line.description} — توزيع تقديري` }));
    if (line.kind === 'service' && !config.offices.get(billLines[0].office)?.isActive) throw fail('اختر مكتب المصروف للفواتير الخدمية');
    const duplicates = await require('./costDuplicates').candidates({ vendorId: vendor._id, day: line.day, currency: data.account.currency, lines: billLines, vendorRef: line.reference, vendorRefKind: 'bank' }, { session });
    // Also inspect other vendors: generic/historical supplier naming can vary.
    const twins = await require('./posting/bank').possibleDuplicates({ ...line, accountId: data.account._id }, session);
    const tripDuplicates = line.tripMatches.map(m => ({ billId: m.billId, number: m.number, day: m.day, amount: m.amount, currency: m.currency,
      reason: 'تكلفة رحلة مسجلة بنفس المبلغ والعملة وتاريخ قريب؛ راجع مطابقة الرحلات أولًا' }));
    planned.push({ line: { ...line, totalUsd, rate: quote.rate, rateDay: quote.day }, quote, billLines, old, duplicates: [...duplicates, ...twins, ...tripDuplicates] });
  }
  const output = { account: data.account, vendor: { _id: vendor._id, name: vendor.name }, countries: data.countries, mode: input.mode, method: input.method,
    shippingTotal: planned.filter(p => p.line.kind !== 'service').reduce((s, p) => s + p.line.totalUsd, 0),
    serviceTotal: planned.filter(p => p.line.kind === 'service').reduce((s, p) => s + p.line.totalUsd, 0),
    historicalTotal: planned.filter(p => p.old).reduce((s, p) => s + p.line.totalUsd, 0),
    allocations: trips.map(t => ({ ...t, allocated: allocations.get(id(t)) })),
    lines: planned.map(p => ({ ...p.line, old: p.old, duplicates: p.duplicates })),
    existingCosts: trips.some(t => t.existingCost !== 0), blocked: planned.some(p => p.duplicates.length > 0) };
  const canceledVersions = await Settlement.countDocuments({ status: 'canceled', sourceLineIds: { $in: lines.map(l => l._id) } }).session(session || null);
  output.totalRevenue = trips.reduce((s, t) => s + t.totalRevenue, 0);
  output.totalExistingCost = trips.reduce((s, t) => s + t.existingCost, 0);
  // Service sales are independent of these trips. Do not subtract their costs from
  // shipping revenue; the income statement compares service sales with service costs.
  output.estimatedNet = output.totalRevenue - output.totalExistingCost - output.shippingTotal;
  output.fingerprint = hash({ output, billLines: planned.map(p => p.billLines), canceledVersions, count: config.count && { day: config.count.day, endOfDay: config.count.endOfDay, accounts: [...config.count.accountIds].sort() }, serviceAccount: id(purchase) });
  return { output, planned };
}
async function apply(input, { session, req }) {
  const previous = await Settlement.findOne({ fingerprint: input.fingerprint }).session(session);
  if (previous) {
    if (previous.status !== 'posted') throw fail('التسوية ألغيت؛ أنشئ معاينة جديدة');
    return previous;
  }
  const { output, planned } = await preview(input, session);
  if (output.fingerprint !== input.fingerprint) throw fail('تغيرت بيانات المعاينة؛ راجع التوزيع مجددًا');
  if (output.blocked) throw fail('توجد قيود أو تكاليف محتملة مسجلة؛ طابقها بالطريقة المعتادة واستبعدها من التسوية');
  if (output.existingCosts && input.confirmAdditional !== true) throw fail('راجع التكاليف السابقة وأكد أن المبالغ المختارة إضافية وغير مسجلة');
  const vendor = output.vendor;
  const [batch] = await Settlement.create([{ accountId: output.account._id, mode: input.mode, method: input.method,
    fingerprint: output.fingerprint, sourceLineIds: planned.map(p => p.line._id), preview: output, createdBy: req?.user?._id }], { session });
  for (const p of planned) {
    const claimed = await BankStatementLine.updateOne({ _id: p.line._id, lineStatus: 'unmatched', tripCostSettlementId: null },
      { $set: { tripCostSettlementId: batch._id } }, { session });
    if (claimed.modifiedCount !== 1) throw fail('سطر الكشف مستخدم في تسوية أخرى');
    const billInput = { vendorId: vendor._id, day: p.line.day, currency: output.account.currency, rate: p.line.rate, lines: p.billLines,
      ...(p.old ? { paidBeforeCount: true } : { paidImmediatelyFrom: output.account._id }),
      vendorRef: p.line.reference, vendorRefKind: 'bank', idempotencyKey: `TRIP_COST_POOL:${batch._id}:${p.line._id}`,
      note: `تسوية كشف ${vendor.name}؛ الدول ${output.countries.join(', ')}؛ توزيع تقديري. الخدمات مصاريف شراء مستقلة. سعر الصرف ${p.line.rate} بتاريخ ${p.line.rateDay || p.line.day}.` };
    // Equal service amounts on distinct statement rows in THIS transaction are legitimate.
    // Never override a pre-existing invoice or a repeated supplier invoice reference.
    const duplicate = await require('./costDuplicates').preview(billInput, { session });
    const created = new Set(batch.bills.map(b => id(b.billId)));
    if (duplicate.results.length && duplicate.canConfirmIndependent && duplicate.results.every(d => created.has(id(d.billId)))) {
      Object.assign(billInput, { duplicateDecision: 'independent', duplicateFingerprint: duplicate.fingerprint,
        duplicateReason: `سطور مستقلة مختارة من كشف ${vendor.name}؛ التسوية ${batch._id}، السطر ${p.line._id}` });
    }
    let bill;
    try { bill = await payables.createBill(billInput, { session, req, sync: { defer: true } }); }
    catch (e) { e.message = `${p.line.day} — ${p.line.description}: ${e.message}`; throw e; }
    await markRateUsed(p.quote.rateId, session);
    const payment = p.old ? null : await SupplierPayment.findOne({ 'allocations.billId': bill._id, status: 'posted' }).session(session);
    if (!p.old && !payment) throw fail('قيد سداد التكلفة غير موجود');
    await BankStatementLine.updateOne({ _id: p.line._id }, { $set: { billId: bill._id, entryId: payment?.entryId || bill.entryId,
      ...(payment && { paymentId: payment._id }), billCreatedFromStatement: true, lineStatus: 'created_entry' } }, { session });
    batch.bills.push({ billId: bill._id, ...(payment && { paymentId: payment._id }) });
  }
  for (const trip of output.allocations) await require('./claims/sync').syncTrip(trip._id, { session, user: req?.user });
  await batch.save({ session });
  await logAudit({ req, action: 'tripCostSettlement.post', model: 'AccountingTripCostSettlement', docId: batch._id, after: batch }, session);
  return batch;
}
async function cancel(batchId, { session, req, reason }) {
  if (!String(reason || '').trim()) throw fail('سبب الإلغاء مطلوب');
  const batch = await Settlement.findById(batchId).session(session);
  if (!batch || batch.status !== 'posted') throw fail('التسوية غير متاحة للإلغاء');
  const { cancelDocument } = require('./cancel');
  for (const b of batch.bills) {
    if (b.paymentId) await cancelDocument('AccountingSupplierPayment', b.paymentId, { session, req, reason, tripCostSettlementId: batch._id });
    await cancelDocument('AccountingSupplierBill', b.billId, { session, req, reason, tripCostSettlementId: batch._id });
  }
  await BankStatementLine.updateMany({ _id: { $in: batch.sourceLineIds }, tripCostSettlementId: batch._id },
    { $set: { lineStatus: 'unmatched' }, $unset: { tripCostSettlementId: '', billId: '', entryId: '', paymentId: '', billCreatedFromStatement: '' } }, { session });
  batch.status = 'canceled'; batch.cancelReason = reason; batch.canceledBy = req?.user?._id; await batch.save({ session });
  await logAudit({ req, action: 'tripCostSettlement.cancel', model: 'AccountingTripCostSettlement', docId: batch._id, after: batch }, session);
  return batch;
}
async function matchPreview(input, session) {
  const data = await options(input, session);
  if (!Array.isArray(input.matches) || !input.matches.length) throw fail('اختر سطور المطابقة وفواتير تكاليف الرحلات');
  const selected = [], lineIds = new Set(), billIds = new Set();
  for (const pick of input.matches) {
    if (lineIds.has(id(pick.lineId)) || billIds.has(id(pick.billId))) throw fail('لا يمكن ربط سطر أو فاتورة مرتين في نفس المطابقة');
    const line = data.lines.find(l => id(l) === id(pick.lineId));
    const candidate = line?.tripMatches.find(m => id(m.billId) === id(pick.billId));
    if (!line || !candidate?.canMatch) throw fail(candidate?.problem || 'تغير السطر أو الفاتورة أو لم تعد المطابقة متاحة؛ حدّث الخيارات');
    selected.push({ lineId: line._id, description: line.description, day: line.day, amount: line.amount, candidate });
    lineIds.add(id(line)); billIds.add(id(candidate.billId));
  }
  const output = { account: data.account, matches: selected, needsConfirmation: selected.some(s => s.candidate.tripConflict || s.candidate.vendorConflict || s.candidate.vendorUnidentified) };
  output.fingerprint = hash(output);
  return output;
}
async function matchExisting(input, { session, req }) {
  const preview = await matchPreview(input, session);
  if (input.fingerprint !== preview.fingerprint) throw fail('تغيرت بيانات المطابقة؛ راجع المعاينة مجددًا');
  if (input.confirmed !== true) throw fail('راجع الفواتير والرحلات وأكد أنها نفس العمليات');
  if (preview.needsConfirmation && input.confirmConflicts !== true) throw fail('رقم الرحلة أو المورد مختلف أو المورد تاريخي عام؛ راجع أنها نفس العمليات قبل تأكيد المطابقة');
  const results = [];
  for (const selected of preview.matches) {
    try {
      results.push(await require('./posting/bankPurchaseReview').matchPurchase(selected.lineId, { kind: 'bill', billId: selected.candidate.billId,
        historicalSettlement: selected.candidate.mode === 'historical_settlement', confirmHistoricalSettlement: true,
        confirmMerchant: selected.candidate.vendorConflict && input.confirmConflicts === true,
        confirmTripDifference: selected.candidate.tripConflict && input.confirmConflicts === true,
      }, { session, req }));
    } catch (e) { e.message = `${selected.day} — ${selected.candidate.number}: ${e.message}`; throw e; }
  }
  await logAudit({ req, action: 'tripCostSettlement.match', model: 'AccountingBankStatementLine', after: { fingerprint: preview.fingerprint,
    confirmConflicts: input.confirmConflicts === true, matches: preview.matches.map(s => ({ lineId: s.lineId, billId: s.candidate.billId, trips: s.candidate.trips, tripConflict: s.candidate.tripConflict })) } }, session);
  return { matched: results.length };
}
module.exports = { options, preview, apply, cancel, matchPreview, matchExisting };
