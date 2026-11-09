// One outgoing statement line paying several supplier bills (owner's request 2026-11-07): from the
// bank matching page the owner picks a line, then the bills it paid, of one vendor or several. Each
// chosen bill is paid in full from the line's bank account; one supplier payment per vendor, and
// the line is matched to those payments, so no cost is entered twice. Unmatching the line cancels
// the payments (groupPaymentIds, as for a partner's Alipay transfers) and the bills are unpaid again.
//
// Bills in the bank's currency are paid at their own amounts: the line must cover them, and what is
// left over stays as an advance with the vendor the owner picks. Bills in another currency share the
// line by their dollar value and the difference goes on their cost (capped at 10% by createPayment).
const mongoose = require('mongoose');
const { BankStatementLine, SupplierBill, Vendor } = require('../../models/documents');
const { Account, JournalEntry } = require('../../models');
const Order = require('../../../models/order');
const { getConfig } = require('../config');
const { logAudit } = require('../audit');
const { fail } = require('./common');

const LIMIT = 300;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function bankOf(line, session) {
  const bank = await Account.findById(line.accountId).session(session || null).lean();
  if (!bank?.isCash || !bank.isActive) throw fail('حساب البنك غير متاح');
  return bank;
}

// What is still owed on each bill, USD cents, from its payable lines
async function openByBill(billIds, session) {
  if (!billIds.length) return new Map();
  const keys = billIds.map((id) => `BILL:${id}`);
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.apKey': { $in: keys } } }, { $unwind: '$lines' }, { $match: { 'lines.apKey': { $in: keys } } },
    { $group: { _id: '$lines.apKey', open: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null);
  return new Map(rows.map((r) => [r._id.slice(5), r.open]));
}

// The open part of a bill in its own currency (minor units), by what is still owed in dollars
const nativeOpen = (bill, open, decimals, known) => Math.round((known ?? Number(bill.total) * (open / (bill.totalUsd || open))) * 10 ** decimals);

// Unpaid posted bills for picking: search by bill, vendor, vendor reference, note, line text or order number
async function options(lineId, input = {}) {
  if (!mongoose.isValidObjectId(lineId)) throw fail('سطر الكشف غير موجود');
  const line = await BankStatementLine.findById(lineId).lean();
  if (!line) throw fail('سطر الكشف غير موجود');
  const bank = await bankOf(line);
  const q = typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '';
  const filter = { status: 'posted', isCreditNote: { $ne: true } };
  if (mongoose.isValidObjectId(input.vendorId)) filter.vendorId = input.vendorId;
  if (q) {
    const pattern = new RegExp(escaped(q), 'i');
    const vendorIds = await Vendor.distinct('_id', { name: pattern });
    const orderIds = await Order.distinct('_id', { orderId: pattern });
    filter.$or = [{ number: pattern }, { vendorRef: pattern }, { note: pattern }, { 'lines.description': pattern },
      { vendorId: { $in: vendorIds } }, { 'lines.orderId': { $in: orderIds } }];
  }
  // Newest first; the open balance is read for a wider set, since many old bills are already paid
  const bills = await SupplierBill.find(filter).sort({ day: -1, _id: -1 }).limit(LIMIT * 4)
    .populate('vendorId', 'name').populate('lines.orderId', 'orderId').lean();
  const open = await openByBill(bills.map((b) => b._id));
  const { currencies } = await getConfig();
  const exact = await require('../billNativeOpen').nativeOpenMap(bills, open);
  const results = bills.filter((b) => (open.get(String(b._id)) || 0) > 2).slice(0, LIMIT).map((b) => {
    const usd = open.get(String(b._id));
    const decimals = currencies.get(b.currency)?.decimals ?? 2;
    return { _id: b._id, number: b.number, day: b.day, currency: b.currency, total: Number(b.total), totalUsd: b.totalUsd,
      openUsd: usd, openNative: nativeOpen(b, usd, decimals, exact.get(String(b._id))) / 10 ** decimals, partial: usd < (b.totalUsd || 0) - 2,
      vendorId: b.vendorId?._id, vendorName: b.vendorId?.name, vendorRef: b.vendorRef || '', note: b.note || '',
      description: b.lines.map((l) => l.description).filter(Boolean).join('، '),
      orders: [...new Set(b.lines.map((l) => l.orderId?.orderId).filter(Boolean))] };
  });
  return { bankCurrency: bank.currency || 'USD', paid: -line.amount / 10 ** (currencies.get(bank.currency || 'USD')?.decimals ?? 2), results,
    truncated: bills.length === LIMIT * 4 };
}

// Pays the chosen bills from the line's account and matches the line to the payments
async function apply(lineId, input, { session, req }) {
  const payables = require('./payables');
  if (!mongoose.isValidObjectId(lineId)) throw fail('سطر الكشف غير موجود');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched' || line.amount >= 0) throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  require('./bankEvidence').assertReviewed(line);
  const bank = await bankOf(line, session);
  const currency = bank.currency || 'USD';
  const { currencies, count } = await getConfig();
  const decimals = currencies.get(currency)?.decimals ?? 2;
  const ids = [...new Set((Array.isArray(input.billIds) ? input.billIds : []).map(String))];
  if (!ids.length) throw fail('اختر فاتورة مورد واحدة على الأقل');
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw fail('فاتورة غير صالحة');
  const docs = await SupplierBill.find({ _id: { $in: ids } }).populate('vendorId', 'name').session(session).lean();
  if (docs.length !== ids.length) throw fail('بعض الفواتير غير موجودة؛ حدّث القائمة');
  const open = await openByBill(ids, session);
  const bills = ids.map((id) => docs.find((b) => String(b._id) === id)).map((b) => ({ bill: b, usd: open.get(String(b._id)) || 0 }));
  for (const { bill, usd } of bills) {
    if (bill.status !== 'posted' || bill.isCreditNote) throw fail(`الفاتورة ${bill.number} غير مرحّلة أو إشعار دائن`);
    if (usd <= 2) throw fail(`الفاتورة ${bill.number} مسددة؛ حدّث القائمة`);
  }
  const paid = -line.amount;
  const sameCurrency = bills.every(({ bill }) => bill.currency === currency);
  // Each bill's share of the line, in the bank's minor units
  let shares;
  let excess = 0;
  if (sameCurrency) {
    const exact = await require('../billNativeOpen').nativeOpenMap(docs, open, session);
    shares = bills.map(({ bill, usd }) => nativeOpen(bill, usd, decimals, exact.get(String(bill._id))));
    const total = shares.reduce((s, n) => s + n, 0);
    if (total > paid) throw fail(`مجموع الفواتير ${(total / 10 ** decimals).toLocaleString('en-US')} ${currency} أكبر من مبلغ السطر ${(paid / 10 ** decimals).toLocaleString('en-US')} ${currency}؛ أزل فاتورة أو اختر سطرًا آخر`);
    excess = paid - total;
  } else {
    if (!input.confirmDifference) throw fail('الفواتير بعملة أخرى غير عملة البنك؛ راجع الفرق وأكد أنها نفس العملية');
    const usdTotal = bills.reduce((s, b) => s + b.usd, 0);
    let left = paid;
    shares = bills.map(({ usd }, i) => {
      const share = i === bills.length - 1 ? left : Math.round(paid * usd / usdTotal);
      left -= share;
      return share;
    });
  }
  const vendorIds = [...new Set(bills.map(({ bill }) => String(bill.vendorId?._id)))];
  let excessVendor = null;
  if (excess > 0) {
    excessVendor = String(input.excessVendorId || '');
    if (!vendorIds.includes(excessVendor)) throw fail('حدد المورد الذي يبقى لديه المبلغ الزائد');
    if (!input.confirmExcess) throw fail('أكد أن المبلغ الزائد يبقى دفعة مقدمة لدى المورد');
  }
  const payments = [];
  for (const vendorId of vendorIds) {
    const mine = bills.map((b, i) => ({ ...b, share: shares[i] })).filter(({ bill }) => String(bill.vendorId?._id) === vendorId);
    const minor = mine.reduce((s, b) => s + b.share, 0) + (vendorId === excessVendor ? excess : 0);
    payments.push(await payables.createPayment({
      vendorId, day: line.day, fromAccountId: bank._id, amount: minor / 10 ** decimals,
      differenceTo: sameCurrency ? 'advance' : 'cost',
      allocations: mine.map(({ bill, usd }) => ({ billId: bill._id, amountUsd: usd })),
      idempotencyKey: `BANK_BILLS_PAY:${line._id}:${line.postingAttempt || 0}:${vendorId}`,
      note: [`سداد من كشف ${bank.name} (${line.day}): ${mine.map(({ bill }) => bill.number).join('، ')}`, String(input.note || '').trim().slice(0, 500)].filter(Boolean).join(' — '),
    }, { session, req }));
  }
  const paymentIds = payments.map((p) => p._id);
  const beforeCount = !!count && (line.day < count.day || (line.day === count.day && count.endOfDay)) && count.accountIds.has(String(bank._id));
  if (beforeCount) {
    // The counted balance already holds the line: the bills are paid and the line closed with its reason
    await BankStatementLine.updateOne({ _id: line._id, lineStatus: 'unmatched' }, { $set: { lineStatus: 'ignored', groupPaymentIds: paymentIds,
      coveredNote: `قبل الجرد: سداد ${bills.map(({ bill }) => bill.number).join('، ')}` } }, { session });
  } else {
    await require('./bank').manualMatch(line._id, payments.map((p) => p.entryId), { session, req });
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { groupPaymentIds: paymentIds } }, { session });
  }
  await logAudit({ req, action: 'bank.billsPaid', model: 'AccountingBankStatementLine', docId: line._id,
    after: { billIds: ids, paymentIds, paid, currency, excess, excessVendor, sameCurrency, beforeCount } }, session);
  return { line: await BankStatementLine.findById(line._id).session(session).lean(), payments: payments.map((p) => ({ _id: p._id, number: p.number, entryId: p.entryId })) };
}

module.exports = { options, apply };
