// The Alipay section (spec 19.5, phase C1). The company buys yuan from brokers (Wasl, Safe
// Caravan...) with dollars or other currencies and sends it to customers' Chinese suppliers. The
// profit is the difference between what the customer pays and the yuan's cost.
//
// A yuan purchase: the dollars paid and the yuan received set its rate (yuan / dollar), and the
// Alipay account's average carrying rate follows. When the yuan has not arrived yet, the dollars
// wait on "yuan in transit" against the broker until the arrival is confirmed with the actual
// amount (a different amount only changes the rate, never the dollars).
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { YuanPurchase, Vendor } = require('../../models/documents');
const Order = require('../../../models/order');
const { postEntry } = require('../ledger');
const { isDay, today, addDays } = require('../dates');
const { logAudit } = require('../audit');
const { getBalance } = require('../carrying');
const { getConfig } = require('../config');
const {
  fail, currencyOf, getAccount, toCurrencyMinor, RateBook, valueOut, moneyLine, nextDocNumber, findExisting, resolveAccount,
} = require('./common');

const PENDING_DAYS = 7;

async function alipayAccount(id) {
  const account = await getAccount(id, 'حساب Alipay');
  if (!account.isCash || currencyOf(account) !== 'CNY') throw fail('اختر حساب Alipay باليوان');
  return account;
}

async function createYuanPurchase(input, { session, req }) {
  const existing = await findExisting(YuanPurchase, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const broker = await Vendor.findById(input.vendorId).session(session);
  if (!broker) throw fail('اختر الوسيط');
  const from = await getAccount(input.fromAccountId, 'الحساب الدافع');
  if (!from.isCash) throw fail('ادفع من خزينة أو بنك أو حساب جارٍ');
  const to = await alipayAccount(input.toAccountId);
  const paidMinor = await toCurrencyMinor(input.amount, currencyOf(from));
  if (!paidMinor) throw fail('المبلغ المدفوع مطلوب');
  const arrived = input.arrived !== false;
  const cny = Number(input.cnyReceived || input.cnyExpected);
  if (!(cny > 0)) throw fail('كمية اليوان مطلوبة');

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
  const cny = Number(input.cnyReceived || doc.cnyExpected);
  if (!(cny > 0)) throw fail('الكمية الواصلة مطلوبة');
  const to = await alipayAccount(input.toAccountId || doc.toAccountId);
  const broker = await Vendor.findById(doc.vendorId).session(session);
  const label = `وصول يوان ${doc.number} من ${broker?.name || 'الوسيط'}`;
  await postEntry({
    eventType: 'YUAN_ARRIVAL', eventKey: `YUAN_ARRIVAL:${doc._id}`, date: day, description: label,
    source: { model: 'AccountingYuanPurchase', id: doc._id },
    lines: [
      moneyLine(to, 'debit', await toCurrencyMinor(cny, 'CNY'), doc.usd, { label }),
      { accountId: (await resolveAccount('yuan_in_transit'))._id, credit: doc.usd, vendorId: doc.vendorId, label },
    ],
  }, { session, user: req?.user });
  Object.assign(doc, { arrived: true, arrivedDay: day, cnyReceived: cny, toAccountId: to._id, rate: Math.round((cny / (doc.usd / 100)) * 10000) / 10000 });
  await doc.save({ session });
  await logAudit({ req, action: 'alipay.arrival', model: 'AccountingYuanPurchase', docId: doc._id, after: { cny, day } }, session);
  return doc;
}

// Everything the Alipay screen shows
async function dashboard({ from, to } = {}) {
  const { accountsById, currencies } = await getConfig();
  const decimals = currencies.get('CNY')?.decimals ?? 2;
  const alipays = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup && a.currency === 'CNY');
  const accounts = [];
  for (const account of alipays) {
    const balance = await getBalance(account._id);
    accounts.push({
      _id: account._id, code: account.code, name: account.name, cny: balance.foreign, usd: balance.usd,
      rate: balance.usd > 0 ? Math.round(((balance.foreign / 10 ** decimals) / (balance.usd / 100)) * 10000) / 10000 : null,
    });
  }

  const range = from || to ? { day: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {};
  const purchases = await YuanPurchase.find({ status: 'posted', ...range }).sort({ day: -1 }).limit(500)
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
  const pending = (await YuanPurchase.find({ status: 'posted', arrived: false }).sort({ day: 1 }).populate('vendorId', 'name').lean())
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
    purchases: purchases.slice(0, 100).map((p) => ({ ...p, broker: p.vendorId?.name })),
    brokers: [...brokers.values()].map((b) => ({ ...b, rate: b.usd ? Math.round((b.cny / (b.usd / 100)) * 10000) / 10000 : null })),
    pending,
    transfers,
    customers: [...customers.values()].sort((a, b) => b.profit - a.profit),
    months: [...months.values()].map((m) => ({ ...m, profit: m.revenue - m.cost })).sort((a, b) => b.month.localeCompare(a.month)),
    pendingDays: PENDING_DAYS,
  };
}

module.exports = { createYuanPurchase, completeYuanPurchase, dashboard, PENDING_DAYS };
