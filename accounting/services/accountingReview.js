const mongoose = require('mongoose');
const { JournalEntry, AccountingSettings, AccountingEvent } = require('../models');
const { SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const { ReviewTask, CostReview, TripCostReview, PeriodApproval, BankMonthReview } = require('../models/review');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');
const User = require('../../models/user');
const { getConfig } = require('./config');
const { isDay, addDays, today, toDay } = require('./dates');
const { roleIds } = require('./reports/operations');
const { hash, amount } = require('./costDuplicates');
const { fail } = require('./posting/common');
const { logAudit } = require('./audit');
const { lockPeriod } = require('./periodLock');
const id = value => String(value?._id || value || '');
const reference = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();

async function bankSnapshot(accountId, month, { session } = {}) {
  const account = (await getConfig()).accountsById.get(String(accountId));
  if (!account?.isCash || !['bank', 'ewallet'].includes(account.cashKind)) throw fail('اختر حساب بنك أو محفظة إلكترونية');
  const end = require('./posting/schedules').monthEnd(month);
  const entries = await JournalEntry.find({ day: { $lte: end }, 'lines.accountId': account._id }).sort({ _id: 1 }).select('_id day lines').session(session || null).lean();
  const foreign = account.currency && account.currency !== 'USD';
  let balance = 0;
  const values = entries.map(e => {
    const lines = e.lines.filter(l => id(l.accountId) === String(accountId));
    balance += lines.reduce((sum, l) => sum + (foreign ? Number(l.amountCurrency || 0) : (l.debit || 0) - (l.credit || 0)), 0);
    return [id(e), e.day, lines];
  });
  return { account, balance, end, fingerprint: hash(values) };
}

async function certifyBank(input, { session, req }) {
  if (!mongoose.isValidObjectId(input.accountId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw fail('الحساب أو الشهر غير صالح');
  await lockPeriod(session);
  const snapshot = await bankSnapshot(input.accountId, input.month, { session });
  if (snapshot.end >= today()) throw fail('راجع الرصيد الختامي بعد نهاية الشهر');
  const currency = snapshot.account.currency || 'USD';
  const actual = await require('./posting/common').toCurrencyMinor(Math.abs(Number(input.balance)), currency);
  if (!Number.isFinite(Number(input.balance)) || !['available', 'owed'].includes(input.nature)) throw fail('أدخل الرصيد الختامي ونوعه');
  const signed = input.nature === 'owed' ? -actual : actual;
  if (signed !== snapshot.balance) throw fail(`رصيد الكشف لا يساوي رصيد الدفاتر. راجع الرصيد الافتتاحي والحركات الناقصة أو المكررة قبل الاعتماد؛ الفرق ${(signed - snapshot.balance) / 10 ** (await require('./posting/common').decimalsOf(currency))} ${currency}`);
  await BankMonthReview.updateOne({ key: `${input.accountId}:${input.month}` }, { $set: { accountId: input.accountId, month: input.month, statementBalance: signed,
    fingerprint: snapshot.fingerprint, note: String(input.note || '').trim(), reviewedBy: req?.user?._id, reviewedAt: new Date() } }, { upsert: true, session });
  await logAudit({ req, action: 'bankMonth.complete', model: 'AccountingBankMonthReview', after: { ...input, statementBalance: signed } }, session);
  return { complete: true };
}

async function range(input = {}) {
  const { count } = await getConfig();
  const start = count && (count.endOfDay ? addDays(count.day, 1) : count.day);
  const from = input.from || start || undefined, to = input.to || today();
  if ((from && !isDay(from)) || !isDay(to) || (from && from > to)) throw fail('فترة المراجعة غير صالحة');
  return { from, to, start };
}

// Every certificate is tied to the actual cost documents and ledger movements, not just a checkbox.
function buildOrderSnapshot(order, bills, entries, roles) {
  let cost = 0;
  for (const entry of entries) for (const line of entry.lines) if (id(line.orderId) === id(order) && Object.values(roles).includes(id(line.accountId))) cost += (line.debit || 0) - (line.credit || 0);
  const uncovered = (order.purchaseItems || []).filter(item => !bills.some(b => b.status === 'posted' && !b.isCreditNote && (b.idempotencyKey === 'MIG:PURCH:' + item._id
    || b.lines.some(l => id(l.purchaseItemId) === id(item))
    || ((order.purchaseItems || []).filter(i => (i.currency || 'USD') === (item.currency || 'USD') && Number(i.unitPrice) === Number(item.unitPrice)).length === 1
      && bills.filter(other => other.status === 'posted' && !other.isCreditNote && other.currency === (item.currency || 'USD')
        && other.lines.some(l => id(l.orderId) === id(order) && Number(l.amount) === Number(item.unitPrice))).length === 1))));
  return { order, bills, entries, cost, uncovered, fingerprint: hash([order.purchaseItems || [], order.isCanceled,
    bills.map(b => [id(b), b.status, b.lines, b.totalUsd, b.alipayValuationAdjustmentUsd, b.alipayValuationProvisional]), entries]) };
}
async function orderSnapshots(orderIds, { session } = {}) {
  const ids = [...new Set(orderIds.map(String))];
  const orders = await Order.find({ _id: { $in: ids } }).select('orderId purchaseItems isCanceled').session(session || null).lean();
  const bills = await SupplierBill.find({ 'lines.orderId': { $in: ids } }).sort({ _id: 1 }).session(session || null).lean();
  const entries = await JournalEntry.find({ 'lines.orderId': { $in: ids } }).sort({ _id: 1 }).select('_id day lines reversalOf reversedBy').session(session || null).lean();
  const roles = await roleIds(['cost_purchase_invoices', 'purchase_cost_wip', 'cost_remittance']);
  const billMap = new Map(), entryMap = new Map();
  for (const bill of bills) for (const orderId of new Set(bill.lines.map(l => id(l.orderId)).filter(Boolean))) { if (!billMap.has(orderId)) billMap.set(orderId, []); billMap.get(orderId).push(bill); }
  for (const entry of entries) for (const orderId of new Set(entry.lines.map(l => id(l.orderId)).filter(Boolean))) { if (!entryMap.has(orderId)) entryMap.set(orderId, []); entryMap.get(orderId).push(entry); }
  return new Map(orders.map(order => [id(order), buildOrderSnapshot(order, billMap.get(id(order)) || [], entryMap.get(id(order)) || [], roles)]));
}
async function orderSnapshot(orderId, options = {}) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلبية غير صالحة');
  const snapshot = (await orderSnapshots([orderId], options)).get(String(orderId));
  if (!snapshot) throw fail('الطلبية غير موجودة');
  return snapshot;
}

async function certifyCost(orderId, input, { session, req }) {
  await lockPeriod(session);
  const snapshot = await orderSnapshot(orderId, { session });
  if (snapshot.uncovered.length || snapshot.bills.some(b => b.status === 'draft' || (b.status === 'posted' && b.alipayValuationProvisional))) throw fail('أكمل ترحيل المشتريات والتقييم المؤقت قبل تأكيد اكتمال التكلفة');
  const zeroCost = snapshot.cost <= 0;
  if (snapshot.cost < 0) throw fail('التكلفة سالبة؛ عالج الاستردادات أو التوزيع قبل تأكيد اكتمالها');
  if (zeroCost && (!input.zeroCost || String(input.reason || '').trim().length < 10)) throw fail('الطلبية بلا تكلفة موجبة: اذكر سبباً واضحاً لتأكيد أن ذلك صحيح');
  await CostReview.updateOne({ orderId }, { $set: { fingerprint: snapshot.fingerprint, zeroCost,
    reason: String(input.reason || '').trim(), reviewedBy: req?.user?._id, reviewedAt: new Date() } }, { upsert: true, session });
  await logAudit({ req, action: 'cost.complete', model: 'AccountingCostReview', after: { orderId, zeroCost, reason: input.reason } }, session);
  return { complete: true };
}

async function tripSnapshots(tripIds, { session } = {}) {
  const ids = [...new Set(tripIds.map(String))];
  const trips = await Inventory.find({ _id: { $in: ids }, inventoryType: 'inventoryGoods' }).select('voyage expenses').session(session || null).lean();
  const bills = await SupplierBill.find({ 'lines.tripId': { $in: ids } }).sort({ _id: 1 }).session(session || null).lean();
  const entries = await JournalEntry.find({ 'lines.tripId': { $in: ids } }).sort({ _id: 1 }).select('_id day lines reversalOf reversedBy').session(session || null).lean();
  const roles = await roleIds(['trip_cost_wip', 'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic', 'cost_purchase_invoices']);
  return new Map(trips.map(trip => {
    const ownBills = bills.filter(b => b.lines.some(l => id(l.tripId) === id(trip))), ownEntries = entries.filter(e => e.lines.some(l => id(l.tripId) === id(trip)));
    let cost = 0;
    for (const entry of ownEntries) for (const line of entry.lines) if (id(line.tripId) === id(trip) && Object.values(roles).includes(id(line.accountId))) cost += (line.debit || 0) - (line.credit || 0);
    return [id(trip), { trip, bills: ownBills, cost, fingerprint: hash([trip.expenses || [], ownBills.map(b => [id(b), b.status, b.lines, b.totalUsd]), ownEntries]) }];
  }));
}

async function certifyTrip(tripId, input, { session, req }) {
  if (!mongoose.isValidObjectId(tripId)) throw fail('الرحلة غير صالحة');
  await lockPeriod(session);
  const snapshot = (await tripSnapshots([tripId], { session })).get(String(tripId));
  if (!snapshot) throw fail('الرحلة غير موجودة');
  if (snapshot.cost < 0) throw fail('تكلفة الرحلة سالبة؛ صححها قبل الاعتماد');
  if (snapshot.bills.some(b => b.status === 'draft')) throw fail('رحّل فواتير الرحلة أولاً');
  if (snapshot.cost <= 0 && (!input.zeroCost || String(input.reason || '').trim().length < 10)) throw fail('اذكر سبب صحة عدم وجود تكلفة للرحلة');
  await TripCostReview.updateOne({ tripId }, { $set: { fingerprint: snapshot.fingerprint, zeroCost: snapshot.cost <= 0, reason: input.reason || '', reviewedBy: req?.user?._id, reviewedAt: new Date() } }, { upsert: true, session });
  await logAudit({ req, action: 'tripCost.complete', model: 'AccountingTripCostReview', after: { tripId, reason: input.reason } }, session);
  return { complete: true };
}

async function queue(input = {}, { session } = {}) {
  const period = await range(input);
  const day = { ...(period.from && { $gte: period.from }), $lte: period.to };
  const bills = await SupplierBill.find({ day, status: { $in: ['draft', 'posted'] } }).sort({ _id: 1 }).populate('vendorId', 'name').session(session || null).lean();
  const bank = await BankStatementLine.find({ day }).sort({ _id: 1 }).populate('accountId', 'name currency code').session(session || null).lean();
  const payments = await SupplierPayment.find({ status: 'posted', day }).session(session || null).lean();
  const matchedLines = await BankStatementLine.find({ lineStatus: { $in: ['matched', 'created_entry'] }, day: { $lte: period.to },
    $or: [{ entryId: { $in: payments.map(p => p.entryId) } }, { matchedEntryIds: { $in: payments.map(p => p.entryId) } }] }).session(session || null).lean();
  const entries = await JournalEntry.find({ day }).sort({ _id: 1 }).select('_id day lines eventType reversalOf reversedBy').session(session || null).lean();
  const events = await AccountingEvent.find({ status: { $in: ['pending', 'failed'] } }).select('_id status eventType lastError').session(session || null).lean();
  const reviews = await CostReview.find({}).sort({ orderId: 1 }).session(session || null).lean();
  const tripReviews = await TripCostReview.find({}).sort({ tripId: 1 }).session(session || null).lean();
  const bankReviews = await BankMonthReview.find({}).sort({ key: 1 }).session(session || null).lean();
  const roles = await roleIds(['revenue_purchase_invoices', 'revenue_remittance', 'cost_purchase_invoices', 'purchase_cost_wip', 'migration_suspense']);
  const items = [];
  const add = item => items.push({ severity: 'warn', blocking: true, ...item, fingerprint: hash(item) });
  if (period.from) {
    const months = require('./posting/schedules').monthsBetween(period.from.slice(0, 7), period.to.slice(0, 7));
    const accounts = [...(await getConfig()).accountsById.values()].filter(a => a.isCash && a.isActive && ['bank', 'ewallet'].includes(a.cashKind));
    for (const month of months) {
      const end = require('./posting/schedules').monthEnd(month);
      if (end > period.to || end >= today()) continue;
      for (const account of accounts) {
        const snapshot = await bankSnapshot(account._id, month, { session });
        const hasMovement = entries.some(e => e.day.startsWith(month) && e.lines.some(l => id(l.accountId) === id(account)));
        if (!snapshot.balance && !hasMovement) continue;
        const certification = bankReviews.find(r => id(r.accountId) === id(account) && r.month === month);
        if (certification?.fingerprint === snapshot.fingerprint && certification.statementBalance === snapshot.balance) continue;
        add({ key: `bankClosing:${account._id}:${month}`, category: 'bank', title: 'الرصيد الختامي لم يُراجع مقابل الكشف',
          description: `${account.name} · ${month}`, accountId: account._id, month, currency: account.currency || 'USD',
          bookBalance: snapshot.balance, accountType: account.type, url: `/accounting/bank?accountId=${account._id}`, snapshot: snapshot.fingerprint });
      }
    }
  }
  for (const line of bank) {
    if (line.lineStatus === 'unmatched') add({ key: `bank:${line._id}`, category: 'bank', title: 'حركة كشف لم تُطابق أو تُرحّل', day: line.day,
      description: line.description, amount: line.amount, currency: line.accountId?.currency, account: line.accountId?.name,
      url: `/accounting/bank?accountId=${id(line.accountId)}`, snapshot: [line.updatedAt, line.originalAmount, line.originalCurrency] });
    if (line.movementKind === 'purchase_refund' && !line.orderId && !line.billId && line.lineStatus !== 'ignored') add({ key: `refund:${line._id}`, category: 'refund', title: 'استرداد مشتريات ينتظر تحديد أصله',
      day: line.day, description: line.description, url: `/accounting/bank?accountId=${id(line.accountId)}` });
    if (line.lineStatus === 'ignored') add({ key: `ignored:${line._id}`, category: 'bank', title: 'حركة كشف متجاهلة تحتاج تفسيراً', day: line.day,
      description: line.description, url: `/accounting/bank?accountId=${id(line.accountId)}`, blocking: false });
  }
  const active = bills.filter(b => b.status === 'posted' && !b.isCreditNote);
  const groups = new Map();
  for (const bill of active) {
    const key = [id(bill.vendorId), bill.currency, amount(bill)].join('|');
    const siblings = groups.get(key) || [];
    for (const other of siblings) {
      if (Math.abs(new Date(bill.day) - new Date(other.day)) > 7 * 86400000) continue;
      const pair = [id(bill), id(other)].sort();
      add({ key: `duplicate:${pair.join(':')}`, category: 'duplicate', title: 'فاتورتان قد تمثلان نفس التكلفة', day: bill.day,
        description: `${other.number} / ${bill.number} · ${bill.vendorId?.name || ''} · ${amount(bill)} ${bill.currency}`,
        url: `/accounting/bills/${bill._id}`, otherUrl: `/accounting/bills/${other._id}`, snapshot: [bill.lines, other.lines, bill.vendorRef, other.vendorRef],
        reason: 'نفس المورد والمبلغ والعملة وتاريخ قريب', canConfirmIndependent: !require('./costDuplicates').invoiceReference(bill) || !require('./costDuplicates').invoiceReference(other)
          || reference(bill.vendorRef) !== reference(other.vendorRef) || !reference(bill.vendorRef) });
    }
    siblings.push(bill); groups.set(key, siblings);
  }
  for (const bill of bills) {
    if (bill.status === 'draft') add({ key: `draft:${bill._id}`, category: 'cost', title: 'فاتورة مورد لم تُرحّل', day: bill.day,
      description: bill.vendorId?.name, url: `/accounting/bills/${bill._id}` });
    if (bill.alipayValuationProvisional && bill.status === 'posted') add({ key: `valuation:${bill._id}`, category: 'cost', title: 'تكلفة Alipay بتقييم مؤقت', day: bill.day,
      description: bill.number, url: `/accounting/alipay`, snapshot: [bill.totalUsd, bill.alipayValuationAdjustmentUsd] });
    const paid = payments.filter(p => p.allocations.some(a => id(a.billId) === id(bill)));
    for (const payment of paid) {
      const linked = matchedLines.some(l => ['matched', 'created_entry'].includes(l.lineStatus)
        && (id(l.entryId) === id(payment.entryId) || (l.matchedEntryIds || []).some(e => id(e) === id(payment.entryId))));
      if (linked || !payment.fromAccountId) continue;
      // A cash payment is legitimate without a bank statement. Only statement-backed accounts need this review.
      const account = (await getConfig()).accountsById.get(id(payment.fromAccountId));
      if (!account?.isCash || !['bank', 'ewallet'].includes(account.cashKind)) continue;
      add({ key: `payment:${payment._id}`, category: 'purchase', title: 'سداد مورد غير مربوط بكشف', day: payment.day,
        description: `${bill.number} · ${bill.vendorId?.name || ''}`, url: '/accounting/purchase-reconciliation', snapshot: [payment.allocations, payment.entryId] });
    }
  }
  const rawOrders = await Order.find({ isCanceled: { $ne: true }, 'purchaseItems.0': { $exists: true } }).select('orderId purchaseItems').session(session || null).lean();
  const orderIds = [...new Set(entries.flatMap(e => e.lines.filter(l => [roles.revenue_purchase_invoices, roles.revenue_remittance].includes(id(l.accountId)) && (l.credit || 0) > (l.debit || 0)).map(l => id(l.orderId))).filter(mongoose.isValidObjectId))];
  const rawIds = rawOrders.filter(o => o.purchaseItems.some(item => item.date && (!period.from || toDay(item.date) >= period.from) && toDay(item.date) <= period.to)).map(o => id(o));
  const snapshots = await orderSnapshots([...orderIds, ...rawIds], { session });
  for (const order of rawOrders) for (const item of order.purchaseItems || []) {
    const itemDay = item.date && toDay(item.date);
    if (!itemDay || (period.from && itemDay < period.from) || itemDay > period.to) continue;
    const snapshot = snapshots.get(id(order));
    if (snapshot.uncovered.some(i => id(i) === id(item))) add({ key: `unrecorded:${item._id}`, category: 'cost', title: 'مشتريات داخل الطلبية لم تُرحّل كفاتورة مورد',
      day: itemDay, description: `${order.orderId} · ${item.description} · ${item.unitPrice} ${item.currency || 'USD'}`, url: `/invoice/${order._id}/edit`, snapshot: item });
  }
  for (const orderId of orderIds) {
    const snapshot = snapshots.get(orderId);
    if (!snapshot || snapshot.order.isCanceled) continue;
    const certificate = reviews.find(r => id(r.orderId) === orderId);
    const complete = certificate?.fingerprint === snapshot.fingerprint;
    if (!complete) add({ key: `cost:${orderId}`, category: 'cost', severity: snapshot.cost <= 0 ? 'error' : 'warn', title: snapshot.cost <= 0 ? 'طلبية بإيراد دون تكلفة مؤكدة' : 'اكتمال تكلفة الطلبية لم يُراجع',
      description: `${snapshot.order.orderId} · التكلفة المسجلة ${(snapshot.cost / 100).toFixed(2)} USD · مشتريات غير مرحلة ${snapshot.uncovered.length}`,
      orderId, zeroCost: snapshot.cost <= 0, url: `/invoice/${orderId}/edit`, snapshot: snapshot.fingerprint });
  }
  const shipmentRoles = await roleIds(['revenue_shipping_air', 'revenue_shipping_sea', 'revenue_shipping_domestic']);
  const packageIds = entries.flatMap(e => e.lines.filter(l => Object.values(shipmentRoles).includes(id(l.accountId)) && (l.credit || 0) > (l.debit || 0)).map(l => l.packageId)).filter(Boolean);
  const shipmentOrders = await Order.find({ 'paymentList._id': { $in: packageIds } }).select('paymentList._id paymentList.tripId paymentList.domesticTripId').session(session || null).lean();
  const packages = shipmentOrders.flatMap(o => o.paymentList).filter(p => packageIds.some(i => id(i) === id(p)));
  const tripIds = [...new Set(packages.flatMap(p => [id(p.tripId), id(p.domesticTripId)]).filter(mongoose.isValidObjectId))];
  const tripCosts = await tripSnapshots(tripIds, { session });
  for (const [tripId, snapshot] of tripCosts) {
    const certificate = tripReviews.find(r => id(r.tripId) === tripId);
    if (certificate?.fingerprint !== snapshot.fingerprint) add({ key: `tripCost:${tripId}`, category: 'cost', title: snapshot.cost <= 0 ? 'رحلة بإيراد دون تكلفة مؤكدة' : 'اكتمال تكلفة الرحلة لم يُراجع',
      description: `${snapshot.trip.voyage} · التكلفة المسجلة ${(snapshot.cost / 100).toFixed(2)} USD`, tripId, zeroCost: snapshot.cost <= 0,
      url: '/accounting/trips', snapshot: snapshot.fingerprint, severity: snapshot.cost <= 0 ? 'error' : 'warn' });
  }
  const funder = [...(await getConfig()).accountsById.values()].find(a => a.seedKey === 'funding:yusuf:TRY');
  if (funder) {
    const balance = await require('./carrying').getBalance(funder._id, { session, upToDay: period.to });
    if (balance.foreign > 0) add({ key: `funder:${funder._id}:${period.to}`, category: 'purchase', severity: 'error', title: 'سداد يوسف أكبر من المشتريات أو الدين المسجل عليه',
      description: `راجع تمويل المشتريات أو رصيده الافتتاحي؛ الجاري مدين بمبلغ ${(balance.foreign / 100).toFixed(2)} TRY. لا تسجل سداد البنك كتكلفة ثانية.`,
      url: `/accounting/accounts/${funder._id}`, snapshot: balance });
  }
  const turkeyCash = [...(await getConfig()).accountsById.values()].filter(a => a.isActive && a.isCash && a.cashKind === 'cash' && a.office === 'turkey' && !a.subBox);
  for (const account of turkeyCash) {
    const balance = await require('./carrying').getBalance(account._id, { session, upToDay: period.to });
    const native = !account.currency || account.currency === 'USD' ? balance.usd : balance.foreign;
    if (native < 0) add({ key: `cashSource:${account._id}:${period.to}`, category: 'posting', severity: 'error', title: 'مصدر الإيداع النقدي يحتاج تسوية',
      description: `${account.name}: رصيد سالب؛ راجع الرصيد الافتتاحي وسحب دولار المتحدة والصرف بالمبلغين الفعليين قبل اعتماد الأرصدة. الإيداع لا يثبت عملية الصرف بمفرده.`,
      url: `/accounting/accounts/${account._id}`, snapshot: balance });
  }
  for (const event of events) add({ key: `event:${event._id}`, category: 'posting', severity: 'error', title: 'عملية محاسبية تنتظر الترحيل أو فشلت',
    description: event.eventType, url: '/accounting/settings?tab=live', snapshot: [event.status, event.lastError] });
  const checks = await require('./reports/exceptions').runChecks();
  for (const check of checks.results.filter(c => c.severity === 'error' && c.count)) add({ key: `check:${check.key}`, category: 'integrity', severity: 'error',
    title: check.title, description: `${check.count} حالة · ${check.hint || ''}`, url: check.link || '/accounting/exceptions', snapshot: [check.count, check.items] });
  const [suspenseRow] = await JournalEntry.aggregate([
    { $match: { day: { $lte: period.to } } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': roles.migration_suspense ? new mongoose.Types.ObjectId(roles.migration_suspense) : null } },
    { $group: { _id: null, amount: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]).session(session || null);
  const suspense = suspenseRow?.amount || 0;
  if (suspense) add({ key: `suspense:${period.from || ''}:${period.to}`, category: 'suspense', severity: 'error', title: 'حركات معلّقة لم تُسوَّ',
    description: `${(suspense / 100).toFixed(2)} USD`, url: '/accounting/suspense', snapshot: suspense });
  const dispositions = await ReviewTask.find({ key: { $in: items.map(i => i.key) } }).populate('assignee', 'firstName lastName').session(session || null).lean();
  for (const item of items) {
    const state = dispositions.find(d => d.key === item.key && d.fingerprint === item.fingerprint);
    item.state = state?.state || 'open'; item.reason = state?.reason || item.reason; item.assignee = state?.assignee; item.dueDay = state?.dueDay;
    if (item.category === 'duplicate' && item.canConfirmIndependent && item.state === 'independent') item.blocking = false;
  }
  const financialFingerprint = hash([period, entries, bills.map(b => [id(b), b.status, b.lines, b.totalUsd, b.alipayValuationProvisional]),
    bank.map(l => [id(l), l.lineStatus, l.amount, l.originalAmount, l.originalCurrency, l.entryId, l.matchedEntryIds]), reviews.filter(r => orderIds.includes(id(r.orderId))).map(r => [id(r.orderId), r.fingerprint, r.zeroCost]),
    tripReviews.filter(r => tripIds.includes(id(r.tripId))).map(r => [id(r.tripId), r.fingerprint]),
    bankReviews.filter(r => r.month >= (period.from || '').slice(0, 7) && r.month <= period.to.slice(0, 7)).map(r => [r.key, r.fingerprint, r.statementBalance]), items.map(i => [i.key, i.fingerprint, i.state])]);
  const blockers = items.filter(i => i.blocking);
  let visible = items.filter(i => (!input.category || input.category === 'all' || i.category === input.category)
    && (!input.state || input.state === 'all' || i.state === input.state)
    && (!input.q || [i.title, i.description].join(' ').toLowerCase().includes(String(input.q).toLowerCase())));
  visible.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || (a.day || '').localeCompare(b.day || ''));
  const page = Math.max(1, Number(input.page) || 1), limit = 40;
  return { results: visible.slice((page - 1) * limit, page * limit), total: visible.length, page, limit,
    summary: { total: items.length, blocking: blockers.length, errors: items.filter(i => i.severity === 'error').length, deferred: items.filter(i => i.state === 'deferred').length },
    period, fingerprint: financialFingerprint, allItems: items };
}

async function updateTask(input, { session, req }) {
  await lockPeriod(session);
  const report = await queue({ from: input.from, to: input.to }, { session });
  const item = report.allItems.find(i => i.key === input.key);
  if (!item || item.fingerprint !== input.fingerprint) throw fail('تغيرت بيانات البند؛ حدّث قائمة المراجعة');
  if (!['open', 'deferred', 'independent'].includes(input.state)) throw fail('حالة المراجعة غير صالحة');
  if (input.state !== 'open' && String(input.reason || '').trim().length < 10) throw fail('اذكر سبباً واضحاً لا يقل عن 10 أحرف');
  if (input.state === 'independent' && (item.category !== 'duplicate' || !item.canConfirmIndependent)) throw fail('هذا البند لا يُغلق بمجرد تأكيد المراجعة؛ صحح مصدره أولاً');
  if (input.dueDay && !isDay(input.dueDay)) throw fail('تاريخ المتابعة غير صالح');
  if (input.assignee && (!mongoose.isValidObjectId(input.assignee) || !await User.exists({ _id: input.assignee }).session(session))) throw fail('المسؤول غير موجود');
  await ReviewTask.updateOne({ key: item.key }, { $set: { fingerprint: item.fingerprint, state: input.state, reason: String(input.reason || '').trim(),
    assignee: input.assignee || null, dueDay: input.dueDay || null, updatedBy: req?.user?._id } }, { upsert: true, session });
  await logAudit({ req, action: 'review.update', model: 'AccountingReviewTask', after: input }, session);
  return { success: true };
}

async function approvalStatus(input = {}, { session } = {}) {
  const report = await queue(input, { session });
  const from = report.period.from, to = report.period.to;
  const exactMonth = from?.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)
    && addDays(to, 1).slice(0, 7) !== to.slice(0, 7);
  const approval = exactMonth && await PeriodApproval.findOne({ month: from.slice(0, 7) }).session(session || null).lean();
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session || null).lean();
  let approved = !!approval && approval.fingerprint === report.fingerprint && report.summary.blocking === 0 && settings?.lockDate >= to;
  // A complete quarter/year is approved only when every constituent month still passes its snapshot.
  if (!exactMonth && from?.endsWith('-01') && addDays(to, 1).endsWith('-01') && report.summary.blocking === 0 && settings?.lockDate >= to) {
    const months = require('./posting/schedules').monthsBetween(from.slice(0, 7), to.slice(0, 7));
    if (months.length <= 24) {
      const records = await PeriodApproval.find({ month: { $in: months } }).session(session || null).lean();
      if (records.length === months.length) {
        approved = true;
        for (const month of months) {
          const part = await queue({ from: `${month}-01`, to: require('./posting/schedules').monthEnd(month) }, { session });
          if (records.find(r => r.month === month)?.fingerprint !== part.fingerprint || part.summary.blocking) { approved = false; break; }
        }
      }
    }
  }
  return { status: approved ? 'approved' : 'provisional', blocking: report.summary.blocking, approvedAt: approved ? approval.approvedAt : null,
    changedSinceApproval: !!approval && !approved, fingerprint: report.fingerprint, period: report.period };
}

async function approveMonth(month, { session, req }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('الشهر غير صالح');
  await lockPeriod(session);
  const to = require('./posting/schedules').monthEnd(month), from = `${month}-01`;
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session).lean();
  if (!settings?.lockDate || settings.lockDate < to || to >= today()) throw fail('أقفل إدخال الشهر المنتهي قبل اعتماد الحسابات');
  const report = await queue({ from, to }, { session });
  if (report.summary.blocking) throw fail(`لا يمكن اعتماد الحسابات: ${report.summary.blocking} بنداً يحتاج معالجة في قائمة المراجعة`);
  const checklist = await require('./closing').monthChecklist(month, { session });
  const incomplete = checklist.items.filter(i => !i.ok);
  if (incomplete.length) throw fail(`أكمل فحوص الإقفال: ${incomplete.map(i => i.title).join('، ')}`);
  await PeriodApproval.updateOne({ month }, { $set: { fingerprint: report.fingerprint, approvedBy: req?.user?._id, approvedAt: new Date() } }, { upsert: true, session });
  await logAudit({ req, action: 'period.approve', model: 'AccountingPeriodApproval', after: { month, fingerprint: report.fingerprint } }, session);
  return { approved: true, month };
}
module.exports = { queue, certifyCost, certifyTrip, certifyBank, orderSnapshot, updateTask, approvalStatus, approveMonth };
