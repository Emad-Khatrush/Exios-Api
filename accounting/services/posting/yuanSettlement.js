// Yuan is an asset purchased from a supplier. Cash payments and wallet nettings
// settle its payable independently; none of them is operating revenue or expense.
const mongoose = require('mongoose');
const { YuanPurchase, SupplierBill, Vendor } = require('../../models/documents');
const { Account } = require('../../models');
const { postEntry } = require('../ledger');
const { isDay, today } = require('../dates');
const { logAudit } = require('../audit');
const { fail, getAccount, currencyOf, toCurrencyMinor, moneyLine, resolveAccount, nextDocNumber, findExisting } = require('./common');
const { billKey, apBalance, createPayment, lockBillAllocation } = require('./payables');

async function settle(id, input, { session, req }) {
  const purchase = await YuanPurchase.findById(id).session(session);
  if (!purchase || purchase.status !== 'posted' || !purchase.settlementBillId) throw fail('عملية الشراء لا تدعم هذا السداد');
  if (!isDay(input.day) || input.day > today() || input.day < purchase.day) throw fail('اختر تاريخ سداد صالحًا لا يسبق الشراء');
  const key = String(input.idempotencyKey || '');
  if (!key) throw fail('مفتاح العملية مطلوب');
  const { SupplierPayment, Netting } = require('../../models/documents');
  const paymentKey = `YUAN:PAY:${purchase._id}:${key}`;
  const nettingKey = `YUAN:WALLET:${purchase._id}:${key}`;
  const priorPayment = await findExisting(SupplierPayment, paymentKey, session);
  const priorNetting = await findExisting(Netting, nettingKey, session);
  if (priorPayment || priorNetting) return { payment: priorPayment, netting: priorNetting, openUsd: await apBalance(billKey(purchase.settlementBillId), session) };
  const bill = await SupplierBill.findById(purchase.settlementBillId).session(session);
  if (!bill || bill.status !== 'posted') throw fail('فاتورة الشراء غير متاحة');
  await lockBillAllocation(bill, session);
  const cashUsd = await toCurrencyMinor(input.cashUsd || 0, 'USD');
  const walletUsd = await toCurrencyMinor(input.walletUsd || 0, 'USD');
  if (!cashUsd && !walletUsd) throw fail('أدخل مبلغ الدفع أو الإضافة للمحفظة');
  if (cashUsd + walletUsd > await apBalance(billKey(bill._id), session)) throw fail('السداد والإضافة للمحفظة أكبر من المتبقي');
  let payment, netting;
  if (cashUsd) {
    const account = await getAccount(input.fromAccountId, 'حساب الدفع');
    if (currencyOf(account) !== 'USD') throw fail('اختر حساب دفع بالدولار؛ السداد بعملة أخرى متاح من دفعات الموردين');
    payment = await createPayment({ vendorId: purchase.vendorId, day: input.day,
      fromAccountId: account._id, amount: cashUsd / 100, allocations: [{ billId: bill._id, amountUsd: cashUsd }],
      note: `سداد شراء يوان ${purchase.number}`, idempotencyKey: paymentKey,
      ...(input.initial && { autoFromBillId: bill._id }),
    }, { session, req });
  }
  if (walletUsd) {
    const links = require('../vendorCustomerLink');
    const vendor = await links.lockVendor(purchase.vendorId, session);
    const customer = await links.linkedCustomer(vendor, purchase.customerId || input.customerId, session);
    const customerId = customer._id;
    if (input.customerId && String(input.customerId) !== String(customerId)) throw fail('اختر العميل المرتبط بالمورد');
    netting = await require('./people').createNetting({ vendorId: purchase.vendorId, customerId,
      billId: bill._id, day: input.day, mode: 'payable_to_wallet', walletCurrency: 'USD', amountUsd: walletUsd,
      note: `باقي مستحق شراء يوان ${purchase.number}`, idempotencyKey: nettingKey,
    }, { session, req });
    purchase.customerId = customerId;
  }
  if (input.initial) {
    purchase.initialPaymentId = payment?._id;
    purchase.initialNettingId = netting?._id;
    purchase.fromAccountId = payment?.fromAccountId;
    purchase.amount = cashUsd / 100;
  }
  await purchase.save({ session });
  return { payment, netting, openUsd: await apBalance(billKey(bill._id), session) };
}

async function create(input, { session, req }) {
  if (!input.idempotencyKey) throw fail('مفتاح العملية مطلوب');
  if (!isDay(input.day) || input.day > today()) throw fail('تاريخ الشراء غير صالح');
  const links = require('../vendorCustomerLink');
  const vendor = await links.lockVendor(input.vendorId, session);
  const totalUsd = await toCurrencyMinor(input.totalUsd, 'USD');
  const cash = Number(input.cashUsd || 0), wallet = Number(input.walletUsd || 0);
  if (!(totalUsd > 0) || !Number.isFinite(cash + wallet) || cash < 0 || wallet < 0) throw fail('مبالغ الشراء غير صالحة');
  if (await toCurrencyMinor(cash, 'USD') + await toCurrencyMinor(wallet, 'USD') > totalUsd) throw fail('الدفع والإضافة للمحفظة أكبر من إجمالي الشراء');
  const customer = await links.linkedCustomer(vendor, input.customerId, session, wallet > 0);
  const to = await getAccount(input.toAccountId, 'حساب Alipay');
  if (!to.isCash || currencyOf(to) !== 'CNY') throw fail('اختر حساب Alipay باليوان');
  const cny = Number(input.cnyReceived || input.cnyExpected);
  const cnyMinor = await toCurrencyMinor(cny, 'CNY');
  if (!(cnyMinor > 0)) throw fail('كمية اليوان مطلوبة');
  const arrived = input.arrived !== false;
  const reconciliation = require('./alipayReconciliation');
  await Account.updateOne({ _id: to._id }, { $inc: { postingVersion: 1 } }, { session });
  const reference = arrived ? await reconciliation.beforeRecording(to._id, cnyMinor, input.day, input.transactionReference, session) : '';
  const payable = await resolveAccount(vendor.type === 'carrier' ? 'payable_carriers' : 'payable_suppliers');
  const asset = arrived ? to : await resolveAccount('yuan_in_transit');
  const purchaseId = new mongoose.Types.ObjectId(), billId = new mongoose.Types.ObjectId();
  const [purchase] = await YuanPurchase.create([{ _id: purchaseId, vendorId: vendor._id, customerId: customer?._id,
    settlementBillId: billId, day: input.day, currency: 'USD', amount: 0, usd: totalUsd, toAccountId: to._id,
    cnyExpected: cny, arrived, ...(arrived && { cnyReceived: cny, arrivedDay: input.day }), rate: cny / (totalUsd / 100),
    number: await nextDocNumber('CNY', input.day, session), status: 'posted', idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id,
  }], { session });
  const label = `شراء يوان ${purchase.number} من ${vendor.name}`;
  const [bill] = await SupplierBill.create([{ _id: billId, yuanPurchaseId: purchaseId, vendorId: vendor._id,
    day: input.day, currency: 'USD', total: totalUsd / 100, totalUsd, payableAccountId: payable._id,
    lines: [{ target: 'yuan', description: label, accountId: asset._id, amount: totalUsd / 100, usd: totalUsd }],
    number: await nextDocNumber('BILL', input.day, session), status: 'posted', idempotencyKey: `YUAN:BILL:${purchaseId}`, createdBy: req?.user?._id,
  }], { session });
  const entry = await postEntry({ eventType: 'YUAN_PURCHASE', eventKey: `YUAN_PURCHASE:${purchaseId}`, date: input.day,
    description: label, source: { model: 'AccountingYuanPurchase', id: purchaseId },
    lines: [arrived ? moneyLine(to, 'debit', cnyMinor, totalUsd, { label, rate: purchase.rate }) : { accountId: asset._id, debit: totalUsd, vendorId: vendor._id, label },
      { accountId: payable._id, credit: totalUsd, vendorId: vendor._id, apKey: billKey(billId), label }],
  }, { session, user: req?.user });
  purchase.entryId = entry._id; bill.entryId = entry._id;
  await purchase.save({ session }); await bill.save({ session });
  if (cash || wallet) await settle(purchaseId, { ...input, initial: true }, { session, req });
  if (arrived) await reconciliation.afterRecording(entry._id, to._id, reference, { session, req });
  await logAudit({ req, action: 'alipay.purchase', model: 'AccountingYuanPurchase', docId: purchaseId, after: purchase }, session);
  return YuanPurchase.findById(purchaseId).session(session);
}
module.exports = { create, settle };
