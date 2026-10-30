const { JournalEntry } = require('../models');
const { SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
const { getConfig } = require('./config');
const { addDays } = require('./dates');
const { originalOf } = require('./posting/bankAmounts');
const { resolveAccount } = require('./posting/common');
const { GENERIC_VENDORS } = require('./posting/bankMatchValidation');
const id = v => String(v?._id || v || '');
const distance = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const numbers = text => Array.from(String(text || '').matchAll(/(?:رحلة|رحله|دبي|دبى|الصين|تركيا)\s*(\d+)/g), m => m[1]);
function compareTrips(description, trips) {
  const statementNumbers = numbers(description), tripNumbers = trips.flatMap(t => numbers(t.voyage || t.number));
  const tripMatch = statementNumbers.some(n => tripNumbers.includes(n));
  return { tripMatch, tripConflict: !!statementNumbers.length && !!tripNumbers.length && !tripMatch };
}

// Potential matches are shown even when their payment cannot safely be linked.
// Neither amount/date nor trip numbers alone approve a match.
async function candidates(lines, bank, trips, vendorId, session) {
  const result = new Map(lines.map(l => [id(l), []]));
  if (!lines.length || !trips.length) return result;
  const days = lines.map(l => l.day).sort();
  const bills = await SupplierBill.find({ status: 'posted', isCreditNote: { $ne: true },
    'lines.tripId': { $in: trips.map(t => t._id) },
    day: { $gte: addDays(days[0], -7), $lte: addDays(days[days.length - 1], 7) },
  }).populate('vendorId', 'name seedKey').populate('lines.tripId', 'voyage').session(session || null).lean();
  const keys = bills.map(b => `BILL:${b._id}`);
  const balances = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $match: { 'lines.apKey': { $in: keys } } },
    { $group: { _id: '$lines.apKey', net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null);
  const open = new Map(balances.map(b => [b._id, b.net]));
  const payments = await SupplierPayment.find({ status: 'posted', 'allocations.billId': { $in: bills.map(b => b._id) } }).session(session || null).lean();
  const used = await BankStatementLine.find({ lineStatus: { $in: ['matched', 'created_entry'] }, billId: { $in: bills.map(b => b._id) } }).select('billId').session(session || null).lean();
  const usedBills = new Set(used.map(l => id(l.billId)));
  const available = await require('./posting/bank').unmatchedMovements(bank._id, { session });
  const config = await getConfig();
  const suspense = await resolveAccount('migration_suspense'), opening = await resolveAccount('opening_balance');
  for (const line of lines) {
    const original = originalOf(line, bank.currency || 'USD', config.currencies.get(bank.currency || 'USD')?.decimals ?? 2);
    for (const bill of bills) {
      const amount = bill.total ?? bill.lines.reduce((s, l) => s + Number(l.amount), 0);
      if (bill.currency !== original.currency || Math.abs(amount - original.amount) > 0.0005 || distance(bill.day, line.day) > 7) continue;
      const linkedTrips = bill.lines.filter(l => l.tripId).map(l => ({ _id: l.tripId._id, voyage: l.tripId.voyage }));
      const { tripMatch, tripConflict } = compareTrips(line.description, linkedTrips);
      const generic = GENERIC_VENDORS.includes(bill.vendorId?.seedKey);
      const expectedVendor = typeof vendorId === 'function' ? vendorId(line) : vendorId;
      const vendorMatch = !!expectedVendor && id(bill.vendorId) === id(expectedVendor);
      const vendorConflict = !!expectedVendor && !vendorMatch && !generic;
      const referenceMatch = !!line.reference && bill.vendorRefKind !== 'bank' && line.reference === bill.vendorRef;
      const outstanding = open.get(`BILL:${bill._id}`) || 0;
      const billPayments = payments.filter(p => p.allocations.some(a => id(a.billId) === id(bill)));
      const count = config.count;
      const beforeCount = count?.accountIds.has(id(bank)) && (line.day < count.day || (line.day === count.day && count.endOfDay));
      let mode = '', problem = '';
      if (!bill.vendorId?._id) problem = 'مورد الفاتورة غير موجود؛ راجع بياناتها أولًا';
      else if (usedBills.has(id(bill))) problem = 'الفاتورة مرتبطة بسطر كشف آخر؛ راجع الربط السابق';
      else if (outstanding > 0 && outstanding === bill.totalUsd) mode = 'pay_bill';
      else if (outstanding > 0) problem = 'الفاتورة مسددة جزئيًا؛ راجع الدفعات قبل ربط كامل المبلغ';
      else if (beforeCount && bill.day <= count.day && (bill.paidBeforeCount || (billPayments.length && billPayments.every(p => p.day <= count.day && [id(bank), id(suspense), id(opening)].includes(id(p.fromAccountId)))))) mode = 'historical_covered';
      else if (available.filter(e => e.amount === line.amount && billPayments.some(p => id(p.fromAccountId) === id(bank) && id(p.entryId) === id(e))).length === 1) mode = 'existing_payment';
      else if (await require('./posting/historicalBankSettlement').inspect({ ...bill, vendorId: bill.vendorId._id }, bank, line, { session })) mode = 'historical_settlement';
      else problem = 'السداد السابق غير متاح لهذا الحساب؛ راجعه من مطابقة البنك، ولا تسجل التكلفة ثانية';
      result.get(id(line)).push({ billId: bill._id, number: bill.number, day: bill.day, amount, currency: bill.currency,
        trips: linkedTrips, vendorName: bill.vendorId?.name, vendorMatch, vendorIdentified: vendorMatch && !generic, vendorUnidentified: generic, vendorConflict, tripMatch, tripConflict,
        referenceMatch, dayDifference: distance(bill.day, line.day), mode, canMatch: !!mode, problem,
        payments: billPayments.map(p => ({ number: p.number, day: p.day, account: config.accountsById.get(id(p.fromAccountId))?.name || 'رصيد مقدم/حساب غير محدد' })),
        // Include relevant versions/payment identities in the preview fingerprint.
        version: { bill: bill.updatedAt, outstanding, payments: billPayments.map(p => [p._id, p.updatedAt, p.entryId, p.historicalSettlementVersion]) },
      });
    }
    result.get(id(line)).sort((a, b) => Number(b.canMatch) - Number(a.canMatch) || Number(b.referenceMatch) - Number(a.referenceMatch)
      || Number(b.tripMatch) - Number(a.tripMatch) || Number(a.vendorConflict) - Number(b.vendorConflict)
      || a.dayDifference - b.dayDifference || id(a.billId).localeCompare(id(b.billId)));
  }
  // A clear proposal is one-to-one and matches the trip, currency, amount and day.
  const frequencies = new Map();
  for (const rows of result.values()) for (const r of rows) frequencies.set(id(r.billId), (frequencies.get(id(r.billId)) || 0) + 1);
  for (const rows of result.values()) for (const r of rows) {
    r.suggested = rows.length === 1 && r.canMatch && r.tripMatch && !r.vendorConflict && !r.tripConflict && r.dayDifference === 0 && frequencies.get(id(r.billId)) === 1;
    r.clear = r.suggested && (r.vendorIdentified || r.referenceMatch);
  }
  return result;
}
module.exports = { candidates, compareTrips };
