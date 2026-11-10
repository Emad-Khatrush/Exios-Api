// A partner's current account (Wasl) paying yuan for us. One statement line often sums several
// transfers ("حوالات عبر Alipay بقيمة 40,909+32,723.88=73,632.88¥ تم الحساب بسعر صرف 6.47"), and
// each part is one of:
//   - a transfer the partner paid straight to a customer's Chinese supplier: already a yuan supplier
//     bill on its order, which the line pays;
//   - yuan the partner sold us into one of our Alipay accounts: a yuan purchase paid from the current
//     account, either recorded already or recorded here (matched to its arrival line in the Alipay
//     statement when one is found).
// Each part is proposed (bill first, then a recorded purchase, then an arrival in Alipay), the person
// may change any of them, and on approval the line's dollars are split over the parts by their yuan
// (a purchase already recorded keeps its own dollars), everything is posted from the current account
// and the line is matched with all of it, so no cost or yuan is entered twice. Before the count the
// counted balances already hold the line: the bills are paid against the opening balances, no
// purchase is recorded, and the line is closed with its reason.
const { BankStatementLine, SupplierBill, YuanPurchase, Vendor } = require('../../models/documents');
const { Account, JournalEntry } = require('../../models');
const Order = require('../../../models/order');
const User = require('../../../models/user');
const { addDays } = require('../dates');
const { logAudit } = require('../audit');
const { fail } = require('./common');

const DAYS = 15;
const YUAN = 1;
const daysApart = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);
const number = (text) => Number(String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,\s]/g, ''));
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The yuan parts, their total and the rate written in the partner's text, or null
function partsOf(description) {
  const text = String(description || '');
  if (!/alipay|حوال/i.test(text)) return null;
  // «40,909+32,723.88=73,632.88¥», or the same written (or copied from a right-to-left PDF) total first
  const found = text.match(/بقيمة\s*¥?\s*([\d٠-٩.,\s+=]+?)\s*(?:¥|يوان|تم|$)/);
  if (!found) return null;
  const sides = found[1].split('=').map((side) => side.trim()).filter(Boolean);
  if (sides.length > 2) return null;
  const partsSide = sides.find((side) => side.includes('+')) || sides[0];
  const totalSide = sides.length === 2 ? sides.find((side) => side !== partsSide) : null;
  const parts = partsSide.split('+').map(number).filter((n) => n > 0);
  if (!parts.length) return null;
  const total = totalSide ? number(totalSide) : parts.reduce((s, n) => s + n, 0);
  const rate = Number((text.match(/سعر\s*صرف\s*([\d.]+)/) || [])[1]) || null;
  return { parts, total, rate };
}

// The line's dollars (cents) over its parts: a recorded purchase keeps its own dollars (`fixed`), the
// rest is split over the other parts by their yuan, the last one taking the cents left
function splitUsd(paid, items) {
  const fixed = items.reduce((s, item) => s + (item.fixed ?? 0), 0);
  const free = items.filter((item) => item.fixed === undefined);
  const rest = paid - fixed;
  if (!free.length) {
    if (rest !== 0) return { error: `قيمة شراء اليوان المسجل ${(fixed / 100).toFixed(2)}$ والسطر ${(paid / 100).toFixed(2)}$` };
    return { shares: items.map((item) => item.fixed) };
  }
  if (rest <= 0) return { error: `مشتريات اليوان المسجلة (${(fixed / 100).toFixed(2)}$) تستهلك كل السطر (${(paid / 100).toFixed(2)}$)` };
  const yuan = free.reduce((s, item) => s + item.yuan, 0);
  let left = rest;
  let seen = 0;
  const shares = items.map((item) => {
    if (item.fixed !== undefined) return item.fixed;
    seen += 1;
    const usd = seen === free.length ? left : Math.round(rest * item.yuan / yuan);
    left -= usd;
    return usd;
  });
  if (shares.some((usd) => usd <= 0)) return { error: 'حصة أحد الأجزاء من دولار السطر صفر أو أقل' };
  return { shares };
}

const partnerAccount = async (accountId, session) => {
  const account = await Account.findById(accountId).session(session || null).lean();
  return account?.isCash && account.cashKind === 'current' && account.type === 'asset' ? account : null;
};

// The broker behind a current account: the vendor linked to the account's wallet customer, or a
// vendor named like the account
async function brokerOf(account, session) {
  const code = account.walletCustomerCode || (account.seedKey === '110401' ? 'N999' : null);
  if (code) {
    const customer = await User.findOne({ customerId: code }).select('_id').session(session || null).lean();
    const vendor = customer && await Vendor.findOne({ linkedCustomer: customer._id, isActive: { $ne: false } }).select('name').session(session || null).lean();
    if (vendor) return { vendorId: vendor._id, name: vendor.name };
  }
  const word = String(account.name || '').replace(/جاري|جارٍ|حساب/g, '').trim();
  if (word) {
    const vendor = await Vendor.findOne({ name: new RegExp(escapeRegex(word), 'i'), isActive: { $ne: false } }).select('name').session(session || null).lean();
    if (vendor) return { vendorId: vendor._id, name: vendor.name };
  }
  return null;
}

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

// Yuan purchases paid in dollars from the current account whose payment no statement line took yet
async function openPurchases(account, from, to, session) {
  const purchases = await YuanPurchase.find({ status: 'posted', fromAccountId: account._id, currency: 'USD', day: { $gte: from, $lte: to }, entryId: { $exists: true } })
    .populate('toAccountId', 'name').session(session || null).lean();
  if (!purchases.length) return [];
  const entries = await JournalEntry.find({ _id: { $in: purchases.map((p) => p.entryId) }, status: 'posted' }).select('_id bankMatchedAccounts').session(session || null).lean();
  const free = new Set(entries.filter((e) => !(e.bankMatchedAccounts || []).some((id) => String(id) === String(account._id))).map((e) => String(e._id)));
  return purchases.filter((p) => free.has(String(p.entryId))).map((p) => ({
    purchaseId: p._id, number: p.number, day: p.day, amount: Number(p.cnyReceived || p.cnyExpected), usd: Math.round(Number(p.amount) * 100),
    entryId: p.entryId, account: p.toAccountId?.name, arrived: p.arrived,
  }));
}

// Yuan that came into one of our Alipay accounts and is not explained yet
async function arrivalLines(from, to, session) {
  const alipays = await Account.find({ isCash: true, currency: 'CNY', isActive: true, isGroup: { $ne: true } }).select('_id name').session(session || null).lean();
  if (!alipays.length) return [];
  const names = new Map(alipays.map((a) => [String(a._id), a.name]));
  const lines = await BankStatementLine.find({ accountId: { $in: alipays.map((a) => a._id) }, lineStatus: 'unmatched', amount: { $gt: 0 }, day: { $gte: from, $lte: to },
    duplicateResolvedToId: { $exists: false } }).select('_id accountId amount day sourceTransactionId').session(session || null).lean();
  return lines.map((l) => ({ lineId: l._id, accountId: l.accountId, account: names.get(String(l.accountId)), amount: l.amount / 100, day: l.day, reference: l.sourceTransactionId || '' }));
}

const nearest = (rows, amount, day, used, key) => rows
  .filter((r) => !used.has(String(r[key])) && Math.abs(r.amount - amount) <= YUAN && daysApart(r.day, day) <= DAYS)
  .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount) || daysApart(a.day, day) - daysApart(b.day, day))[0] || null;

const isBeforeCount = (count, accountId, day) => !!count && (day < count.day || (day === count.day && count.endOfDay)) && count.accountIds.has(String(accountId));

// For each unmatched outgoing line that names yuan transfers: what each part is, and its dollars
async function suggestions(accountId, { session, lineIds } = {}) {
  const account = await partnerAccount(accountId, session);
  if (!account) return {};
  const lines = (await BankStatementLine.find({ accountId: account._id, lineStatus: 'unmatched', amount: { $lt: 0 }, ...(lineIds && { _id: { $in: lineIds } }) })
    .session(session || null).lean()).map((line) => ({ line, parsed: partsOf(line.description) })).filter((x) => x.parsed);
  if (!lines.length) return {};
  const days = lines.map((x) => x.line.day).sort();
  const from = addDays(days[0], -DAYS);
  const to = addDays(days[days.length - 1], DAYS);
  // One after another: a transaction's session takes one operation at a time
  const bills = await openYuanBills(from, to, session);
  const purchases = await openPurchases(account, from, to, session);
  const arrivals = await arrivalLines(from, to, session);
  const broker = await brokerOf(account, session);
  const { count } = await require('../config').getConfig();
  const used = new Set();
  const result = {};
  for (const { line, parsed } of lines.sort((a, b) => a.line.day.localeCompare(b.line.day))) {
    const beforeCount = isBeforeCount(count, account._id, line.day);
    const parts = parsed.parts.map((amount) => {
      const bill = nearest(bills, amount, line.day, used, 'billId');
      if (bill) { used.add(String(bill.billId)); return { amount, choice: 'bill', bill }; }
      const purchase = nearest(purchases, amount, line.day, used, 'purchaseId');
      if (purchase) { used.add(String(purchase.purchaseId)); return { amount, choice: 'purchase', bill: null, purchase }; }
      const arrival = nearest(arrivals, amount, line.day, used, 'lineId');
      if (arrival) { used.add(String(arrival.lineId)); return { amount, choice: 'new', bill: null, arrival }; }
      return { amount, choice: null, bill: null };
    });
    const split = parts.every((p) => p.choice) ? splitUsd(-line.amount, parts.map((p) => ({ yuan: p.amount, ...(p.choice === 'purchase' && { fixed: p.purchase.usd }) }))) : null;
    if (split?.shares) parts.forEach((p, i) => { p.usd = split.shares[i] / 100; });
    const needsBroker = parts.some((p) => p.choice === 'new') && !beforeCount;
    result[line._id] = { ...parsed, usd: -line.amount / 100, parts, broker, beforeCount, splitError: split?.error || null,
      complete: parts.every((p) => p.choice) && !!split?.shares && (!needsBroker || !!broker) };
  }
  return result;
}

// Everything a line's part could be, for choosing by hand (search bills by order or bill number)
async function options(lineId, { q } = {}) {
  const line = await BankStatementLine.findById(lineId).lean();
  if (!line) throw fail('سطر الكشف غير موجود');
  const account = await partnerAccount(line.accountId);
  const from = addDays(line.day, -30);
  const to = addDays(line.day, 30);
  return {
    parsed: partsOf(line.description),
    results: await openYuanBills(from, to, null, { q: q ? String(q).trim() : undefined }),
    purchases: account ? await openPurchases(account, from, to) : [],
    arrivals: await arrivalLines(from, to),
    broker: account ? await brokerOf(account) : null,
  };
}

// The parts the person approved, checked against what is open now
async function resolveParts(line, account, input, session) {
  const wanted = Array.isArray(input.parts) ? input.parts : (input.billIds || []).map((billId) => ({ kind: 'bill', billId }));
  if (!wanted.length) throw fail('اختر ما دفعه السطر: فواتير الحوالات أو شراء اليوان');
  const from = addDays(line.day, -60);
  const to = addDays(line.day, 60);
  const bills = await openYuanBills(from, to, session);
  const purchases = await openPurchases(account, from, to, session);
  const seen = new Set();
  const once = (key) => {
    if (seen.has(key)) throw fail('لا تختر نفس الفاتورة أو العملية مرتين');
    seen.add(key);
  };
  const items = [];
  for (const part of wanted) {
    if (part?.kind === 'bill') {
      const bill = bills.find((b) => String(b.billId) === String(part.billId));
      if (!bill) throw fail('بعض الفواتير مسددة أو غير متاحة؛ حدّث القائمة');
      once(`bill:${bill.billId}`);
      items.push({ kind: 'bill', yuan: bill.amount, bill });
    } else if (part?.kind === 'purchase') {
      const purchase = purchases.find((p) => String(p.purchaseId) === String(part.purchaseId));
      if (!purchase) throw fail('عملية شراء اليوان غير متاحة أو مطابقة مسبقاً؛ حدّث القائمة');
      once(`purchase:${purchase.purchaseId}`);
      items.push({ kind: 'purchase', yuan: purchase.amount, fixed: purchase.usd, purchase });
    } else if (part?.kind === 'new') {
      let cny = Math.round(Number(part.cny) * 100) / 100;
      const target = await Account.findById(part.toAccountId).session(session).lean();
      if (!target?.isCash || target.currency !== 'CNY' || !target.isActive) throw fail('اختر حساب Alipay الذي وصل إليه اليوان');
      let arrival = null;
      if (part.arrivalLineId) {
        arrival = await BankStatementLine.findById(part.arrivalLineId).session(session).lean();
        if (!arrival || arrival.lineStatus !== 'unmatched' || arrival.amount <= 0 || String(arrival.accountId) !== String(target._id)) throw fail('سطر وصول اليوان في كشف Alipay غير متاح؛ حدّث الصفحة');
        if (Math.abs(arrival.amount / 100 - cny) > YUAN) throw fail(`وصول Alipay ${arrival.amount / 100}¥ لا يساوي الجزء ${cny}¥`);
        once(`arrival:${arrival._id}`);
        cny = arrival.amount / 100;
      }
      if (!(cny > 0)) throw fail('اكتب كمية اليوان لشراء اليوان');
      items.push({ kind: 'new', yuan: cny, to: target, arrival });
    } else {
      throw fail('نوع الجزء غير معروف');
    }
  }
  return items;
}

// Pays the bills and records the yuan purchases of a line from the current account, then matches it
async function apply(lineId, input, { session, req }) {
  const payables = require('./payables');
  const bank = require('./bank');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched' || line.amount >= 0) throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  require('./bankEvidence').assertReviewed(line);
  const account = await partnerAccount(line.accountId, session);
  if (!account || (account.currency || 'USD') !== 'USD') throw fail('هذا الإجراء لحساب جارٍ بالدولار');
  const items = await resolveParts(line, account, input, session);
  const parsed = partsOf(line.description);
  const yuan = Math.round(items.reduce((s, item) => s + item.yuan, 0) * 100) / 100;
  // The person may correct a description written wrong (or drop a part): their parts are used, the
  // statement's figures kept in the audit
  const corrected = input.statementCorrected === true;
  if (parsed && !corrected && Math.abs(yuan - parsed.total) > YUAN * items.length) {
    throw fail(`مجموع الأجزاء ${yuan.toLocaleString('en-US')}¥ والكشف ${parsed.total.toLocaleString('en-US')}¥: ${parsed.total > yuan ? `ينقص ${(Math.round((parsed.total - yuan) * 100) / 100).toLocaleString('en-US')}¥؛ أضف مشتريات الطلبية الناقصة أو شراء اليوان ثم أعد المطابقة` : 'اختر الأجزاء الصحيحة'}`);
  }
  if (!parsed && !input.confirmDifference && !corrected) throw fail('الكشف لا يذكر قيم اليوان؛ راجع الفواتير وأكد أنها نفس الحوالات');
  const split = splitUsd(-line.amount, items);
  if (split.error) throw fail(split.error);
  items.forEach((item, i) => { item.usd = split.shares[i]; });

  const { count } = await require('../config').getConfig();
  const beforeCount = isBeforeCount(count, account._id, line.day);
  const attempt = line.postingAttempt || 0;

  // Bills: one payment per vendor, the bills paid in full; the line's share is their real cost
  const byVendor = new Map();
  items.filter((item) => item.kind === 'bill').forEach((item) => byVendor.set(String(item.bill.vendorId), [...(byVendor.get(String(item.bill.vendorId)) || []), item]));
  const payments = [];
  for (const [vendorId, group] of byVendor) {
    payments.push(await payables.createPayment({
      vendorId, day: line.day, fromAccountId: account._id, amount: group.reduce((s, item) => s + item.usd, 0) / 100, differenceTo: 'cost',
      allocations: group.map((item) => ({ billId: item.bill.billId, amountUsd: item.bill.openUsd })),
      idempotencyKey: `BANK_GROUP_PAY:${line._id}:${attempt}:${vendorId}`,
      note: `سداد حوالات Alipay من كشف ${account.name}: ${group.map((item) => `${item.bill.number} (${item.bill.amount}¥)`).join('، ')}`,
    }, { session, req }));
  }

  // New yuan purchases (after the count only: before it the counted Alipay balance holds the yuan)
  const created = [];
  const fresh = items.filter((item) => item.kind === 'new');
  if (fresh.length && !beforeCount) {
    const broker = input.vendorId ? await Vendor.findById(input.vendorId).session(session).lean() : null;
    const vendorId = broker?._id || (await brokerOf(account, session))?.vendorId;
    if (!vendorId) throw fail('اختر الوسيط الذي باع اليوان');
    for (const [i, item] of fresh.entries()) {
      const doc = await require('./alipay').createYuanPurchase({
        vendorId, day: line.day, fromAccountId: account._id, amount: item.usd / 100, toAccountId: item.to._id, arrived: true, cnyReceived: item.yuan,
        transactionReference: item.arrival?.sourceTransactionId || undefined,
        idempotencyKey: `BANK_GROUP_YUAN:${line._id}:${attempt}:${i}`, note: `من كشف ${account.name}: ${line.description || ''}`,
      }, { session, req });
      // Matched by its transaction number; an arrival line without one is matched to the purchase directly
      if (item.arrival) {
        const after = await BankStatementLine.findById(item.arrival._id).session(session).lean();
        if (after.lineStatus === 'unmatched') await bank.manualMatch(after._id, [doc.entryId], { session, req });
      }
      created.push(doc);
    }
  }

  const paymentIds = payments.map((p) => p._id);
  const purchaseIds = created.map((p) => p._id);
  if (beforeCount) {
    // The counted balance already holds the line: the bills are paid (against the opening balances)
    // and the line is closed with its reason
    const what = [...items.filter((item) => item.kind === 'bill').map((item) => item.bill.number), ...items.filter((item) => item.kind !== 'bill').map((item) => `شراء ${item.yuan}¥`)];
    await BankStatementLine.updateOne({ _id: line._id, lineStatus: 'unmatched' }, { $set: { lineStatus: 'ignored', groupPaymentIds: paymentIds,
      coveredNote: `قبل الجرد: ${what.join('، ')}` } }, { session });
  } else {
    const entryIds = [...payments.map((p) => p.entryId), ...items.filter((item) => item.kind === 'purchase').map((item) => item.purchase.entryId), ...created.map((p) => p.entryId)];
    await bank.manualMatch(line._id, entryIds, { session, req });
    await BankStatementLine.updateOne({ _id: line._id }, { $set: { groupPaymentIds: paymentIds, groupPurchaseIds: purchaseIds } }, { session });
  }
  await logAudit({ req, action: 'bank.partnerTransfersPaid', model: 'AccountingBankStatementLine', docId: line._id,
    after: { parts: items.map((item) => ({ kind: item.kind, yuan: item.yuan, usd: item.usd, id: item.bill?.billId || item.purchase?.purchaseId })), paymentIds, purchaseIds, yuan, usd: -line.amount, beforeCount,
      ...(corrected && { statementCorrected: true, statementParts: parsed?.parts || null, statementTotal: parsed?.total ?? null }) } }, session);
  return BankStatementLine.findById(line._id).session(session).lean();
}

module.exports = { partsOf, splitUsd, suggestions, options, apply };
