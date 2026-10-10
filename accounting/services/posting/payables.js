// Vendor bills, credit notes and payments (spec E14, E15, E23, E26, E31)
const mongoose = require('mongoose');
const { JournalEntry } = require('../../models');
const { Vendor, SupplierBill, SupplierPayment, SupplierReceipt, FixedAsset, PrepaidExpense } = require('../../models/documents');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const { postEntry } = require('../ledger');
const { isDay, monthOf } = require('../dates');
const { logAudit } = require('../audit');
const {
  fail, currencyOf, isForeign, getAccount, toCurrencyMinor, decimalsOf, RateBook, valueOut, moneyLine, addFxLine,
  nextDocNumber, findExisting, officeExists, resolveAccount, lockPostingAccounts,
} = require('./common');
const { getBalance, valueOutflow } = require('../carrying');

const TARGETS = ['order', 'trip', 'expense', 'asset', 'prepaid', 'customs'];
// Costs that exist only against an order: an Alipay transfer's yuan and a package's customs
// clearance. (Shipping and purchase costs may still be typed as plain expenses: bank rules post
// unlinked card purchases there.)
const ORDER_ONLY_COST_ROLES = ['cost_remittance', 'cost_customs'];

async function isOrderOnlyCost(account) {
  for (const role of ORDER_ONLY_COST_ROLES) {
    const roleAccount = await resolveAccount(role).catch(() => null);
    if (roleAccount && String(roleAccount._id) === String(account._id)) return true;
  }
  return false;
}
const MONTH = /^\d{4}-\d{2}$/;
const toId = (value) => new mongoose.Types.ObjectId(String(value));

// What is still owed on a vendor document key (credit - debit), in USD cents
async function apBalance(apKey, session) {
  const [row] = await JournalEntry.aggregate([
    { $match: { 'lines.apKey': apKey } },
    { $unwind: '$lines' },
    { $match: { 'lines.apKey': apKey } },
    { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
  ]).session(session || null);
  return row?.balance || 0;
}

const billKey = (billId) => `BILL:${billId}`;
const advanceKey = (vendorId) => `ADV:${vendorId}`;

function normalizeAllocations(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw fail('Invalid invoice allocations');
  const seen = new Set();
  return input.map((allocation) => {
    const raw = Number(allocation?.amountUsd);
    if (!mongoose.isValidObjectId(allocation?.billId) || !Number.isSafeInteger(raw) || raw <= 0) {
      throw fail('Each allocation needs a bill and a positive whole-cent amount');
    }
    const id = String(allocation.billId);
    if (seen.has(id)) throw fail('Do not repeat a bill in allocations; combine it into one line');
    seen.add(id);
    return { billId: toId(id), amountUsd: raw };
  });
}

// Concurrent allocations must contend on the same bill document, so a transaction retry
// rechecks the balance after the first payment has committed.
async function lockBillAllocation(bill, session) {
  const result = await SupplierBill.updateOne(
    { _id: bill._id, status: 'posted' },
    { $inc: { allocationVersion: 1 } },
    { session },
  );
  if (result.modifiedCount !== 1) throw fail('Bill is no longer available for allocation');
}

async function payableAccountFor(vendor) {
  return resolveAccount(vendor.type === 'carrier' ? 'payable_carriers' : 'payable_suppliers');
}

// Orders and trips a bill charges: their cost shares are re-checked after it posts or is cancelled
async function syncBillTargets(bill, { session, user, sync = {} }) {
  // Internal bulk posting performs one sync per trip after all bills are created.
  if (sync.defer === true) return;
  const { syncOrder, syncTrip } = require('../claims/sync');
  const orderIds = [...new Set(bill.lines.map((l) => l.orderId).filter(Boolean).map(String))];
  const tripIds = [...new Set(bill.lines.map((l) => l.tripId).filter(Boolean).map(String))];
  for (const orderId of orderIds) await syncOrder(orderId, { ...sync, session, user });
  for (const tripId of tripIds) await syncTrip(tripId, { ...sync, session, user });
}

// Checks the bill as typed; nothing is saved here
async function validateBillInput(input, session, { readOnly = false } = {}) {
  const vendor = await Vendor.findById(input.vendorId).session(session);
  if (!vendor) throw fail('اختر المورد');
  if (!vendor.isActive) throw fail('المورد مؤرشف');
  if (!isDay(input.day)) throw fail('تاريخ الفاتورة غير صالح');
  if (!input.currency) throw fail('عملة الفاتورة مطلوبة');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw fail('الفاتورة تحتاج سطراً واحداً على الأقل');

  for (const [index, line] of input.lines.entries()) {
    const where = `السطر ${index + 1}`;
    if (!String(line.description || '').trim()) throw fail(`${where}: الوصف مطلوب`);
    if (!(Number(line.amount) > 0)) throw fail(`${where}: المبلغ يجب أن يكون أكبر من صفر`);
    if (!TARGETS.includes(line.target)) throw fail(`${where}: اختر نوع السطر`);
    if (line.target === 'order') {
      const order = line.orderId && mongoose.isValidObjectId(line.orderId) && await Order.findById(line.orderId).select('placedAt purchaseItems').session(session);
      if (!order) throw fail(`${where}: الطلب غير موجود`);
      const available = readOnly ? { modifiedCount: 1 } : await Order.updateOne({ _id: order._id, isDeleted: { $ne: true } }, { $inc: { accountingMutationVersion: 1 } }, { session });
      if (available.modifiedCount !== 1) throw fail('Order was deleted');
      if (line.purchaseItemId && !input.isCreditNote) {
        const item = order.purchaseItems.find(i => String(i._id) === String(line.purchaseItemId));
        if (!item || (item.currency || 'USD') !== input.currency || Math.abs(Number(item.unitPrice) - Number(line.amount)) > 0.0005) throw fail('بند مشتريات الطلبية لا يطابق مبلغ وعملة الفاتورة');
        if (await SupplierBill.exists({ status: { $ne: 'canceled' }, ...(input._id && { _id: { $ne: input._id } }),
          $or: [{ idempotencyKey: `MIG:PURCH:${item._id}` }, { 'lines.purchaseItemId': item._id }] }).session(session)) throw fail('بند المشتريات له فاتورة مسجلة؛ اربط الفاتورة الأصلية ولا تنشئ تكلفة ثانية');
      }
    }
    if (line.target === 'customs') {
      const order = line.orderId && mongoose.isValidObjectId(line.orderId) && await Order.findById(line.orderId).select('paymentList._id').session(session);
      if (!order) throw fail(`${where}: الطلب غير موجود`);
      const available = readOnly ? { modifiedCount: 1 } : await Order.updateOne({ _id: order._id, isDeleted: { $ne: true } }, { $inc: { accountingMutationVersion: 1 } }, { session });
      if (available.modifiedCount !== 1) throw fail('Order was deleted');
      if (!line.packageId || !order.paymentList.id(line.packageId)) throw fail(`${where}: اختر الطرد الذي خُلِّص`);
    }
    if (line.target === 'trip') {
      const trip = line.tripId && mongoose.isValidObjectId(line.tripId) && await Inventory.findById(line.tripId).select('inventoryType').session(session);
      if (!trip) throw fail(`${where}: الرحلة غير موجودة`);
      const available = readOnly ? { modifiedCount: 1 } : await Inventory.updateOne({ _id: trip._id }, { $inc: { accountingMutationVersion: 1 } }, { session });
      if (available.modifiedCount !== 1) throw fail('Trip was deleted');
      // Warehouses only track packages; they never carry costs (spec 4.3)
      if (trip.inventoryType !== 'inventoryGoods') throw fail(`${where}: هذا مخزن وليس رحلة؛ لا تُحمَّل عليه تكاليف`);
    }
    if (line.target === 'expense') {
      const account = await getAccount(line.accountId, `${where}: حساب المصروف`);
      if (account.type !== 'expense') throw fail(`${where}: اختر حساب مصروف`);
      if (!(await officeExists(line.office))) throw fail(`${where}: المكتب مطلوب`);
      // Typed as a plain expense such a cost is counted beside the order's own and shows as a loss
      // with no revenue (a yuan transfer entered once on the order and again as "حوالة للعميل" on
      // 510700, 2026-10-03)
      if (!input.isHistorical && await isOrderOnlyCost(account)) {
        throw fail(`${where}: «${account.name}» تكلفة مبيعات تُسجَّل على الطلب نفسه (إرسال حوالة Alipay من صفحة الطلب، أو سطر «تخليص جمركي لطرد»)، لا كمصروف عام`);
      }
    }
    if (line.target === 'asset') {
      const account = await getAccount(line.accountId, `${where}: حساب الأصل`);
      if (account.type !== 'asset' || account.isCash) throw fail(`${where}: اختر حساب أصل ثابت`);
      if (!line.asset?.name || !(Number(line.asset?.usefulLifeMonths) > 0)) throw fail(`${where}: اسم الأصل وعمره بالأشهر مطلوبان`);
      if (!(await officeExists(line.office))) throw fail(`${where}: المكتب مطلوب`);
    }
    if (line.target === 'prepaid') {
      const account = await getAccount(line.prepaid?.expenseAccountId, `${where}: حساب المصروف`);
      if (account.type !== 'expense') throw fail(`${where}: اختر حساب المصروف الذي يُوزَّع عليه`);
      if (!(Number(line.prepaid?.months) > 0)) throw fail(`${where}: عدد الأشهر مطلوب`);
      if (line.prepaid.startMonth && !MONTH.test(line.prepaid.startMonth)) throw fail(`${where}: شهر البداية غير صالح`);
      if (!(await officeExists(line.office))) throw fail(`${where}: المكتب مطلوب`);
    }
  }

  if (input.paidBeforeCount) {
    const { settings, count } = await require('../config').getConfig();
    if (!settings?.cutoffAt) throw fail('«دُفع قبل يوم الجرد» بعد اعتماد الترحيل التاريخي فقط؛ قبله أدخل المصروف عادياً ويدخل في التشغيل التجريبي');
    const countDay = count?.day || require('../dates').toDay(settings.cutoffAt);
    if (input.day > countDay) throw fail(`«دُفع قبل يوم الجرد» لمصروف بتاريخ ${countDay} أو قبله`);
    if (input.paidImmediatelyFrom || input.isCreditNote) throw fail('المصروف المدفوع قبل يوم الجرد لا يُدفع من خزينة ولا يكون إشعاراً دائناً');
  }

  if (input.isCreditNote) {
    const original = await SupplierBill.findById(input.originalBillId).session(session);
    if (!original || original.status !== 'posted' || original.isCreditNote) throw fail('اختر الفاتورة الأصلية المُرحَّلة');
    if (String(original.vendorId) !== String(vendor._id)) throw fail('الفاتورة الأصلية لمورد آخر');
    if (input.paidImmediatelyFrom) throw fail('الإشعار الدائن لا يُدفع فوراً');
  }
  return vendor;
}

// Debit side of each bill line; creates the fixed asset / prepaid schedule it stands for
async function costLine(bill, line, usd, session, user) {
  const base = { debit: usd, label: line.description };
  if (line.target === 'order') {
    const order = await Order.findById(line.orderId).select('placedAt').session(session);
    // Always "in progress" first; if the sale is already recognised the order sync right after
    // the bill moves it to cost of sales
    const account = await resolveAccount('purchase_cost_wip');
    return { ...base, accountId: account._id, orderId: toId(line.orderId), office: order.placedAt };
  }
  if (line.target === 'customs') {
    // The clearance of one package, waiting until the clearance sold with it is recognised
    const order = await Order.findById(line.orderId).select('placedAt').session(session);
    const account = await resolveAccount('customs_cost_wip');
    return { ...base, accountId: account._id, orderId: toId(line.orderId), packageId: toId(line.packageId), office: order.placedAt };
  }
  if (line.target === 'trip') {
    const trip = await Inventory.findById(line.tripId).select('inventoryPlace shippingType').session(session);
    // Every trip's cost waits in work in progress and is shared over its packages by chargeable
    // weight: an air or sea trip over what it carried, a domestic trip over the packages it took
    // on to another office (owner's decision in v8, replacing decision 62)
    const account = await resolveAccount('trip_cost_wip');
    return { ...base, accountId: account._id, tripId: toId(line.tripId), office: trip.inventoryPlace };
  }
  if (line.target === 'expense') {
    return { ...base, accountId: toId(line.accountId), office: line.office };
  }
  if (line.target === 'asset') {
    if (!line.assetId) {
      const salvage = line.asset.salvageValue ? await toCurrencyMinor(line.asset.salvageValue, 'USD') : 0;
      const [asset] = await FixedAsset.create([{
        name: line.asset.name, accountId: line.accountId, office: line.office, purchaseDay: bill.day,
        cost: usd, salvageValue: salvage, usefulLifeMonths: Number(line.asset.usefulLifeMonths),
        sourceBillId: bill._id, createdBy: user?._id, number: await nextDocNumber('FA', bill.day, session),
      }], { session });
      line.assetId = asset._id;
    }
    return { ...base, accountId: toId(line.accountId), assetId: line.assetId, office: line.office };
  }
  // prepaid
  if (!line.prepaidId) {
    const [prepaid] = await PrepaidExpense.create([{
      description: line.description, expenseAccountId: line.prepaid.expenseAccountId, office: line.office, total: usd,
      months: Number(line.prepaid.months), startMonth: line.prepaid.startMonth || monthOf(bill.day),
      sourceBillId: bill._id, createdBy: user?._id, number: await nextDocNumber('PPD', bill.day, session),
    }], { session });
    line.prepaidId = prepaid._id;
  }
  const account = await resolveAccount('prepaid_expenses');
  return { ...base, accountId: account._id, prepaidId: line.prepaidId, office: line.office };
}

// { shares: USD cents per line } when the bill is valued at the paying account's average rate:
// yuan sent from Alipay only (the transfer's cost is the yuan at what they cost, spec 19.5). Any
// other bill or expense is valued at the rate of its own date, or the rate typed on it (owner's
// decision 2026-10-03); the box still gives its money at its average rate, the difference being
// an exchange gain or loss
// An expense paid from a staff member's custody is valued the same way, at what that custody cost
// when it was given, so spending it leaves no exchange difference (owner's request 2026-10-04).
async function carriedValue(bill, session) {
  if (!bill.paidImmediatelyFrom || bill.isHistorical || bill.isCreditNote) return null;
  if (!bill.employeeId && (Number(bill.rate) > 0 || bill.currency !== 'CNY')) return null;
  const from = await getAccount(bill.paidImmediatelyFrom, 'حساب الدفع');
  const custody = !!bill.employeeId && (await require('../custody').staffAccountKind(from._id))?.kind === 'custody';
  if (!custody && (!from.isCash || bill.currency !== 'CNY' || Number(bill.rate) > 0)) return null;
  if (currencyOf(from) !== bill.currency || !isForeign(from)) return null;
  const minors = [];
  for (const line of bill.lines) minors.push(await toCurrencyMinor(line.amount, bill.currency));
  const total = minors.reduce((sum, value) => sum + value, 0);
  const usd = valueOutflow(await getBalance(from._id, { session, ...(custody && { employeeId: bill.employeeId }) }), total);
  if (usd === null || usd <= 0) return null;
  const { allocate } = require('../claims/sync');
  // The rate shown on the bill and its payment: units of the currency for one dollar
  bill.rate = Math.round(((total / 10 ** (await decimalsOf(bill.currency))) / (usd / 100)) * 1e6) / 1e6;
  return { shares: allocate(usd, minors), total: usd };
}

async function postBill(bill, { session, user, sync }) {
  const vendor = await Vendor.findById(bill.vendorId).session(session);
  const rates = new RateBook(session);
  const lines = [];
  let totalUsd = 0;

  // Paid on the spot from a foreign-currency account (Alipay in yuan, a lira bank) with no rate
  // typed: the cost is what the money is worth in that account, its average carrying rate (spec
  // 2.4). The bill and its payment then carry the same dollars and no exchange difference appears.
  const carried = await carriedValue(bill, session);

  for (const [index, line] of bill.lines.entries()) {
    const minor = await toCurrencyMinor(line.amount, bill.currency);
    const usd = carried ? carried.shares[index] : await rates.toUsd(minor, bill.currency, bill.day, bill.rate);
    if (usd <= 0) throw fail(`السطر "${line.description}": القيمة بالدولار صفر`);
    line.usd = usd;
    totalUsd += usd;
    lines.push(await costLine(bill, line, usd, session, user));
  }

  const payable = bill.isCreditNote
    ? await getAccount((await SupplierBill.findById(bill.originalBillId).session(session)).payableAccountId)
    : await payableAccountFor(vendor);
  const apKey = billKey(bill.isCreditNote ? bill.originalBillId : bill._id);

  if (bill.isCreditNote) {
    // A return: less owed to the vendor, less cost on the same targets
    lines.forEach((line) => { line.credit = line.debit; line.debit = 0; });
    const original = await SupplierBill.findById(bill.originalBillId).session(session);
    // Concurrent credit notes must serialize on their original bill, just like concurrent
    // payment allocations. Otherwise two transactions can both observe the same remaining cap.
    await lockBillAllocation(original, session);
    const originalOpen = await apBalance(apKey, session);
    const alreadyCredited = (await SupplierBill.find({ originalBillId: original._id, status: 'posted', _id: { $ne: bill._id } }).session(session))
      .reduce((sum, note) => sum + (note.totalUsd || 0), 0);
    if (totalUsd > original.totalUsd - alreadyCredited) throw fail('مبلغ الإشعار الدائن أكبر من المتبقي من الفاتورة الأصلية');
    lines.push({ accountId: payable._id, debit: totalUsd, vendorId: vendor._id, apKey, label: `إشعار دائن على ${original.number}${originalOpen < totalUsd ? ' (مستحق لنا من المورد)' : ''}` });
  } else if (bill.paidBeforeCount) {
    // Paid before the count day: the counted boxes already lack this money, so it comes out of the
    // opening balance instead of a box (spec v8)
    lines.push({ accountId: (await resolveAccount('opening_balance'))._id, credit: totalUsd, label: `دُفع قبل يوم الجرد - ${vendor.name}` });
  } else {
    lines.push({ accountId: payable._id, credit: totalUsd, vendorId: vendor._id, apKey, label: `فاتورة ${vendor.name}${bill.vendorRef ? ` رقم ${bill.vendorRef}` : ''}` });
  }

  bill.number = bill.number || await nextDocNumber(bill.isCreditNote ? 'CN' : 'BILL', bill.day, session);
  const entry = await postEntry({
    eventType: 'BILL',
    eventKey: `BILL:${bill._id}`,
    date: bill.day,
    description: `${bill.isCreditNote ? 'إشعار دائن' : 'فاتورة مورد'} ${bill.number} - ${vendor.name}`,
    source: { model: 'AccountingSupplierBill', id: bill._id },
    isHistorical: bill.isHistorical,
    migrationRunId: bill.migrationRunId,
    fallbacks: rates.fallbacks,
    lines,
  }, { session, user });
  await rates.lock();

  bill.total = bill.lines.reduce((sum, line) => sum + Number(line.amount), 0);
  bill.totalUsd = totalUsd;
  bill.payableAccountId = payable._id;
  bill.entryId = entry._id;
  bill.status = 'posted';
  bill.markModified('lines');
  await bill.save({ session });
  await syncBillTargets(bill, { session, user, sync });

  if (bill.paidImmediatelyFrom && !bill.isCreditNote) {
    // A historical cost was paid from a cash box nobody recorded: it is paid from the suspense
    // account in USD (or from the mapped cash box when it is in the bill's currency)
    const from = await getAccount(bill.paidImmediatelyFrom, 'حساب الدفع');
    const inUsd = bill.isHistorical && (!from.isCash || currencyOf(from) !== bill.currency);
    const payment = await createPayment({
      vendorId: bill.vendorId,
      day: bill.day,
      fromAccountId: bill.paidImmediatelyFrom,
      employeeId: bill.employeeId,
      amount: inUsd ? totalUsd / 100 : bill.total,
      rate: inUsd ? undefined : bill.rate,
      allocations: [{ billId: bill._id, amountUsd: totalUsd }],
      autoFromBillId: bill._id,
      note: `دفع فوري للفاتورة ${bill.number}`,
      isHistorical: bill.isHistorical,
      migrationRunId: bill.migrationRunId,
    }, { session, user, requireCurrency: inUsd ? undefined : bill.currency });
    bill.paymentId = payment._id;
    await bill.save({ session });
  }
  return bill;
}

const BILL_FIELDS = ['duplicateDecision', 'duplicateReason', 'duplicateFingerprint', 'vendorRefKind', 'vendorId', 'vendorRef', 'day', 'currency', 'rate', 'lines', 'isCreditNote', 'originalBillId', 'paidImmediatelyFrom', 'employeeId', 'note', 'attachments', 'isQuickExpense', 'isHistorical', 'migrationRunId', 'officeExpense', 'office', 'expenseTypeId', 'enteredFrom', 'replaces', 'paidBeforeCount'];

// `sync` carries the historical replay's context (as-of view of orders) to the order/trip sync
async function createBill(input, { session, req, asDraft = false, sync }) {
  const existing = await findExisting(SupplierBill, input.idempotencyKey, session);
  if (existing) return existing;
  await validateBillInput(input, session);
  if (!asDraft) await require('../costDuplicates').assertNoDuplicate(input, { session });
  const data = {};
  BILL_FIELDS.forEach((field) => { if (input[field] !== undefined && input[field] !== '') data[field] = input[field]; });
  const [bill] = await SupplierBill.create([{
    ...data, status: 'draft', idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id,
  }], { session });
  if (!asDraft) await postBill(bill, { session, user: req?.user, sync });
  await logAudit({ req, action: asDraft ? 'bill.draft' : 'bill.post', model: 'AccountingSupplierBill', docId: bill._id, after: bill }, session);
  return bill;
}

async function updateDraftBill(id, input, { session, req }) {
  const bill = await SupplierBill.findById(id).session(session);
  if (!bill) throw fail('الفاتورة غير موجودة');
  if (bill.status !== 'draft') throw fail('الفاتورة المُرحَّلة لا تُعدَّل؛ ألغِها وأنشئ فاتورة جديدة');
  const merged = { ...bill.toObject(), ...input };
  await validateBillInput(merged, session);
  await require('../costDuplicates').assertNoDuplicate(merged, { session, excludeId: bill._id });
  const before = bill.toObject();
  BILL_FIELDS.forEach((field) => { if (input[field] !== undefined) bill[field] = input[field]; });
  await bill.save({ session });
  await logAudit({ req, action: 'bill.updateDraft', model: 'AccountingSupplierBill', docId: bill._id, before, after: bill }, session);
  return bill;
}

async function postDraftBill(id, { session, req }) {
  const bill = await SupplierBill.findById(id).session(session);
  if (!bill) throw fail('الفاتورة غير موجودة');
  if (bill.status !== 'draft') throw fail('الفاتورة ليست مسودة');
  await validateBillInput(bill.toObject(), session);
  await require('../costDuplicates').assertNoDuplicate(bill.toObject(), { session, excludeId: bill._id });
  await postBill(bill, { session, user: req?.user });
  await logAudit({ req, action: 'bill.post', model: 'AccountingSupplierBill', docId: bill._id, after: bill }, session);
  return bill;
}

async function deleteDraftBill(id, { session, req }) {
  const bill = await SupplierBill.findById(id).session(session);
  if (!bill) throw fail('الفاتورة غير موجودة');
  if (bill.status !== 'draft') throw fail('فقط المسودات تُحذف؛ الفاتورة المُرحَّلة تُلغى');
  await SupplierBill.deleteOne({ _id: bill._id }, { session });
  await logAudit({ req, action: 'bill.deleteDraft', model: 'AccountingSupplierBill', docId: bill._id, before: bill }, session);
}

// E15: pays bills (allocations in USD) and/or leaves an advance with the vendor.
// Money leaving a foreign-currency account is valued at its average rate; bills are closed at
// their own USD value; the difference is an exchange gain/loss.
async function createPayment(input, { session, req, user, requireCurrency }) {
  const existing = await findExisting(SupplierPayment, input.idempotencyKey, session);
  if (existing) return existing;
  const actor = user || req?.user;

  const vendor = await Vendor.findById(input.vendorId).session(session);
  if (!vendor) throw fail('اختر المورد');
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');

  const allocations = normalizeAllocations(input.allocations);
  const lines = [];
  const bills = [];
  let allocated = 0;
  for (const allocation of allocations) {
    const bill = await SupplierBill.findById(allocation.billId).session(session);
    bills.push(bill);
    if (!bill || bill.status !== 'posted' || bill.isCreditNote) throw fail('فاتورة غير صالحة في التخصيص');
    if (String(bill.vendorId) !== String(vendor._id)) throw fail(`الفاتورة ${bill.number} لمورد آخر`);
    await lockBillAllocation(bill, session);
    const open = await apBalance(billKey(bill._id), session);
    if (allocation.amountUsd > open) throw fail(`المبلغ المخصص للفاتورة ${bill.number} أكبر من المتبقي عليها (${open / 100}$)`);
    allocated += allocation.amountUsd;
    lines.push({ accountId: bill.payableAccountId, debit: allocation.amountUsd, vendorId: vendor._id, apKey: billKey(bill._id), label: `سداد ${bill.number}` });
  }

  const payable = await payableAccountFor(vendor);
  const [doc] = await SupplierPayment.create([{
    vendorId: vendor._id, day: input.day, fromAdvance: !!input.fromAdvance, allocations,
    note: input.note, attachments: input.attachments, idempotencyKey: input.idempotencyKey,
    autoFromBillId: input.autoFromBillId, createdBy: actor?._id, status: 'posted',
    isHistorical: !!input.isHistorical, migrationRunId: input.migrationRunId,
    number: await nextDocNumber('PAY', input.day, session),
  }], { session });

  const rates = new RateBook(session);
  let office;
  if (input.fromAdvance) {
    // Applying money already paid to the vendor in advance
    if (!allocated) throw fail('خصص المبلغ على فاتورة واحدة على الأقل');
    const available = -(await apBalance(advanceKey(vendor._id), session));
    if (allocated > available) throw fail(`الدفعة المقدمة المتاحة ${available / 100}$ فقط`);
    lines.push({ accountId: payable._id, credit: allocated, vendorId: vendor._id, apKey: advanceKey(vendor._id), label: 'تسوية من الدفعة المقدمة' });
  } else {
    const from = await getAccount(input.fromAccountId, 'حساب الدفع');
    const custody = require('../custody');
    const staff = await custody.staffAccountKind(from._id);
    if (staff?.kind === 'loan') throw fail('السلفة لا يُدفع منها: ادفع من خزينة أو بنك أو عهدة موظف');
    const isEmployeeAdvance = !!staff;
    if (!from.isCash && !isEmployeeAdvance && !input.isHistorical) throw fail('ادفع من خزينة أو بنك أو عهدة موظف');
    if (isEmployeeAdvance && !input.employeeId) throw fail('اختر الموظف صاحب العهدة');
    const currency = currencyOf(from);
    const { count } = await require('../config').getConfig();
    const beforeCount = !!count && (input.day < count.day || (input.day === count.day && count.endOfDay));
    if (!input.isHistorical && !beforeCount) await lockPostingAccounts([from], session);
    if (requireCurrency && requireCurrency !== currency) throw fail(`حساب الدفع بعملة ${currency} والفاتورة بعملة ${requireCurrency}`);
    const minor = await toCurrencyMinor(input.amount, currency);
    if (!minor) throw fail('مبلغ الدفعة مطلوب');
    if (isEmployeeAdvance && !input.isHistorical) {
      const held = await custody.heldMinor(from, input.employeeId, session);
      if (minor > held) throw fail(`عهدة الموظف في ${from.name} (${held / 10 ** await decimalsOf(currency)} ${currency}) لا تكفي`);
    }
    const atRate = await rates.toUsd(minor, currency, input.day, input.rate);
    const outUsd = await valueOut(from, minor, { day: input.day, docRate: input.rate, rates, ...(isEmployeeAdvance && { employeeId: input.employeeId }) });
    // Allowing a little over the day's value: a bill paid in its own currency closes in full
    // even when the rate moved since the bill
    if (allocated > Math.round(atRate * 1.1) + 100) throw fail('المبالغ المخصصة أكبر من قيمة الدفعة');
    // Paid in another currency than the bills (a Kuwaiti site paid from the lira bank): the bills'
    // cost becomes what was really paid, the difference going on their own targets (owner's request
    // 2026-10-04). The box's average rate against the paid rate stays an exchange difference.
    const difference = input.differenceTo === 'cost' && allocated && !input.autoFromBillId ? atRate - allocated : 0;
    if (difference) {
      if (Math.abs(difference) > Math.round(allocated * 0.1) + 100) throw fail('الفرق بين المدفوع والموزَّع أكبر من 10%: راجع المبلغ أو السعر');
      lines.push(...await costDifferenceLines(bills, allocations, difference, session, actor));
      doc.costDifferenceUsd = difference;
    }
    // The payment made with its bill pays exactly that bill: a cent of rounding is not an advance
    const advance = input.autoFromBillId || difference ? 0 : Math.max(atRate - allocated, 0);
    if (advance > 0) lines.push({ accountId: payable._id, debit: advance, vendorId: vendor._id, apKey: advanceKey(vendor._id), label: 'دفعة مقدمة للمورد' });
    lines.push(moneyLine(from, 'credit', minor, outUsd, { label: `دفعة للمورد ${vendor.name}`, ...(isEmployeeAdvance && { employeeId: toId(input.employeeId) }) }));
    office = from.office || undefined;
    await addFxLine(lines, office);
    Object.assign(doc, { fromAccountId: from._id, employeeId: input.employeeId || undefined, currency, amount: Number(input.amount), rate: input.rate, advanceUsd: advance });
  }

  const entry = await postEntry({
    eventType: 'VENDOR_PAYMENT',
    eventKey: `VENDOR_PAYMENT:${doc._id}`,
    date: input.day,
    description: `دفعة ${doc.number} - ${vendor.name}`,
    source: { model: 'AccountingSupplierPayment', id: doc._id },
    isHistorical: !!input.isHistorical,
    migrationRunId: input.migrationRunId,
    fallbacks: rates.fallbacks,
    lines,
  }, { session, user: actor });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  // The orders and trips whose cost changed take it into their recognised cost
  if (doc.costDifferenceUsd) for (const bill of bills) await syncBillTargets(bill, { session, user: actor });
  await logAudit({ req, user: actor, action: 'payment.post', model: 'AccountingSupplierPayment', docId: doc._id, after: doc }, session);
  return doc;
}

// Lines putting `difference` (USD cents, + or -) on the cost of the paid bills, shared by what was
// paid on each bill and, inside a bill, by the dollar value of its lines
const DIFFERENCE_TARGETS = ['order', 'customs', 'trip', 'expense'];
async function costDifferenceLines(bills, allocations, difference, session, user) {
  const { allocate } = require('../claims/sync');
  const lines = [];
  const perBill = allocate(difference, allocations.map((a) => a.amountUsd));
  for (const [index, bill] of bills.entries()) {
    if (!perBill[index]) continue;
    if (bill.lines.some((line) => !DIFFERENCE_TARGETS.includes(line.target))) {
      throw fail(`الفاتورة ${bill.number} فيها أصل أو مصروف مقدم: سجّل الفرق دفعة مقدمة`);
    }
    const shares = allocate(perBill[index], bill.lines.map((line) => line.usd || 1));
    for (const [i, line] of bill.lines.entries()) {
      if (!shares[i]) continue;
      const cost = await costLine(bill, line, Math.abs(shares[i]), session, user);
      const label = `فرق المدفوع عن الفاتورة ${bill.number}`;
      lines.push(shares[i] > 0 ? { ...cost, label } : { ...cost, debit: 0, credit: -shares[i], label });
    }
  }
  return lines;
}

// Money received from a vendor into a cash box, bank or Alipay (spec 19.13): it settles the credit
// notes it is allocated to; the rest comes off the advance we paid them (or, with no advance, is
// money we now hold for them)
async function createReceipt(input, { session, req, user }) {
  const existing = await findExisting(SupplierReceipt, input.idempotencyKey, session);
  if (existing) return existing;
  const actor = user || req?.user;
  const vendor = await Vendor.findById(input.vendorId).session(session);
  if (!vendor) throw fail('اختر المورد');
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const to = await getAccount(input.toAccountId, 'الحساب المستلم');
  if (!to.isCash) throw fail('استلم في خزينة أو بنك أو محفظة إلكترونية');
  const currency = currencyOf(to);
  const minor = await toCurrencyMinor(input.amount, currency);
  if (!minor) throw fail('المبلغ المستلم مطلوب');
  const rates = new RateBook(session);
  const usd = await rates.toUsd(minor, currency, input.day, input.rate);

  const allocations = normalizeAllocations(input.allocations);
  const lines = [moneyLine(to, 'debit', minor, usd, { label: `استلام من المورد ${vendor.name}` })];
  let allocated = 0;
  const allocatedBillIds = new Set();
  for (const allocation of allocations) {
    // A credit note is posted on its original bill: a bill paid and then credited leaves the
    // vendor owing us on that bill (a debit balance on its key)
    const picked = await SupplierBill.findById(allocation.billId).session(session);
    const bill = picked?.isCreditNote ? await SupplierBill.findById(picked.originalBillId).session(session) : picked;
    if (!bill || bill.status !== 'posted') throw fail('اختر فاتورة أو إشعاراً دائناً مُرحَّلاً');
    if (String(bill.vendorId) !== String(vendor._id)) throw fail(`الفاتورة ${bill.number} لمورد آخر`);
    if (allocatedBillIds.has(String(bill._id))) throw fail('لا تخصص الاسترداد مرتين على الفاتورة الأصلية');
    allocatedBillIds.add(String(bill._id));
    await lockBillAllocation(bill, session);
    const owed = -(await apBalance(billKey(bill._id), session));
    if (allocation.amountUsd > owed) throw fail(`المورد مدين لنا على ${bill.number} بـ${Math.max(owed, 0) / 100}$ فقط`);
    allocated += allocation.amountUsd;
    allocation.billId = bill._id;
    lines.push({ accountId: bill.payableAccountId, credit: allocation.amountUsd, vendorId: vendor._id, apKey: billKey(bill._id), label: `استرداد على ${bill.number}` });
  }
  const exchangeDifference = input.differenceTo === 'exchange' && allocated > 0;
  if (allocated > usd && !exchangeDifference) throw fail('المبالغ المخصصة أكبر من المبلغ المستلم');
  const payable = await payableAccountFor(vendor);
  const advance = exchangeDifference ? 0 : usd - allocated;
  if (advance > 0) lines.push({ accountId: payable._id, credit: advance, vendorId: vendor._id, apKey: advanceKey(vendor._id), label: 'من رصيد المورد' });
  if (exchangeDifference) await addFxLine(lines, to.office, 'فرق صرف استرداد المورد');

  const [doc] = await SupplierReceipt.create([{
    vendorId: vendor._id, day: input.day, toAccountId: to._id, currency, amount: Number(input.amount), rate: input.rate,
    allocations, advanceUsd: advance, note: input.note, attachments: input.attachments, idempotencyKey: input.idempotencyKey,
    createdBy: actor?._id, status: 'posted', number: await nextDocNumber('RCV', input.day, session),
  }], { session });
  const entry = await postEntry({
    eventType: 'VENDOR_RECEIPT', eventKey: `VENDOR_RECEIPT:${doc._id}`, date: input.day,
    description: `استلام ${doc.number} من ${vendor.name}`, source: { model: 'AccountingSupplierReceipt', id: doc._id },
    fallbacks: rates.fallbacks, lines,
  }, { session, user: actor });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  await logAudit({ req, user: actor, action: 'receipt.post', model: 'AccountingSupplierReceipt', docId: doc._id, after: doc }, session);
  return doc;
}

module.exports = {
  createReceipt, carriedValue,
  syncBillTargets, apBalance, billKey, advanceKey, lockBillAllocation, createBill, updateDraftBill, postDraftBill, deleteDraftBill, createPayment, validateBillInput,
};
