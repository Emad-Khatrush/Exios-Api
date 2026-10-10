const { SupplierBill } = require('../../models/documents');
const { originalOf } = require('./bankAmounts');
const { addDays } = require('../dates');
const clean = value => String(value || '').toLocaleLowerCase('tr').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function candidatesFor(line, bank, { session, vendorName } = {}) {
  if (line.amount >= 0) return [];
  const original = originalOf(line, bank.currency || 'USD');
  const bills = await SupplierBill.find({ status: { $in: ['draft', 'posted'] }, isCreditNote: { $ne: true }, currency: original.currency,
    day: { $gte: addDays(line.day, -7), $lte: addDays(line.day, 7) } }).populate('vendorId', 'name')
    .populate('lines.orderId', 'orderId').session(session || null).lean();
  const description = clean(line.description); const name = clean(vendorName);
  const eligible = [];
  const { apBalance, billKey } = require('./payables');
  for (const bill of bills) {
    bill.openUsd = bill.status === 'posted' ? await apBalance(billKey(bill._id), session) : null;
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
  const candidates = await candidatesFor(line, bank, { session, vendorName: input.vendorName });
  if (input.billId) {
    const selected = candidates.find(b => String(b._id) === String(input.billId));
    if (!selected) throw new Error('الفاتورة المختارة لا تطابق مبلغ العملية بعملتها الأصلية وتاريخها');
    return selected;
  }
  if (input.confirmNewBill) return null;
  if (candidates.length) throw new Error('توجد فواتير مورد محتملة لهذه العملية؛ اختر الفاتورة الأصلية قبل الترحيل لمنع تكرار التكلفة');
  return null;
}

module.exports = { candidatesFor, brief, selectBill };
