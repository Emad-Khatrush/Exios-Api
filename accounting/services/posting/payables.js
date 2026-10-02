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
  fail, currencyOf, getAccount, toCurrencyMinor, decimalsOf, RateBook, valueOut, moneyLine, addFxLine,
  nextDocNumber, findExisting, officeExists, resolveAccount,
} = require('./common');
const { getBalance, valueOutflow } = require('../carrying');

const TARGETS = ['order', 'trip', 'expense', 'asset', 'prepaid'];
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

async function payableAccountFor(vendor) {
  return resolveAccount(vendor.type === 'carrier' ? 'payable_carriers' : 'payable_suppliers');
}

// Orders and trips a bill charges: their cost shares are re-checked after it posts or is cancelled
async function syncBillTargets(bill, { session, user, sync = {} }) {
  const { syncOrder, syncTrip } = require('../claims/sync');
  const orderIds = [...new Set(bill.lines.map((l) => l.orderId).filter(Boolean).map(String))];
  const tripIds = [...new Set(bill.lines.map((l) => l.tripId).filter(Boolean).map(String))];
  for (const orderId of orderIds) await syncOrder(orderId, { ...sync, session, user });
  for (const tripId of tripIds) await syncTrip(tripId, { ...sync, session, user });
}

// Checks the bill as typed; nothing is saved here
async function validateBillInput(input, session) {
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
      const order = line.orderId && mongoose.isValidObjectId(line.orderId) && await Order.findById(line.orderId).select('placedAt').session(session);
      if (!order) throw fail(`${where}: الطلب غير موجود`);
    }
    if (line.target === 'trip') {
      const trip = line.tripId && mongoose.isValidObjectId(line.tripId) && await Inventory.findById(line.tripId).select('inventoryType').session(session);
      if (!trip) throw fail(`${where}: الرحلة غير موجودة`);
      // Warehouses only track packages; they never carry costs (spec 4.3)
      if (trip.inventoryType !== 'inventoryGoods') throw fail(`${where}: هذا مخزن وليس رحلة؛ لا تُحمَّل عليه تكاليف`);
    }
    if (line.target === 'expense') {
      const account = await getAccount(line.accountId, `${where}: حساب المصروف`);
      if (account.type !== 'expense') throw fail(`${where}: اختر حساب مصروف`);
      if (!(await officeExists(line.office))) throw fail(`${where}: المكتب مطلوب`);
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
    const { settings } = await require('../config').getConfig();
    if (!settings?.cutoffAt) throw fail('«دُفع قبل يوم الجرد» بعد اعتماد الترحيل التاريخي فقط؛ قبله أدخل المصروف عادياً ويدخل في التشغيل التجريبي');
    const countDay = require('../dates').toDay(settings.cutoffAt);
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

// { shares: USD cents per line } when the bill is valued at the paying account's average rate
async function carriedValue(bill, session) {
  if (!bill.paidImmediatelyFrom || bill.isHistorical || bill.isCreditNote || Number(bill.rate) > 0 || bill.currency === 'USD') return null;
  const from = await getAccount(bill.paidImmediatelyFrom, 'حساب الدفع');
  if (!from.isCash || currencyOf(from) !== bill.currency) return null;
  const minors = [];
  for (const line of bill.lines) minors.push(await toCurrencyMinor(line.amount, bill.currency));
  const total = minors.reduce((sum, value) => sum + value, 0);
  const usd = valueOutflow(await getBalance(from._id, { session }), total);
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
    const originalOpen = await apBalance(apKey, session);
    const original = await SupplierBill.findById(bill.originalBillId).session(session);
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

const BILL_FIELDS = ['vendorId', 'vendorRef', 'day', 'currency', 'rate', 'lines', 'isCreditNote', 'originalBillId', 'paidImmediatelyFrom', 'employeeId', 'note', 'attachments', 'isQuickExpense', 'isHistorical', 'migrationRunId', 'officeExpense', 'office', 'expenseTypeId', 'enteredFrom', 'replaces', 'paidBeforeCount'];

// `sync` carries the historical replay's context (as-of view of orders) to the order/trip sync
async function createBill(input, { session, req, asDraft = false, sync }) {
  const existing = await findExisting(SupplierBill, input.idempotencyKey, session);
  if (existing) return existing;
  await validateBillInput(input, session);
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

  const allocations = (input.allocations || []).filter((a) => Number(a.amountUsd) > 0).map((a) => ({ billId: toId(a.billId), amountUsd: Math.round(Number(a.amountUsd)) }));
  const lines = [];
  let allocated = 0;
  for (const allocation of allocations) {
    const bill = await SupplierBill.findById(allocation.billId).session(session);
    if (!bill || bill.status !== 'posted' || bill.isCreditNote) throw fail('فاتورة غير صالحة في التخصيص');
    if (String(bill.vendorId) !== String(vendor._id)) throw fail(`الفاتورة ${bill.number} لمورد آخر`);
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
    const advancesAccount = await resolveAccount('employee_advances');
    const isEmployeeAdvance = String(from._id) === String(advancesAccount._id);
    if (!from.isCash && !isEmployeeAdvance && !input.isHistorical) throw fail('ادفع من خزينة أو بنك أو عهدة موظف');
    if (isEmployeeAdvance && !input.employeeId) throw fail('اختر الموظف صاحب العهدة');
    const currency = currencyOf(from);
    if (requireCurrency && requireCurrency !== currency) throw fail(`حساب الدفع بعملة ${currency} والفاتورة بعملة ${requireCurrency}`);
    const minor = await toCurrencyMinor(input.amount, currency);
    if (!minor) throw fail('مبلغ الدفعة مطلوب');
    const atRate = await rates.toUsd(minor, currency, input.day, input.rate);
    const outUsd = await valueOut(from, minor, { day: input.day, docRate: input.rate, rates });
    // Allowing a little over the day's value: a bill paid in its own currency closes in full
    // even when the rate moved since the bill
    if (allocated > Math.round(atRate * 1.1) + 100) throw fail('المبالغ المخصصة أكبر من قيمة الدفعة');
    // The payment made with its bill pays exactly that bill: a cent of rounding is not an advance
    const advance = input.autoFromBillId ? 0 : Math.max(atRate - allocated, 0);
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
  await logAudit({ req, user: actor, action: 'payment.post', model: 'AccountingSupplierPayment', docId: doc._id, after: doc }, session);
  return doc;
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

  const allocations = (input.allocations || []).filter((a) => Number(a.amountUsd) > 0).map((a) => ({ billId: toId(a.billId), amountUsd: Math.round(Number(a.amountUsd)) }));
  const lines = [moneyLine(to, 'debit', minor, usd, { label: `استلام من المورد ${vendor.name}` })];
  let allocated = 0;
  for (const allocation of allocations) {
    // A credit note is posted on its original bill: a bill paid and then credited leaves the
    // vendor owing us on that bill (a debit balance on its key)
    const picked = await SupplierBill.findById(allocation.billId).session(session);
    const bill = picked?.isCreditNote ? await SupplierBill.findById(picked.originalBillId).session(session) : picked;
    if (!bill || bill.status !== 'posted') throw fail('اختر فاتورة أو إشعاراً دائناً مُرحَّلاً');
    if (String(bill.vendorId) !== String(vendor._id)) throw fail(`الفاتورة ${bill.number} لمورد آخر`);
    const owed = -(await apBalance(billKey(bill._id), session));
    if (allocation.amountUsd > owed) throw fail(`المورد مدين لنا على ${bill.number} بـ${Math.max(owed, 0) / 100}$ فقط`);
    allocated += allocation.amountUsd;
    allocation.billId = bill._id;
    lines.push({ accountId: bill.payableAccountId, credit: allocation.amountUsd, vendorId: vendor._id, apKey: billKey(bill._id), label: `استرداد على ${bill.number}` });
  }
  if (allocated > usd) throw fail('المبالغ المخصصة أكبر من المبلغ المستلم');
  const payable = await payableAccountFor(vendor);
  const advance = usd - allocated;
  if (advance > 0) lines.push({ accountId: payable._id, credit: advance, vendorId: vendor._id, apKey: advanceKey(vendor._id), label: 'من رصيد المورد' });

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
  createReceipt,
  syncBillTargets, apBalance, billKey, advanceKey, createBill, updateDraftBill, postDraftBill, deleteDraftBill, createPayment, validateBillInput,
};
