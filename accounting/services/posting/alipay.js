// The Alipay section (spec 19.5, phase C1). The company buys yuan from brokers (Wasl, Safe
// Caravan...) with dollars or other currencies and sends it to customers' Chinese suppliers. The
// profit is the difference between what the customer pays and the yuan's cost.
//
// A yuan purchase: the dollars paid and the yuan received set its rate (yuan / dollar), and the
// Alipay account's average carrying rate follows. When the yuan has not arrived yet, the dollars
// wait on "yuan in transit" against the broker until the arrival is confirmed with the actual
// amount (a different amount only changes the rate, never the dollars).
const mongoose = require('mongoose');
const { Account, JournalEntry } = require('../../models');
const { YuanPurchase, Vendor } = require('../../models/documents');
const Order = require('../../../models/order');
const { postEntry } = require('../ledger');
const { isDay, today, addDays } = require('../dates');
const { logAudit } = require('../audit');
const { getBalance } = require('../carrying');
const { getConfig } = require('../config');
const {
  fail, currencyOf, getAccount, toCurrencyMinor, decimalsOf, RateBook, valueOut, moneyLine, nextDocNumber, findExisting, resolveAccount,
  lockPostingAccounts, isBeforeCashCount,
} = require('./common');

const PENDING_DAYS = 7;

// Yuan moves when it moves: a later date takes it out of the balance before it is spent (a transfer
// dated tomorrow was counted out of the box twice by the opening count, 2026-10-03)
const notFuture = (day) => {
  if (day > today()) throw fail(`التاريخ ${day} في المستقبل؛ سجّل العملية بتاريخ حدوثها`);
};

async function alipayAccount(id) {
  const account = await getAccount(id, 'حساب Alipay');
  if (!account.isCash || currencyOf(account) !== 'CNY') throw fail('اختر حساب Alipay باليوان');
  return account;
}

async function createYuanPurchase(input, { session, req }) {
  const existing = await findExisting(YuanPurchase, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  notFuture(input.day);
  const broker = await Vendor.findById(input.vendorId).session(session);
  if (!broker) throw fail('اختر الوسيط');
  const from = await getAccount(input.fromAccountId, 'الحساب الدافع');
  if (!from.isCash) throw fail('ادفع من خزينة أو بنك أو حساب جارٍ');
  const to = await alipayAccount(input.toAccountId);
  const paidMinor = await toCurrencyMinor(input.amount, currencyOf(from));
  if (!paidMinor) throw fail('المبلغ المدفوع مطلوب');
  if (!(await isBeforeCashCount(input.day))) {
    await lockPostingAccounts([from], session);
  }
  const arrived = input.arrived !== false;
  const cny = Number(input.cnyReceived || input.cnyExpected);
  if (!(cny > 0)) throw fail('كمية اليوان مطلوبة');
  const reconciliation = require('./alipayReconciliation');
  // Contend with statement imports before checking their already posted wallet movements.
  await Account.updateOne({ _id: to._id }, { $inc: { postingVersion: 1 } }, { session });
  const transactionReference = arrived ? await reconciliation.beforeRecording(to._id, await toCurrencyMinor(cny, 'CNY'), input.day, input.transactionReference, session) : '';

  const rates = new RateBook(session);
  // The dollars that left: the payment's own value (a dinar or lira account at its average rate)
  const usd = await valueOut(from, paidMinor, { day: input.day, docRate: input.rate, rates });
  if (!(usd > 0)) throw fail('تعذّر تحديد قيمة الدفعة بالدولار');
  const [doc] = await YuanPurchase.create([{
    vendorId: broker._id, day: input.day, fromAccountId: from._id, currency: currencyOf(from), amount: Number(input.amount), usd,
    toAccountId: to._id, cnyExpected: cny, ...(arrived && { cnyReceived: cny, arrivedDay: input.day }), arrived,
    rate: Math.round((cny / (usd / 100)) * 10000) / 10000,
    note: input.note, attachments: input.attachments, idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('CNY', input.day, session),
  }], { session });

  const label = `شراء يوان ${doc.number} من ${broker.name}`;
  const debit = arrived
    ? moneyLine(to, 'debit', await toCurrencyMinor(cny, 'CNY'), usd, { label })
    : { accountId: (await resolveAccount('yuan_in_transit'))._id, debit: usd, vendorId: broker._id, label: `${label} (بانتظار الوصول)` };
  const entry = await postEntry({
    eventType: 'YUAN_PURCHASE', eventKey: `YUAN_PURCHASE:${doc._id}`, date: input.day, description: label,
    source: { model: 'AccountingYuanPurchase', id: doc._id }, fallbacks: rates.fallbacks,
    lines: [debit, moneyLine(from, 'credit', paidMinor, usd, { label })],
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  if (arrived) await reconciliation.afterRecording(entry._id, to._id, transactionReference, { session, req });
  await logAudit({ req, action: 'alipay.purchase', model: 'AccountingYuanPurchase', docId: doc._id, after: doc }, session);
  return doc;
}

// The yuan arrived: the amount actually received goes into Alipay at the dollars already paid
async function completeYuanPurchase(id, input, { session, req }) {
  const doc = await YuanPurchase.findById(id).session(session);
  if (!doc || doc.status !== 'posted') throw fail('العملية غير موجودة أو ملغاة');
  if (doc.arrived) throw fail('اليوان وصل مسبقاً');
  const day = input.day || today();
  if (!isDay(day)) throw fail('التاريخ غير صالح');
  notFuture(day);
  const cny = Number(input.cnyReceived || doc.cnyExpected);
  if (!(cny > 0)) throw fail('الكمية الواصلة مطلوبة');
  const to = await alipayAccount(input.toAccountId || doc.toAccountId);
  const reconciliation = require('./alipayReconciliation');
  await Account.updateOne({ _id: to._id }, { $inc: { postingVersion: 1 } }, { session });
  const transactionReference = await reconciliation.beforeRecording(to._id, await toCurrencyMinor(cny, 'CNY'), day, input.transactionReference, session);
  const broker = await Vendor.findById(doc.vendorId).session(session);
  const label = `وصول يوان ${doc.number} من ${broker?.name || 'الوسيط'}`;
  const arrivalEntry = await postEntry({
    eventType: 'YUAN_ARRIVAL', eventKey: `YUAN_ARRIVAL:${doc._id}`, date: day, description: label,
    source: { model: 'AccountingYuanPurchase', id: doc._id },
    lines: [
      moneyLine(to, 'debit', await toCurrencyMinor(cny, 'CNY'), doc.usd, { label }),
      { accountId: (await resolveAccount('yuan_in_transit'))._id, credit: doc.usd, vendorId: doc.vendorId, label },
    ],
  }, { session, user: req?.user });
  Object.assign(doc, { arrived: true, arrivedDay: day, cnyReceived: cny, toAccountId: to._id, rate: Math.round((cny / (doc.usd / 100)) * 10000) / 10000 });
  await doc.save({ session });
  await reconciliation.afterRecording(arrivalEntry._id, to._id, transactionReference, { session, req });
  await logAudit({ req, action: 'alipay.arrival', model: 'AccountingYuanPurchase', docId: doc._id, after: { cny, day } }, session);
  return doc;
}

// Everything the Alipay screen shows
async function dashboard({ from, to, accountId } = {}) {
  const { accountsById, currencies } = await getConfig();
  const decimals = currencies.get('CNY')?.decimals ?? 2;
  const alipays = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup && a.currency === 'CNY');
  const accounts = [];
  for (const account of alipays) {
    const balance = await getBalance(account._id);
    accounts.push({
      _id: account._id, code: account.code, name: account.name, cny: balance.foreign, usd: balance.usd,
      rate: balance.foreign && balance.usd && Math.sign(balance.foreign) === Math.sign(balance.usd) ? Math.round(((balance.foreign / 10 ** decimals) / (balance.usd / 100)) * 10000) / 10000 : null,
    });
  }

  if (accountId && !alipays.some((a) => String(a._id) === String(accountId))) throw fail('اختر حساب Alipay صحيحًا');
  const accountScope = accountId ? { toAccountId: accountId } : {};
  const range = from || to ? { day: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {};
  const purchases = await YuanPurchase.find({ status: 'posted', ...range, ...accountScope }).sort({ day: -1 })
    .populate('vendorId', 'name').populate('fromAccountId', 'code name currency').populate('toAccountId', 'code name').lean();
  const brokers = new Map();
  purchases.filter((p) => p.arrived).forEach((p) => {
    const key = String(p.vendorId?._id || '');
    const row = brokers.get(key) || { vendorId: p.vendorId?._id, name: p.vendorId?.name, usd: 0, cny: 0, count: 0 };
    row.usd += p.usd;
    row.cny += Number(p.cnyReceived || 0);
    row.count += 1;
    brokers.set(key, row);
  });
  const pendingSince = addDays(today(), -PENDING_DAYS);
  const pending = (await YuanPurchase.find({ status: 'posted', arrived: false, ...accountScope }).sort({ day: 1 }).populate('vendorId', 'name').lean())
    .map((p) => ({ ...p, late: p.day < pendingSince }));

  // Orders marked as Alipay transfers: their revenue, cost and profit
  const [revenue, cost] = await Promise.all([resolveAccount('revenue_remittance'), resolveAccount('cost_remittance')]);
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': { $in: [revenue._id, cost._id] }, ...range } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: [revenue._id, cost._id] } } },
    {
      $group: {
        _id: { orderId: '$lines.orderId', month: { $substrCP: ['$day', 0, 7] } },
        revenue: { $sum: { $cond: [{ $eq: ['$lines.accountId', revenue._id] }, { $subtract: ['$lines.credit', '$lines.debit'] }, 0] } },
        cost: { $sum: { $cond: [{ $eq: ['$lines.accountId', cost._id] }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } },
      },
    },
  ]);
  const orderIds = [...new Set(rows.map((r) => String(r._id.orderId)).filter(mongoose.isValidObjectId))];
  const orders = new Map((await Order.find({ _id: { $in: orderIds } }).setOptions({ withDeleted: true }).select('orderId user customerInfo.fullName createdAt').lean()).map((o) => [String(o._id), o]));
  const byOrder = new Map();
  const months = new Map();
  rows.forEach((row) => {
    const key = String(row._id.orderId);
    const order = orders.get(key);
    const item = byOrder.get(key) || { orderId: row._id.orderId, orderNumber: order?.orderId, customer: order?.customerInfo?.fullName, userId: order?.user, revenue: 0, cost: 0 };
    item.revenue += row.revenue;
    item.cost += row.cost;
    byOrder.set(key, item);
    const month = months.get(row._id.month) || { month: row._id.month, revenue: 0, cost: 0, boughtUsd: 0, boughtCny: 0 };
    month.revenue += row.revenue;
    month.cost += row.cost;
    months.set(row._id.month, month);
  });
  purchases.forEach((p) => {
    const key = p.day.slice(0, 7);
    const month = months.get(key) || { month: key, revenue: 0, cost: 0, boughtUsd: 0, boughtCny: 0 };
    month.boughtUsd += p.usd;
    month.boughtCny += Number(p.cnyReceived || p.cnyExpected || 0);
    months.set(key, month);
  });
  const transfers = [...byOrder.values()].map((t) => ({ ...t, profit: t.revenue - t.cost })).sort((a, b) => b.revenue - a.revenue);
  const customers = new Map();
  transfers.forEach((t) => {
    const key = String(t.userId || t.customer || '');
    const row = customers.get(key) || { userId: t.userId, customer: t.customer, count: 0, revenue: 0, cost: 0, profit: 0 };
    Object.assign(row, { count: row.count + 1, revenue: row.revenue + t.revenue, cost: row.cost + t.cost, profit: row.profit + t.profit });
    customers.set(key, row);
  });
  return {
    accounts,
    purchases: purchases.map((p) => ({ ...p, broker: p.vendorId?.name })),
    brokers: [...brokers.values()].map((b) => ({ ...b, rate: b.usd ? Math.round((b.cny / (b.usd / 100)) * 10000) / 10000 : null })),
    pending,
    transfers,
    customers: [...customers.values()].sort((a, b) => b.profit - a.profit),
    months: [...months.values()].map((m) => ({ ...m, profit: m.revenue - m.cost })).sort((a, b) => b.month.localeCompare(a.month)),
    pendingDays: PENDING_DAYS,
  };
}

module.exports = { createYuanPurchase, completeYuanPurchase, dashboard, PENDING_DAYS };

// ---- Sending yuan for an order marked as an Alipay transfer (owner's decision, v8) ----
// One step from the order page or the Alipay page: the yuan go out of an Alipay account to the
// customer's supplier as the order's purchase cost, valued at the account's average rate (a
// supplier bill paid on the spot is created behind it).

async function remittanceVendor(session) {
  const name = 'Alipay - حوالات العملاء';
  return (await Vendor.findOne({ name }).session(session)) || (await Vendor.create([{ name, type: 'service', defaultCurrency: 'CNY' }], { session }))[0];
}

async function remittanceStatus(orderId, { session } = {}) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلب غير موجود');
  const order = await Order.findById(orderId).select('orderId isRemittance isCanceled totalInvoice purchaseItems').session(session || null).lean();
  if (!order) throw fail('الطلب غير موجود');
  const { accountsById, currencies } = await getConfig();
  const decimals = currencies.get('CNY')?.decimals ?? 2;
  const alipays = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup && a.isActive && a.currency === 'CNY');
  const accounts = [];
  for (const account of alipays) {
    const balance = await getBalance(account._id, { session });
    accounts.push({ _id: account._id, name: account.name, cny: balance.foreign / 10 ** decimals, usd: balance.usd, rate: balance.foreign && balance.usd && Math.sign(balance.foreign) === Math.sign(balance.usd) ? Math.round(((balance.foreign / 10 ** decimals) / (balance.usd / 100)) * 10000) / 10000 : null });
  }
  const { SupplierBill } = require('../../models/documents');
  const bills = await SupplierBill.find({ 'lines.orderId': order._id, status: 'posted', currency: 'CNY', paidImmediatelyFrom: { $in: alipays.map((a) => a._id) } })
    .select('number day lines total totalUsd paidImmediatelyFrom alipayValuationEntryId alipayValuationUsd alipayValuationAdjustmentUsd alipayValuationProvisional').sort({ day: 1 }).session(session || null).lean();
  const sent = bills.map((bill) => {
    const orderCny = (bill.lines || []).filter((line) => line.target === 'order' && String(line.orderId) === String(order._id))
      .reduce((sum, line) => sum + Number(line.amount || 0), 0);
    return { ...bill, orderCny, account: accountsById.get(String(bill.paidImmediatelyFrom))?.name };
  });
  const sentCny = sent.reduce((sum, bill) => sum + bill.orderCny, 0);
  const typedCny = (order.purchaseItems || []).filter((i) => i.currency === 'CNY').reduce((sum, i) => sum + Number(i.unitPrice || 0), 0);
  return {
    order: { _id: order._id, orderId: order.orderId, isRemittance: !!order.isRemittance, isCanceled: !!order.isCanceled, totalInvoice: order.totalInvoice },
    accounts, sent,
    sentCny, typedCny, suggestedCny: Math.max(Math.round((typedCny - sentCny) * 100) / 100, 0),
  };
}

async function sendRemittance(orderId, input, { session, req }) {
  // Returning the same successful request must precede balance and duplicate checks.
  if (input.idempotencyKey) {
    const existing = await findExisting(require('../../models/documents').SupplierBill, input.idempotencyKey, session);
    if (existing) {
      if (!existing.lines.some(line => String(line.orderId) === String(orderId)) || String(existing.paidImmediatelyFrom) !== String(input.accountId)) throw fail('مرجع الطلب مستخدم لعملية أخرى');
      return existing;
    }
  }
  const status = await remittanceStatus(orderId, { session });
  if (!status.order.isRemittance) throw fail('الطلب غير معلَّم «حوالة Alipay»؛ علّمه من فاتورة الشراء أولاً');
  if (status.order.isCanceled) throw fail('الطلب ملغى');
  const account = status.accounts.find((a) => String(a._id) === String(input.accountId));
  if (!account) throw fail('اختر حساب Alipay');
  const cny = Number(input.cny);
  const cnyMinor = await toCurrencyMinor(cny, 'CNY');
  if (!cnyMinor) throw fail('اكتب اليوان المرسل');
  // Serialize sends so concurrent remittances use a consistent carrying valuation.
  // Negative balances are allowed while deposits and statements await reconciliation.
  const locked = await Account.updateOne(
    { _id: account._id, isCash: true, isActive: true, currency: 'CNY' },
    { $inc: { postingVersion: 1 } },
    { session },
  );
  if (locked.modifiedCount !== 1) throw fail('حساب Alipay غير متاح للإرسال');
  const day = input.day || today();
  if (!isDay(day)) throw fail('التاريخ غير صالح');
  notFuture(day);
  const reconciliation = require('./alipayReconciliation');
  const transactionReference = await reconciliation.beforeRecording(account._id, -cnyMinor, day, input.transactionReference, session);
  const normalizedCny = cnyMinor / (10 ** await decimalsOf('CNY'));
  const vendor = await remittanceVendor(session);
  const { createBill } = require('./payables');
  const bill = await createBill({
    vendorId: vendor._id, day, currency: 'CNY', paidImmediatelyFrom: account._id, enteredFrom: 'order', idempotencyKey: input.idempotencyKey || undefined,
    note: input.note || undefined,
    lines: [{ description: `حوالة Alipay - طلب ${status.order.orderId}`, amount: normalizedCny, target: 'order', orderId: status.order._id }],
  }, { session, req });
  const payment = await require('../../models/documents').SupplierPayment.findById(bill.paymentId).session(session).lean();
  if (payment?.entryId) await reconciliation.afterRecording(payment.entryId, account._id, transactionReference, { session, req });
  return bill;
}

module.exports.remittanceStatus = remittanceStatus;
module.exports.sendRemittance = sendRemittance;
