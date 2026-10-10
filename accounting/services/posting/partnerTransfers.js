// A partner's current account (Wasl) paying customers' Alipay transfers for us. One statement line
// often sums several transfers ("حوالات عبر Alipay بقيمة 9,285+11,000=20,285¥ تم الحساب بسعر صرف 6.62"),
// while each transfer is already a yuan supplier bill on its order. The line pays those bills: each
// yuan part is proposed against an unpaid yuan bill of the same amount (±1¥, a fortnight around),
// and on approval the line's dollars are split over the bills by their yuan and paid from the
// current account, so no cost is entered twice. Before the count the payments go to the opening
// balances (the counted account already holds the line) and the line is closed with its reason.
const { BankStatementLine, SupplierBill } = require('../../models/documents');
const { Account } = require('../../models');
const Order = require('../../../models/order');
const { addDays } = require('../dates');
const { logAudit } = require('../audit');
const { fail } = require('./common');

const DAYS = 15;
const YUAN = 1;
const daysApart = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);
const number = (text) => Number(String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,\s]/g, ''));

// The yuan parts, their total and the rate written in the partner's text, or null
function partsOf(description) {
  const text = String(description || '');
  if (!/alipay|حوال/i.test(text)) return null;
  const found = text.match(/بقيمة\s*([\d٠-٩.,\s+]+?)(?:\s*=\s*([\d٠-٩.,]+))?\s*(?:¥|يوان|تم|$)/);
  if (!found) return null;
  const parts = found[1].split('+').map(number).filter((n) => n > 0);
  if (!parts.length) return null;
  const total = found[2] ? number(found[2]) : parts.reduce((s, n) => s + n, 0);
  const rate = Number((text.match(/سعر\s*صرف\s*([\d.]+)/) || [])[1]) || null;
  return { parts, total, rate };
}

const partnerAccount = async (accountId, session) => {
  const account = await Account.findById(accountId).session(session || null).lean();
  return account?.isCash && account.cashKind === 'current' && account.type === 'asset' ? account : null;
};

// Unpaid yuan bills in a date range, with their orders and what is still owed on them
async function openYuanBills(from, to, session, { q } = {}) {
  const payables = require('./payables');
  const bills = await SupplierBill.find({ currency: 'CNY', status: 'posted', isCreditNote: { $ne: true }, day: { $gte: from, $lte: to } })
    .populate('vendorId', 'name').session(session || null).lean();
  const orders = new Map((await Order.find({ _id: { $in: bills.flatMap((b) => b.lines.map((l) => l.orderId)).filter(Boolean) } }, { orderId: 1 })
    .session(session || null).lean()).map((o) => [String(o._id), o.orderId]));
  const rows = [];
  for (const bill of bills) {
    const open = await payables.apBalance(payables.billKey(bill._id), session);
    // Only a bill nothing was paid on yet: the line pays it in full
    if (open <= 0 || open !== bill.totalUsd) continue;
    const orderNumbers = [...new Set(bill.lines.map((l) => orders.get(String(l.orderId))).filter(Boolean))];
    if (q && !orderNumbers.some((n) => n.includes(q)) && !String(bill.number).includes(q)) continue;
    rows.push({ billId: bill._id, number: bill.number, day: bill.day, amount: Number(bill.total), vendorId: bill.vendorId?._id, vendor: bill.vendorId?.name, openUsd: open, orders: orderNumbers });
  }
  return rows;
}

// For each unmatched outgoing line that names yuan transfers: a bill proposed for each part
async function suggestions(accountId, { session, lineIds } = {}) {
  const account = await partnerAccount(accountId, session);
  if (!account) return {};
  const lines = (await BankStatementLine.find({ accountId: account._id, lineStatus: 'unmatched', amount: { $lt: 0 }, ...(lineIds && { _id: { $in: lineIds } }) })
    .session(session || null).lean()).map((line) => ({ line, parsed: partsOf(line.description) })).filter((x) => x.parsed);
  if (!lines.length) return {};
  const days = lines.map((x) => x.line.day).sort();
  const bills = await openYuanBills(addDays(days[0], -DAYS), addDays(days[days.length - 1], DAYS), session);
  const used = new Set();
  const result = {};
  for (const { line, parsed } of lines.sort((a, b) => a.line.day.localeCompare(b.line.day))) {
    const parts = parsed.parts.map((amount) => {
      const bill = bills.filter((b) => !used.has(String(b.billId)) && Math.abs(b.amount - amount) <= YUAN && daysApart(b.day, line.day) <= DAYS)
        .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount) || daysApart(a.day, line.day) - daysApart(b.day, line.day))[0] || null;
      if (bill) used.add(String(bill.billId));
      return { amount, bill };
    });
    result[line._id] = { ...parsed, usd: -line.amount / 100, parts, complete: parts.every((p) => p.bill) };
  }
  return result;
}

// Unpaid yuan bills around a line, for picking by hand (search by order or bill number)
async function options(lineId, { q } = {}) {
  const line = await BankStatementLine.findById(lineId).lean();
  if (!line) throw fail('سطر الكشف غير موجود');
  return { parsed: partsOf(line.description), results: await openYuanBills(addDays(line.day, -30), addDays(line.day, 30), null, { q: q ? String(q).trim() : undefined }) };
}

// Pays the chosen bills from the current account with the line's dollars, then matches the line
async function apply(lineId, input, { session, req }) {
  const payables = require('./payables');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched' || line.amount >= 0) throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  const account = await partnerAccount(line.accountId, session);
  if (!account || (account.currency || 'USD') !== 'USD') throw fail('هذا الإجراء لحساب جارٍ بالدولار');
  const ids = [...new Set((input.billIds || []).map(String))];
  if (!ids.length) throw fail('اختر فواتير الحوالات');
  const open = await openYuanBills(addDays(line.day, -60), addDays(line.day, 60), session);
  const chosen = ids.map((id) => open.find((b) => String(b.billId) === id));
  if (chosen.some((b) => !b)) throw fail('بعض الفواتير مسددة أو غير متاحة؛ حدّث القائمة');
  const parsed = partsOf(line.description);
  const yuan = chosen.reduce((s, b) => s + b.amount, 0);
  if (parsed && Math.abs(yuan - parsed.total) > YUAN * chosen.length) {
    throw fail(`مجموع الفواتير ${yuan.toLocaleString('en-US')}¥ والكشف ${parsed.total.toLocaleString('en-US')}¥: ${parsed.total > yuan ? `ينقص ${(parsed.total - yuan).toLocaleString('en-US')}¥؛ أضف مشتريات الطلبية الناقصة ثم أعد المطابقة` : 'اختر الفواتير الصحيحة'}`);
  }
  if (!parsed && !input.confirmDifference) throw fail('الكشف لا يذكر قيم اليوان؛ راجع الفواتير وأكد أنها نفس الحوالات');
  // The line's dollars over the bills by their yuan; the last takes the cents left
  const paid = -line.amount;
  let left = paid;
  const share = chosen.map((bill, i) => {
    const usd = i === chosen.length - 1 ? left : Math.round(paid * bill.amount / yuan);
    left -= usd;
    return { ...bill, usd };
  });
  const byVendor = new Map();
  share.forEach((b) => byVendor.set(String(b.vendorId), [...(byVendor.get(String(b.vendorId)) || []), b]));
  const payments = [];
  for (const [vendorId, bills] of byVendor) {
    payments.push(await payables.createPayment({
      vendorId, day: line.day, fromAccountId: account._id, amount: bills.reduce((s, b) => s + b.usd, 0) / 100, differenceTo: 'cost',
      allocations: bills.map((b) => ({ billId: b.billId, amountUsd: b.openUsd })),
      idempotencyKey: `BANK_GROUP_PAY:${line._id}:${line.postingAttempt || 0}:${vendorId}`,
      note: `سداد حوالات Alipay من كشف ${account.name}: ${bills.map((b) => `${b.number} (${b.amount}¥)`).join('، ')}`,
    }, { session, req }));
  }
  const paymentIds = payments.map((p) => p._id);
  const { count } = await require('../config').getConfig();
  const beforeCount = !!count && (line.day < count.day || (line.day === count.day && count.endOfDay)) && count.accountIds.has(String(account._id));
  if (beforeCount) {
    // The counted balance already holds the line: the bills are paid (against the opening balances)
    // and the line is closed with its reason
    await BankStatementLine.updateOne({ _id: line._id, lineStatus: 'unmatched' }, { $set: { lineStatus: 'ignored', groupPaymentIds: paymentIds,
      coveredNote: `قبل الجرد: سداد ${chosen.map((b) => b.number).join('، ')}` } }, { session });
  } else {
    await require('./bank').manualMatch(line._id, payments.map((p) => p.entryId), { session, req });
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { groupPaymentIds: paymentIds } }, { session });
  }
  await logAudit({ req, action: 'bank.partnerTransfersPaid', model: 'AccountingBankStatementLine', docId: line._id,
    after: { billIds: ids, paymentIds, yuan, usd: paid, beforeCount } }, session);
  return BankStatementLine.findById(line._id).session(session).lean();
}

module.exports = { partsOf, suggestions, options, apply };
