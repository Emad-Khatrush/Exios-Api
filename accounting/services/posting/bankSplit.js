// One outgoing statement line split into parts (owner's request 2026-11-10): several expense
// accounts (a transfer to the accountant holding her fee and the chamber of commerce's), or the
// months it pays for (51,500 TRY paid in July for January to May). Posting a line as a new
// operation takes one account on the line's day, so such a line had its cost in the wrong account
// or the wrong month, or five bills were typed by hand first.
//
// Each part has its own day, expense account, office and amount, in the bank's currency; the parts
// add up to the line exactly. The parts of one day make one supplier bill on that day, in the
// bank's currency at that day's rate; then the line pays those bills in full like any line paying
// several bills (bankBillsPay): one payment, the line matched to it. Unmatching the line cancels
// the payment and leaves the bills unpaid, to be paid again from the line or cancelled.
const mongoose = require('mongoose');
const { BankStatementLine, SupplierBill, Vendor } = require('../../models/documents');
const { Account } = require('../../models');
const { getConfig } = require('../config');
const { isDay } = require('../dates');
const { logAudit } = require('../audit');
const { fail, officeExists, resolveAccount } = require('./common');

const MAX_PARTS = 60;

async function apply(lineId, input, { session, req }) {
  const bank = require('./bank');
  const payables = require('./payables');
  if (!mongoose.isValidObjectId(lineId)) throw fail('سطر الكشف غير موجود');
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  if (line.amount >= 0) throw fail('التقسيم لسطر صادر فقط');
  require('./bankEvidence').assertReviewed(line);
  const account = await Account.findById(line.accountId).session(session).lean();
  if (!account?.isCash || !account.isActive) throw fail('حساب البنك غير متاح');
  const config = await getConfig();
  if (require('./bankTransferHints').describe(line, account, [...config.accountsById.values()])?.semanticTransfer)
    throw fail('هذه حركة تحويل أو تسوية بين حسابات الشركة؛ لا تُقسَّم كمصروفات');
  if (!input.confirmNotDuplicate) {
    const twins = await bank.possibleDuplicates(line, session);
    if (twins.length) throw fail(`قد يكون هذا السطر مسجلاً في الدفاتر: ${twins.slice(0, 3).map(t => `${t.number} (${t.day})`).join('، ')}. طابقه معه بدل إنشاء تكلفة جديدة.`);
  }
  // Bills of an earlier split of this very line, left unpaid when the line was unmatched: splitting again would add their cost twice
  const earlier = await SupplierBill.find({ idempotencyKey: new RegExp(`^BANK_SPLIT:${line._id}:`), status: 'posted' }).select('number idempotencyKey').session(session).lean();
  const openEarlier = [];
  for (const bill of earlier) if (await payables.apBalance(payables.billKey(bill._id), session) > 0) openEarlier.push(bill.number);
  if (openEarlier.length) throw fail(`لهذا السطر فواتير من تقسيم سابق لم تُسدَّد (${openEarlier.join('، ')}): سدّدها من «سداد فواتير موردين» أو ألغها قبل تقسيمه من جديد`);

  const vendor = mongoose.isValidObjectId(input.vendorId) ? await Vendor.findById(input.vendorId).session(session).lean() : null;
  if (!vendor?.isActive) throw fail('اختر المورد');
  const currency = account.currency || 'USD';
  const unit = 10 ** (config.currencies.get(currency)?.decimals ?? 2);
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (parts.length < 2) throw fail('التقسيم يحتاج جزأين على الأقل');
  if (parts.length > MAX_PARTS) throw fail(`أكثر من ${MAX_PARTS} جزءاً؛ قسّم السطر على أجزاء أقل`);
  const purchaseCost = String((await resolveAccount('cost_purchase_invoices'))._id);
  let total = 0;
  const byDay = new Map();
  for (const [index, part] of parts.entries()) {
    const where = `الجزء ${index + 1}`;
    const day = part.day || line.day;
    if (!isDay(day)) throw fail(`${where}: التاريخ غير صالح`);
    if (day > line.day) throw fail(`${where}: تاريخه بعد تاريخ الدفع ${line.day}؛ مصروف الأشهر القادمة يُسجَّل «مصروف مقدم» من فاتورة مورد`);
    const expense = mongoose.isValidObjectId(part.accountId) ? config.accountsById.get(String(part.accountId)) : null;
    if (!expense || expense.isGroup || expense.type !== 'expense' || expense.isActive === false) throw fail(`${where}: اختر حساب مصروف`);
    if (String(expense._id) === purchaseCost) throw fail(`${where}: تكلفة مشتريات الطلبيات تُربط بطلبيتها من «سداد مشتريات»، لا من التقسيم`);
    if (!(await officeExists(part.office))) throw fail(`${where}: المكتب مطلوب`);
    const description = String(part.description || '').trim().slice(0, 300);
    if (!description) throw fail(`${where}: الوصف مطلوب`);
    const minor = Math.round(Number(part.amount) * unit);
    if (!Number.isFinite(minor) || minor <= 0 || Math.abs(Number(part.amount) * unit - minor) > 1e-6) throw fail(`${where}: المبلغ غير صالح`);
    total += minor;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ target: 'expense', accountId: expense._id, office: part.office, description, amount: minor / unit });
  }
  const paid = -line.amount;
  if (total !== paid) throw fail(`مجموع الأجزاء ${(total / unit).toLocaleString('en-US')} ${currency} لا يساوي مبلغ السطر ${(paid / unit).toLocaleString('en-US')} ${currency}`);

  // A line split again after its first split was undone and its bills cancelled gets new bills
  const attempt = (await SupplierBill.find({ idempotencyKey: new RegExp(`^BANK_SPLIT:${line._id}:`) }).select('idempotencyKey').session(session).lean())
    .reduce((next, bill) => Math.max(next, (Number(bill.idempotencyKey.split(':')[2]) || 0) + 1), 0);
  const costDuplicates = require('../costDuplicates');
  const bills = [];
  for (const day of [...byDay.keys()].sort()) {
    const data = { vendorId: vendor._id, day, currency, lines: byDay.get(day) };
    // A cost of this vendor already in the books with a part's amount and week (bills typed by
    // hand before the statement came): paid from the line, not added again. The parts themselves
    // are alike by design (the same fee each month) and are no duplicates of each other.
    const alike = await costDuplicates.preview(data, { session });
    const mine = new Set(bills.map(bill => String(bill._id)));
    const others = alike.results.filter(row => !mine.has(String(row.billId)));
    if (others.length && !input.confirmNewCost) throw fail(`توجد تكلفة محتملة مسجلة سابقاً لهذا المورد (${others.map(row => `${row.number} · ${row.day}`).join('، ')}): سدّدها من «سداد فواتير موردين» بدل تقسيم السطر، أو أكّد أن الأجزاء تكلفة أخرى.`);
    bills.push(await payables.createBill({
      ...data,
      note: `من كشف ${account.name}: جزء من حركة ${line.day} (${(paid / unit).toLocaleString('en-US')} ${currency}) — ${line.description}`.slice(0, 500),
      idempotencyKey: `BANK_SPLIT:${line._id}:${attempt}:${day}`,
      ...(alike.results.length && { duplicateDecision: 'independent', duplicateFingerprint: alike.fingerprint,
        duplicateReason: `أجزاء حركة الكشف ${line.description} (${line.day}) المقسّمة على تواريخها` }),
    }, { session, req }));
  }
  const result = await require('./bankBillsPay').apply(line._id, { billIds: bills.map(bill => String(bill._id)), note: 'تقسيم سطر الكشف' }, { session, req });
  await require('./bankMerchants').learn(line, vendor._id, null, session);
  await logAudit({ req, action: 'bank.split', model: 'AccountingBankStatementLine', docId: line._id,
    after: { vendorId: vendor._id, billIds: bills.map(bill => bill._id), parts: parts.length } }, session);
  return { ...result, bills: bills.map(bill => ({ _id: bill._id, number: bill.number, day: bill.day, total: bill.total })) };
}

module.exports = { apply };
