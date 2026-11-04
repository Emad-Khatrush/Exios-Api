const { SupplierBill } = require('../../models/documents');
const { JournalEntry } = require('../../models');
const { originalOf } = require('./bankAmounts');
const { addDays } = require('../dates');
const clean = value => String(value || '').toLocaleLowerCase('tr').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const findBills = (currency, from, to, session) => SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true }, currency,
  day: { $gte: from, $lte: to } }).populate('vendorId', 'name').populate('lines.orderId', 'orderId').session(session || null).lean();

// The open payable of many bills in one query (same sum as payables.apBalance, per bill)
async function apBalances(billIds, session) {
  const { billKey } = require('./payables');
  const keys = billIds.map(id => billKey(id));
  if (!keys.length) return new Map();
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.apKey': { $in: keys } } },
    { $unwind: '$lines' },
    { $match: { 'lines.apKey': { $in: keys } } },
    { $group: { _id: '$lines.apKey', balance: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null);
  const byKey = new Map(rows.map(row => [row._id, row.balance || 0]));
  return new Map(billIds.map((id, index) => [String(id), byKey.get(keys[index]) || 0]));
}

// For reading many statement lines at once (suggestions, the import preview): the bills of the
// whole date range are read once per currency, with all their open balances in one query,
// instead of again for every line. Read-only; results are the same as without it.
function billCache(days, session) {
  const sorted = days.filter(Boolean).sort();
  const from = sorted.length ? addDays(sorted[0], -7) : null;
  const to = sorted.length ? addDays(sorted[sorted.length - 1], 7) : null;
  const byCurrency = new Map();
  const balances = new Map();
  const load = async (currency) => {
    const bills = await findBills(currency, from, to, session).exec();
    const open = await apBalances(bills.filter(bill => bill.status === 'posted').map(bill => bill._id), session);
    open.forEach((balance, id) => balances.set(id, balance));
    return bills;
  };
  return {
    bills(currency, dayFrom, dayTo) {
      if (!from || dayFrom < from || dayTo > to) return findBills(currency, dayFrom, dayTo, session);
      if (!byCurrency.has(currency)) byCurrency.set(currency, load(currency));
      return byCurrency.get(currency).then(bills => bills.filter(bill => bill.day >= dayFrom && bill.day <= dayTo));
    },
    async open(billId) {
      const key = String(billId);
      if (!balances.has(key)) {
        const { apBalance, billKey } = require('./payables');
        balances.set(key, await apBalance(billKey(billId), session));
      }
      return balances.get(key);
    },
  };
}

async function candidatesFor(line, bank, { session, vendorName, counterAccountId, cache } = {}) {
  if (line.amount >= 0) return [];
  const original = originalOf(line, bank.currency || 'USD');
  const from = addDays(line.day, -7), to = addDays(line.day, 7);
  // Copies: the cached bills are shared between lines
  const bills = cache ? (await cache.bills(original.currency, from, to)).map(bill => ({ ...bill })) : await findBills(original.currency, from, to, session);
  const description = clean(line.description); const name = clean(vendorName);
  const eligible = [];
  const { apBalance, billKey } = require('./payables');
  for (const bill of bills) {
    if (counterAccountId && !bill.lines.every(l => l.target === 'expense' && String(l.accountId) === String(counterAccountId))) continue;
    bill.openUsd = bill.status === 'posted' ? await (cache ? cache.open(bill._id) : apBalance(billKey(bill._id), session)) : null;
    if (bill.status === 'posted' && bill.openUsd <= 0) continue;
    eligible.push(bill);
  }
  return eligible.filter(b => Math.abs((b.total ?? b.lines.reduce((sum, item) => sum + Number(item.amount), 0)) - original.amount) < 0.0005)
    .map(b => {
      const vendor = clean(b.vendorId?.name);
      const referenceMatch = !!(b.vendorRef && line.reference && b.vendorRef === line.reference);
      const identified = referenceMatch
        || !!(vendor && (vendor === name || (vendor.length >= 3 && description.includes(vendor))
          || (bank.cashKind === 'current' && vendor.length >= 3 && clean(bank.name).includes(vendor))));
      const dayDifference = Math.abs((Date.parse(line.day) - Date.parse(b.day)) / 86400000);
      return { ...b, identified, referenceMatch, dayDifference, matchReasons: ['المبلغ الأصلي مطابق', 'العملة الأصلية مطابقة',
        dayDifference === 0 ? 'نفس تاريخ العملية' : `فرق التاريخ ${dayDifference} أيام`,
        ...(identified ? ['اسم المورد أو مرجع العملية مطابق'] : [])] };
    }).sort((a, b) => Number(b.referenceMatch) - Number(a.referenceMatch) || Number(b.identified) - Number(a.identified)
      || a.dayDifference - b.dayDifference || String(a._id).localeCompare(String(b._id)));
}

const brief = bill => ({ _id: bill._id, number: bill.number || 'مسودة', day: bill.day, currency: bill.currency,
  expenseAccountIds: [...new Set(bill.lines.filter(l => l.target === 'expense' && l.accountId).map(l => String(l.accountId)))],
  hasNonExpenseTargets: bill.lines.some(l => l.target !== 'expense'),
  vendorId: bill.vendorId?._id || bill.vendorId,
  amount: bill.total ?? bill.lines.reduce((s, l) => s + Number(l.amount), 0), vendorName: bill.vendorId?.name, status: bill.status,
  isHistorical: !!bill.isHistorical, openUsd: bill.openUsd === null ? null : bill.openUsd / 100,
  matchReasons: bill.matchReasons, dayDifference: bill.dayDifference,
  descriptions: bill.lines.map(l => l.description).filter(Boolean),
  orders: bill.lines.filter(l => l.orderId).map(l => ({ _id: l.orderId._id || l.orderId,
    number: l.orderId.orderId || '', description: l.description, amount: l.amount, currency: bill.currency })) });

async function selectBill(line, bank, input, session) {
  if (input.manualBillMatch) {
    const bill = await SupplierBill.findById(input.billId).session(session).lean();
    if (!bill || !['draft', 'posted'].includes(bill.status) || bill.isCreditNote) throw new Error('الفاتورة غير متاحة');
    const { validateChoice, amountOf } = require('./bankPurchaseReview');
    validateChoice(line, bank, { day: bill.day, amount: amountOf(bill), currency: bill.currency }, input.confirmDifference === true);
    return bill;
  }
  const candidates = await candidatesFor(line, bank, { session, vendorName: input.vendorName, counterAccountId: input.expenseCounterAccountId });
  if (input.billId) {
    const selected = candidates.find(b => String(b._id) === String(input.billId));
    if (!selected) throw new Error('الفاتورة المختارة لا تطابق مبلغ العملية بعملتها الأصلية وتاريخها');
    return selected;
  }
  if (input.confirmNewBill) return null;
  if (candidates.length) throw new Error('توجد فواتير مورد محتملة لهذه العملية؛ اختر الفاتورة الأصلية قبل الترحيل لمنع تكرار التكلفة');
  return null;
}

module.exports = { candidatesFor, billCache, brief, selectBill };
