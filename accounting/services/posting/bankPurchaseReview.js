const mongoose = require('mongoose');
const { Account, JournalEntry } = require('../../models');
const { SupplierBill, SupplierPayment, BankStatementLine } = require('../../models/documents');
const Order = require('../../../models/order');
const { originalOf } = require('./bankAmounts');
const { isDay, addDays, toDay, dayStart } = require('../dates');
const { fail } = require('./common');
const { getConfig } = require('../config');
const { assertDirection, assertMerchant } = require('./bankMatchValidation');
const amountOf = bill => bill.total ?? bill.lines.reduce((s, l) => s + Number(l.amount), 0);
const distance = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const escaped = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validateChoice(line, bank, chosen, confirmed) {
  const original = originalOf(line, bank.currency);
  const known = !!line.originalCurrency || original.currency !== bank.currency || chosen.currency === bank.currency;
  if (known && original.currency !== chosen.currency) throw fail('عملة المشتريات المختارة تختلف عن العملة الأصلية في الكشف');
  const differentAmount = known && Math.abs(original.amount - chosen.amount) > 0.0005;
  const differentDay = distance(line.day, chosen.day) > 7;
  if ((differentAmount || differentDay) && !confirmed) throw fail('المبلغ الأصلي أو التاريخ مختلف؛ راجع التفاصيل وأكد الاختلاف قبل المطابقة');
  return { differentAmount, differentDay };
}

async function listPurchases(input = {}) {
  const { from, to, source = 'all', q = '', status = 'open' } = input;
  if ((from && !isDay(from)) || (to && !isDay(to)) || (from && to && from > to)) throw fail('فترة البحث غير صالحة');
  if (!['all', 'direct', 'order'].includes(source) || !['all', 'open'].includes(status)) throw fail('فلتر المشتريات غير صالح');
  const day = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const line = input.lineId && mongoose.isValidObjectId(input.lineId) ? await BankStatementLine.findById(input.lineId).lean() : null;
  const bank = input.accountId && mongoose.isValidObjectId(input.accountId) ? await Account.findById(input.accountId).lean() : null;
  if (!bank?.isCash || !bank.isActive) throw fail('اختر حساب البنك');
  if (line && String(line.accountId) !== String(bank._id)) throw fail('سطر الكشف من حساب آخر');
  const { currencies } = await getConfig();
  const decimals = currencies.get(bank.currency)?.decimals ?? 2;
  if (input.lineId && !line) throw fail('سطر الكشف غير موجود');
  const context = line || { amount: Math.round(Number(input.statementAmount ?? -Math.abs(Number(input.paid) || 0)) * 10 ** decimals),
    originalAmount: Number(input.originalAmount), originalCurrency: input.originalCurrency, description: input.description };
  if (context.amount) assertDirection(context, false);
  const merchant = (await require('./bankMerchants').matcher(bank._id))(context);
  const original = originalOf(context, bank.currency, decimals);
  const limit = 1000;
  const bills = await SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true },
    ...(from || to ? { day } : {}), ...(source === 'direct' ? { 'lines.orderId': null } : source === 'order' ? { 'lines.orderId': { $ne: null } } : {}) })
    .sort({ day: -1, _id: 1 }).limit(limit + 1).populate('vendorId', 'name').populate('lines.orderId', 'orderId').lean();
  const keys = bills.map(b => `BILL:${b._id}`);
  const balances = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $match: { 'lines.apKey': { $in: keys } } },
    { $group: { _id: '$lines.apKey', value: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } }]);
  const openByKey = new Map(balances.map(b => [b._id, b.value]));
  const rows = bills.slice(0, limit).map(b => {
    const merchantMismatch = !!merchant && String(merchant.vendorId) !== String(b.vendorId?._id);
    const orders = b.lines.filter(l => l.orderId).map(l => ({ _id: l.orderId._id, number: l.orderId.orderId, description: l.description }));
    const open = b.status === 'draft' ? null : openByKey.get(`BILL:${b._id}`) || 0;
    return { _id: `bill:${b._id}`, kind: 'bill', billId: b._id, source: orders.length ? 'order' : 'direct', number: b.number || 'مسودة',
      day: b.day, amount: amountOf(b), currency: b.currency, vendorName: b.vendorId?.name, description: b.lines.map(l => l.description).join('، '), orders,
      merchantMismatch, merchantMatch: !!merchant && !merchantMismatch, statementVendorName: merchant?.vendorName,
      matchProblems: merchantMismatch ? ['المورد مختلف عن تاجر الكشف'] : [],
      status: b.status === 'draft' ? 'draft' : open > 0 ? 'open' : 'paid', openUsd: open === null ? null : open / 100, canMatch: !merchantMismatch && (open === null || open > 0) };
  });
  if (line) {
    const paidRows = rows.filter(r => r.status === 'paid');
    const payments = await SupplierPayment.find({ status: 'posted', fromAccountId: bank._id, 'allocations.billId': { $in: paidRows.map(r => r.billId) } }).lean();
    const available = await require('./bank').unmatchedMovements(bank._id);
    for (const row of paidRows) row.canMatch = !row.merchantMismatch && payments.some(p => p.allocations.some(a => String(a.billId) === String(row.billId))
      && available.some(e => String(e._id) === String(p.entryId) && e.amount === line.amount));
  }
  let truncated = bills.length > limit;
  if (source !== 'direct') {
    const dates = { ...(from && { $gte: dayStart(from) }), ...(to && { $lt: dayStart(addDays(to, 1)) }) };
    const orders = await Order.find({ isCanceled: { $ne: true }, 'purchaseItems.0': { $exists: true },
      ...(from || to ? { 'purchaseItems.date': dates } : {}) }).select('orderId purchaseItems').limit(limit + 1).lean();
    truncated ||= orders.length > limit;
    const items = orders.slice(0, limit).flatMap(order => (order.purchaseItems || []).map(item => ({ order, item })));
    const existing = await SupplierBill.find({ status: { $ne: 'canceled' }, $or: [
      { idempotencyKey: { $in: items.map(({ item }) => `MIG:PURCH:${item._id}`) } }, { 'lines.orderId': { $in: orders.map(o => o._id) } },
    ] }).select('idempotencyKey currency lines').lean();
    const used = new Set((await BankStatementLine.distinct('purchaseItemId', { lineStatus: 'created_entry' })).filter(Boolean).map(String));
    for (const { order, item } of items) {
      const itemDay = item.date ? toDay(item.date) : '';
      if (!itemDay || (from && itemDay < from) || (to && itemDay > to)) continue;
      const currency = item.currency || 'USD';
      const recorded = existing.some(b => b.idempotencyKey === `MIG:PURCH:${item._id}` || (b.currency === currency
        && b.lines.some(l => String(l.orderId) === String(order._id) && Math.abs(Number(l.amount) - Number(item.unitPrice)) < 0.0005)));
      if (recorded) continue;
      const linked = used.has(String(item._id));
      rows.push({ _id: `item:${item._id}`, kind: 'order_item', source: 'order', itemId: item._id, orderId: order._id,
        number: 'بند مشتريات', day: itemDay, amount: Number(item.unitPrice), currency, description: item.description,
        orders: [{ _id: order._id, number: order.orderId, description: item.description }], status: linked ? 'linked' : 'unrecorded', canMatch: !linked });
    }
  }
  const search = q.trim() ? new RegExp(escaped(q.trim()), 'i') : null;
  const filtered = rows.filter(r => (source === 'all' || r.source === source) && (status !== 'open' || r.canMatch) && (!search || search.test([r.number, r.vendorName, r.description, ...r.orders.map(o => o.number)].join(' '))))
    .sort((a, b) => {
      const preferred = row => (input.suggestedBillId && String(row.billId) === String(input.suggestedBillId))
        || (input.suggestedItemId && String(row.itemId) === String(input.suggestedItemId));
      return Number(!!preferred(b)) - Number(!!preferred(a)) || b.day.localeCompare(a.day) || a._id.localeCompare(b._id);
    });
  const page = Math.max(1, Number.parseInt(input.page, 10) || 1);
  const pageSize = 30;
  return { results: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize, truncated,
    original: { ...original, known: !!context.originalCurrency || original.currency !== bank.currency } };
}

async function matchPurchase(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || !((line.lineStatus === 'unmatched') || (line.lineStatus === 'created_entry' && line.historicalPurchase)) || line.amount >= 0) throw fail('اختر سطر سحب غير مطابق');
  const bank = await Account.findById(line.accountId).session(session).lean();
  const services = require('./bank');
  if (input.kind === 'bill') {
    if (!mongoose.isValidObjectId(input.billId)) throw fail('اختر الفاتورة');
    const bill = await SupplierBill.findById(input.billId).session(session).lean();
    if (!bill || !['draft', 'posted'].includes(bill.status) || bill.isCreditNote) throw fail('الفاتورة غير متاحة');
    await assertMerchant(line, bank, bill.vendorId, session);
    validateChoice(line, bank, { day: bill.day, amount: amountOf(bill), currency: bill.currency }, input.confirmDifference === true);
    const { count } = await getConfig();
    const beforeCount = count && count.accountIds.has(String(bank._id)) && (line.day < count.day || (line.day === count.day && count.endOfDay));
    if (beforeCount && bill.day <= count.day && bill.status === 'posted') {
      const original = originalOf(line, bank.currency);
      if (original.currency !== bill.currency || Math.abs(original.amount - amountOf(bill)) > 0.0005) throw fail('المطابقة التاريخية تتطلب نفس المبلغ والعملة؛ راجع فرق التكلفة أولاً');
      const { apBalance, billKey } = require('./payables');
      if (await apBalance(billKey(bill._id), session) <= 0) {
        const payments = await SupplierPayment.find({ status: 'posted', 'allocations.billId': bill._id }).session(session).lean();
        const suspense = await require('../roles').resolveAccount('migration_suspense');
        const opening = await require('../roles').resolveAccount('opening_balance');
        const historicalPayment = payments.length && payments.every(p => p.day <= count.day && [String(bank._id), String(suspense._id), String(opening._id)].includes(String(p.fromAccountId)));
        if (!historicalPayment && !bill.paidBeforeCount) throw fail('الفاتورة مسددة من حساب آخر أو بعد الجرد؛ راجع السداد قبل الربط');
        if (await BankStatementLine.exists({ _id: { $ne: line._id }, billId: bill._id, amount: { $lt: 0 }, lineStatus: { $in: ['matched', 'created_entry'] } }).session(session)) throw fail('الفاتورة مرتبطة بكشف آخر بالفعل');
        // Claim the bill too: simultaneous matches of two different bank lines must contend.
        await SupplierBill.updateOne({ _id: bill._id }, { $inc: { allocationVersion: 1 } }, { session });
        const bankEntryIds = payments.filter(p => String(p.fromAccountId) === String(bank._id) && p.entryId).map(p => p.entryId);
        for (const entryId of bankEntryIds) {
          const reserved = await JournalEntry.updateOne({ _id: entryId, bankMatchedAccounts: { $ne: bank._id } },
            { $addToSet: { bankMatchedAccounts: bank._id } }, { session });
          if (reserved.modifiedCount !== 1) throw fail('قيد السداد مرتبط بكشف آخر بالفعل');
        }
        if (line.historicalPurchase && line.entryId) {
          await require('../ledger').reverseEntry(line.entryId, { session, user: req?.user, reason: 'ربط التكلفة التاريخية بفاتورة موجودة لمنع ازدواجية التكلفة',
            eventKey: `HIST_PURCHASE_LINK:${line._id}:${line.postingAttempt || 0}`, onLocked: 'reject' });
          line.historyEntryIds.push(line.entryId); line.entryId = undefined;
        }
        Object.assign(line, { lineStatus: 'matched', historicalCovered: true, historicalPurchase: false, billId: bill._id,
          matchedOriginalAmount: amountOf(bill), matchedOriginalCurrency: bill.currency, purchaseReviewPending: false,
          matchDifferenceConfirmed: !!input.confirmDifference, matchedEntryIds: bankEntryIds });
        const orders = [...new Set(bill.lines.filter(l => l.orderId).map(l => String(l.orderId)))];
        if (orders.length === 1) line.orderId = orders[0];
        await line.save({ session });
        await require('../audit').logAudit({ req, action: 'bank.historicalMatch', model: 'AccountingBankStatementLine', docId: line._id,
          after: { billId: bill._id, historicalCovered: true } }, session);
        await require('./bankMerchants').learn(line, bill.vendorId, null, session);
        return { matched: true, historicalCovered: true, billId: bill._id };
      }
    }
    if (line.historicalPurchase) throw fail('التكلفة التاريخية تحتاج فاتورة مسجلة ومسددّة قبل الجرد؛ راجع الفاتورة أولاً');
    const { apBalance, billKey } = require('./payables');
    if (bill.status === 'posted' && await apBalance(billKey(bill._id), session) <= 0) {
      const payments = await SupplierPayment.find({ status: 'posted', fromAccountId: bank._id, 'allocations.billId': bill._id }).session(session).lean();
      const movements = await services.unmatchedMovements(bank._id, { session });
      const eligible = movements.filter(m => m.amount === line.amount && payments.some(p => String(p.entryId) === String(m._id)));
      if (eligible.length !== 1) throw fail('لا يوجد قيد سداد وحيد متاح بنفس المبلغ على هذا البنك؛ راجع قائمة مطابقة القيود');
      await services.manualMatch(line._id, [eligible[0]._id], { session, req });
      await require('./bankMerchants').learn(line, bill.vendorId, bill.lines.length === 1 ? bill.lines[0].accountId : null, session);
      const ids = [...new Set(bill.lines.filter(l => l.orderId).map(l => String(l.orderId)))];
      await BankStatementLine.updateOne({ _id: line._id }, { $set: { billId: bill._id, ...(ids.length === 1 && { orderId: ids[0] }),
        matchedOriginalAmount: amountOf(bill), matchedOriginalCurrency: bill.currency, matchDifferenceConfirmed: !!input.confirmDifference, purchaseReviewPending: false } }, { session });
      return { matched: true, billId: bill._id };
    }
    const result = await services.createEntryForLine(line._id, { billId: bill._id, manualBillMatch: true, confirmDifference: input.confirmDifference === true,
      confirmNotDuplicate: input.confirmNotDuplicate === true }, { session, req });
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { purchaseReviewPending: false } }, { session });
    return result;
  }
  if (input.kind !== 'order_item' || !mongoose.isValidObjectId(input.orderId) || !mongoose.isValidObjectId(input.itemId)) throw fail('اختر بند المشتريات');
  const order = await Order.findOne({ _id: input.orderId, isCanceled: { $ne: true }, 'purchaseItems._id': input.itemId }).session(session).lean();
  const item = order?.purchaseItems.find(i => String(i._id) === String(input.itemId));
  if (!item) throw fail('بند المشتريات غير متاح');
  if (!item.date) throw fail('بند المشتريات بلا تاريخ؛ راجع بياناته قبل المطابقة');
  validateChoice(line, bank, { amount: Number(item.unitPrice), currency: item.currency || 'USD', day: toDay(item.date) }, input.confirmDifference === true);
  const recorded = await SupplierBill.findOne({ status: { $in: ['draft', 'posted'] }, $or: [ { idempotencyKey: `MIG:PURCH:${item._id}` },
    { currency: item.currency || 'USD', lines: { $elemMatch: { orderId: order._id, amount: Number(item.unitPrice) } } } ] }).session(session).lean();
  if (recorded) return matchPurchase(lineId, { ...input, kind: 'bill', billId: recorded._id }, { session, req });
  if (line.historicalPurchase) throw fail('هذا السطر تكلفة تاريخية؛ سجّل الفاتورة الأصلية أولاً ثم اربطها لمنع تكرار التكلفة');
  const result = await services.linkGroup([line._id], { orderId: order._id, itemId: item._id, confirmDifference: input.confirmDifference === true }, { session, req });
  await BankStatementLine.updateOne({ _id: line._id }, { $set: { matchedOriginalAmount: Number(item.unitPrice), matchedOriginalCurrency: item.currency || 'USD', matchDifferenceConfirmed: !!input.confirmDifference, purchaseReviewPending: false } }, { session });
  return result;
}

module.exports = { listPurchases, matchPurchase, validateChoice, amountOf };
