const mongoose = require('mongoose');
const { Account } = require('../../models');
const { SupplierBill, SupplierPayment, BankStatementLine } = require('../../models/documents');
const Order = require('../../../models/order');
const { getConfig } = require('../config');
const { isDay, addDays, toDay } = require('../dates');
const { fail, resolveAccount } = require('./common');
const { originalOf, paymentValue } = require('./bankAmounts');
const { postEntry } = require('../ledger');
const { logAudit } = require('../audit');
const active = ['matched', 'created_entry'];
const id = value => String(value?._id || value || '');
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const amountOf = bill => bill.total ?? bill.lines.reduce((sum, line) => sum + Number(line.amount), 0);

function filters(input) {
  if ((input.from && !isDay(input.from)) || (input.to && !isDay(input.to)) || (input.from && input.to && input.from > input.to)) throw fail('فترة البحث غير صالحة');
  for (const key of ['accountId', 'vendorId']) if (input[key] && !mongoose.isValidObjectId(input[key])) throw fail('الحساب أو المورد غير صالح');
}

// The list is independent of a selected statement line. Payment allocations and journal
// matches are included, so an invoice paid outside the import screen is still recognised.
async function list(input = {}) {
  filters(input);
  const { count } = await getConfig();
  const period = input.period || 'all';
  if (!['all', 'current', 'historical'].includes(period)) throw fail('فترة المتابعة غير صالحة');
  input = { ...input };
  if (count && period === 'current') {
    const start = count.endOfDay ? addDays(count.day, 1) : count.day;
    if (!input.from || input.from < start) input.from = start;
  }
  if (count && period === 'historical' && (!input.to || input.to > count.day)) input.to = count.day;
  if (input.from && input.to && input.from > input.to) return { results: [], total: 0, page: 1, pageSize: 30, summary: { total: 0, unlinked: 0, partial: 0, linked: 0 }, openingCountDay: count?.day };
  const source = input.source || 'order';
  const status = input.status || 'unlinked';
  if (!['all', 'order', 'direct'].includes(source) || !['all', 'unlinked', 'partial', 'linked'].includes(status)) throw fail('فلتر غير صالح');
  const day = { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) };
  const bills = await SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true },
    ...(Object.keys(day).length && { day }), ...(input.vendorId && { vendorId: input.vendorId }),
    ...(input.currency && { currency: input.currency }) }).populate('vendorId', 'name').populate('lines.orderId', 'orderId').lean();
  const billIds = bills.map(b => b._id);
  const payments = await SupplierPayment.find({ status: 'posted', 'allocations.billId': { $in: billIds } }).populate('fromAccountId', 'name code currency').lean();
  const entryIds = payments.map(p => p.entryId).filter(Boolean);
  const bankLines = await BankStatementLine.find({ lineStatus: { $in: active }, amount: { $lt: 0 }, $or: [
    { billId: { $in: billIds } }, { entryId: { $in: entryIds } }, { matchedEntryIds: { $in: entryIds } }, { purchaseItemId: { $exists: true } },
  ] }).populate('accountId', 'name code currency').lean();
  const rows = bills.map(b => {
    const paid = payments.filter(p => p.allocations.some(a => id(a.billId) === id(b)));
    const links = bankLines.filter(l => id(l.billId) === id(b) || paid.some(p => id(l.entryId) === id(p.entryId) || l.matchedEntryIds.some(e => id(e) === id(p.entryId))));
    const matchedPayments = paid.filter(p => links.some(l => id(l.entryId) === id(p.entryId) || l.matchedEntryIds.some(e => id(e) === id(p.entryId))));
    let matchedUsd = matchedPayments.reduce((sum, p) => sum + p.allocations.filter(a => id(a.billId) === id(b)).reduce((s, a) => s + a.amountUsd, 0), 0);
    // Metadata-only historical matches are already included in the opening balance.
    matchedUsd += links.filter(l => l.historicalCovered && !matchedPayments.some(p => id(l.entryId) === id(p.entryId) || l.matchedEntryIds.some(e => id(e) === id(p.entryId))))
      .reduce((sum, l) => sum + Math.round(b.totalUsd * (Number(l.matchedOriginalAmount) || amountOf(b)) / amountOf(b)), 0);
    const totalUsd = Number(b.totalUsd) || 0;
    const state = !links.length ? 'unlinked' : matchedUsd >= totalUsd && totalUsd > 0 ? 'linked' : 'partial';
    return { _id: `bill:${b._id}`, kind: 'bill', billId: b._id, number: b.number || 'مسودة', day: b.day, currency: b.currency,
      amount: amountOf(b), totalUsd, matchedUsd, remainingUsd: Math.max(0, totalUsd - matchedUsd), status: state, documentStatus: b.status,
      vendorId: b.vendorId?._id, vendorName: b.vendorId?.name, description: b.lines.map(l => l.description).join('، '),
      source: b.lines.some(l => l.orderId) ? 'order' : 'direct',
      orders: b.lines.filter(l => l.orderId).map(l => ({ _id: l.orderId._id, number: l.orderId.orderId })),
      links: links.map(l => ({ _id: l._id, account: l.accountId, day: l.day, description: l.description, amount: l.amount,
        originalAmount: l.originalAmount, originalCurrency: l.originalCurrency, entryId: l.entryId, historicalCovered: l.historicalCovered })),
      payments: paid.map(p => ({ _id: p._id, number: p.number, account: p.fromAccountId, day: p.day })), historical: !!count && b.day <= count.day };
  });
  if (source !== 'direct' && !input.vendorId) {
    const orders = await Order.find({ isCanceled: { $ne: true }, 'purchaseItems.0': { $exists: true } }).select('orderId purchaseItems').lean();
    const coverage = await SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true },
      $or: [{ 'lines.orderId': { $in: orders.map(o => o._id) } }, { idempotencyKey: { $in: orders.flatMap(o => (o.purchaseItems || []).map(i => `MIG:PURCH:${i._id}`)) } }] })
      .select('idempotencyKey currency lines').lean();
    // Stable migration keys take precedence. Amount-based attribution is accepted only
    // when there is exactly one item and one invoice line with that amount on the order.
    for (const order of orders) for (const item of order.purchaseItems || []) {
      const itemDay = item.date ? toDay(item.date) : '';
      const currency = item.currency || 'USD';
      if ((input.from && itemDay < input.from) || (input.to && itemDay > input.to) || (input.currency && currency !== input.currency)) continue;
      const linked = bankLines.filter(l => id(l.purchaseItemId) === id(item));
      const represented = coverage.some(b => b.idempotencyKey === `MIG:PURCH:${item._id}` || b.lines.some(l => id(l.purchaseItemId) === id(item)) || linked.some(l => id(l.billId) === id(b)));
      const sameItems = order.purchaseItems.filter(i => (i.currency || 'USD') === currency && Number(i.unitPrice) === Number(item.unitPrice));
      const sameBills = coverage.filter(b => b.currency === currency && b.lines.some(l => id(l.orderId) === id(order) && Number(l.amount) === Number(item.unitPrice)));
      if (represented || (sameItems.length === 1 && sameBills.length === 1)) continue;
      rows.push({ _id: `item:${item._id}`, kind: 'order_item', itemId: item._id, orderId: order._id, number: 'مشتريات الطلبية',
        day: itemDay, currency, amount: Number(item.unitPrice), description: item.description, source: 'order', documentStatus: 'unrecorded',
        status: linked.length ? 'linked' : 'unlinked', orders: [{ _id: order._id, number: order.orderId }],
        links: linked.map(l => ({ _id: l._id, day: l.day, account: l.accountId, amount: l.amount, description: l.description })), payments: [],
        ambiguous: sameBills.length > 0, historical: !!count && itemDay <= count.day });
    }
  }
  const search = input.q?.trim() ? new RegExp(escape(input.q.trim()), 'i') : null;
  const visible = rows.filter(r => (source === 'all' || r.source === source)
    && (!input.accountId || [...r.links, ...r.payments].some(l => id(l.account) === input.accountId))
    && (!search || search.test([r.number, r.vendorName, r.description, ...r.orders.map(o => o.number)].join(' '))));
  const summary = { total: visible.length, unlinked: 0, partial: 0, linked: 0 };
  visible.forEach(r => { summary[r.status]++; });
  const selected = visible.filter(r => status === 'all' || r.status === status).sort((a, b) => b.day.localeCompare(a.day) || a._id.localeCompare(b._id));
  const page = Math.max(1, parseInt(input.page, 10) || 1), pageSize = 30;
  return { results: selected.slice((page - 1) * pageSize, page * pageSize), total: selected.length, page, pageSize, summary,
    openingCountDay: count?.day, operationalStartDate: count?.endOfDay ? addDays(count.day, 1) : count?.day };
}

async function statementCandidates(input = {}) {
  filters(input);
  for (const key of ['billId', 'orderId', 'itemId']) if (input[key] && !mongoose.isValidObjectId(input[key])) throw fail('الفاتورة أو الطلبية غير صالحة');
  const row = input.billId ? await SupplierBill.findById(input.billId).lean() : null;
  const order = input.orderId && await Order.findById(input.orderId).select('purchaseItems').lean();
  const item = order?.purchaseItems.find(i => id(i) === input.itemId);
  if ((!row && !item) || (row && (!['draft', 'posted'].includes(row.status) || row.isCreditNote))) throw fail('اختر الفاتورة أو بند المشتريات المتاح');
  const currency = row?.currency || item.currency || 'USD', amount = row ? amountOf(row) : Number(item.unitPrice);
  const day = row?.day || (item.date && toDay(item.date));
  const lines = await BankStatementLine.find({ amount: { $lt: 0 }, $or: [{ lineStatus: 'unmatched' }, { historicalPurchase: true, lineStatus: 'created_entry' }],
    ...(input.accountId && { accountId: input.accountId }), ...(input.from || input.to ? { day: { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) } } : {}) })
    .populate('accountId', 'name code currency').lean();
  const merchantMatchers = new Map();
  for (const accountId of [...new Set(lines.map(l => id(l.accountId)))]) merchantMatchers.set(accountId, await require('./bankMerchants').matcher(accountId));
  const results = lines.map(l => {
    const original = originalOf(l, l.accountId.currency);
    const sameAmount = original.currency === currency && Math.abs(original.amount - amount) < 0.0005;
    const merchant = merchantMatchers.get(id(l.accountId))(l);
    const merchantMismatch = !!row && !!merchant && id(merchant.vendorId) !== id(row.vendorId);
    return { ...l, original, sameAmount, merchantMismatch, merchantMatch: !!row && !!merchant && !merchantMismatch,
      statementVendorName: merchant?.vendorName, canMatch: !merchantMismatch,
      daysApart: day ? Math.abs((Date.parse(l.day) - Date.parse(day)) / 86400000) : null,
      reasons: [...(sameAmount ? ['المبلغ والعملة الأصليان متطابقان'] : []), ...(l.day === day ? ['التاريخ متطابق'] : []),
        ...(row && merchant && !merchantMismatch ? ['المورد مطابق لتاجر الكشف'] : []),
        ...(l.historicalPurchase ? ['تكلفة تاريخية مسجلة؛ تُعكس عند ربطها بفاتورة مسجلة لمنع التكرار'] : [])] };
  }).filter(l => input.showAll === 'true' || (l.sameAmount && l.canMatch))
    .sort((a, b) => Number(b.sameAmount) - Number(a.sameAmount) || (a.daysApart ?? Infinity) - (b.daysApart ?? Infinity));
  const page = Math.max(1, parseInt(input.page, 10) || 1), pageSize = 30;
  return { results: results.slice((page - 1) * pageSize, page * pageSize), total: results.length, page, pageSize };
}

// Historical settlement is deliberately separate from live purchases. It records
// completed purchases at their original date against opening equity, never cash.
async function historicalContext(input, session) {
  filters(input);
  const { count } = await getConfig();
  const bank = input.accountId && await Account.findById(input.accountId).session(session || null).lean();
  if (!count || !bank?.isCash || !count.accountIds.has(id(bank))) throw fail('يلزم اعتماد جرد افتتاحي لهذا الحساب أولاً');
  return { count, bank };
}

async function historicalRows(input = {}, session) {
  const { count, bank } = await historicalContext(input, session);
  const query = { accountId: bank._id, lineStatus: 'unmatched', amount: { $lt: 0 }, day: { $lte: count.day,
    ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to < count.day ? input.to : count.day }) } };
  if (input.lineIds) {
    if (!Array.isArray(input.lineIds) || !input.lineIds.length || input.lineIds.length > 50 || input.lineIds.some(v => !mongoose.isValidObjectId(v)) || new Set(input.lineIds.map(String)).size !== input.lineIds.length) throw fail('اختر من 1 إلى 50 حركة دون تكرار');
    query._id = { $in: input.lineIds };
  }
  if (!count.endOfDay && query.day.$lte === count.day) query.day.$lte = addDays(count.day, -1);
  const page = Math.max(1, parseInt(input.page, 10) || 1);
  const total = await BankStatementLine.countDocuments(query).session(session || null);
  const lines = await BankStatementLine.find(query).sort({ day: 1, _id: 1 }).skip(input.lineIds ? 0 : (page - 1) * 50).limit(51).session(session || null).lean();
  if (input.lineIds && lines.length !== input.lineIds.length) throw fail('بعض الحركات غير متاحة أو بعد تاريخ الجرد');
  const bills = await SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true }, day: { $lte: count.day } }).session(session || null).lean();
  const orders = await Order.find({ isCanceled: { $ne: true }, 'purchaseItems.0': { $exists: true } }).select('orderId purchaseItems').session(session || null).lean();
  const classify = await require('./bankMerchants').matcher(bank._id, session);
  const rows = [];
  for (const line of lines.slice(0, 50)) {
    const original = originalOf(line, bank.currency);
    const candidates = bills.filter(b => b.currency === original.currency && Math.abs(amountOf(b) - original.amount) < 0.0005)
      .map(b => ({ kind: 'bill', _id: b._id, number: b.number, day: b.day }));
    const raw = orders.flatMap(o => (o.purchaseItems || []).filter(i => i.date && toDay(i.date) <= count.day && (i.currency || 'USD') === original.currency && Math.abs(Number(i.unitPrice) - original.amount) < 0.0005)
      .map(i => ({ kind: 'order_item', _id: i._id, number: o.orderId, day: toDay(i.date) })));
    const merchant = classify(line);
    let value, valuationError;
    try { value = await paymentValue(line, bank, {}, session); } catch (err) { valuationError = err.message; }
    rows.push({ ...line, original, vendorName: merchant?.vendorName, candidates: [...candidates, ...raw],
      eligible: !!merchant && !candidates.length && !raw.length && !!value, valuationError, valuationUsd: value && Math.round(value.usd * 100) });
  }
  return { results: rows, more: lines.length > 50, total, page, openingCountDay: count.day, bank };
}

async function settleHistorical(input, { session, req }) {
  if (!Array.isArray(input.lineIds) || !input.lineIds.length) throw fail('اختر الحركات المراد تسويتها');
  if (input.confirmCompleted !== true || !String(input.reason || '').trim()) throw fail('أكد أنها مشتريات مكتملة غير مسجلة، واكتب سبب التسوية');
  const report = await historicalRows(input, session);
  if (report.results.some(r => !r.eligible)) throw fail('توجد حركة غير معروفة كمشتريات أو تكلفة محتملة مسجلة أو سعر مفقود؛ راجعها قبل التسوية');
  const expense = await resolveAccount('cost_purchase_invoices'), opening = await resolveAccount('opening_balance');
  const office = input.office || report.bank.office;
  if (!(await getConfig()).offices.has(office)) throw fail('اختر المكتب');
  let totalUsd = 0;
  for (const row of report.results) {
    const line = await BankStatementLine.findById(row._id).session(session);
    const value = await paymentValue(line, report.bank, {}, session), usd = Math.round(value.usd * 100);
    const entry = await postEntry({ eventType: 'BANK_LINE', eventKey: `HIST_PURCHASE:${line._id}:${line.postingAttempt || 0}`,
      date: line.day, description: `تسوية مشتريات تاريخية - ${line.description}`,
      source: { model: 'AccountingBankStatementLine', id: line._id }, fallbacks: value.rates.fallbacks,
      notes: [input.reason.trim(), 'تكلفة مكتملة غير موزعة؛ السداد مشمول في الرصيد الافتتاحي، ولا حركة جديدة على البنك'],
      lines: [{ accountId: expense._id, debit: usd, office, label: line.description }, { accountId: opening._id, credit: usd, office, label: 'سداد قبل الجرد' }],
    }, { session, user: req?.user, onLocked: 'reject' });
    await value.rates.lock();
    Object.assign(line, { entryId: entry._id, lineStatus: 'created_entry', historicalPurchase: true, movementKind: 'purchase', valuationUsd: value.usd,
      valuationSource: value.valuationSource, crossRate: value.crossRate, rateBaseCurrency: value.baseCurrency, rateQuoteCurrency: value.quoteCurrency });
    await line.save({ session }); totalUsd += usd;
    await logAudit({ req, action: 'bank.historicalPurchase', model: 'AccountingBankStatementLine', docId: line._id, after: { reason: input.reason, entryId: entry._id } }, session);
  }
  return { posted: report.results.length, totalUsd, bankChanged: false };
}

module.exports = { list, statementCandidates, historicalRows, settleHistorical };
