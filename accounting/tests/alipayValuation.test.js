const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction: tx } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { CurrencyRate, JournalEntry, AccountingSettings } = require('../models');
const { Vendor, SupplierBill } = require('../models/documents');
const alipay = require('../services/posting/alipay');
const { revalue, EVENT } = require('../services/posting/alipayValuation');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let wallet, cash, vendor, orderId;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await CurrencyRate.create({ currency: 'CNY', day: '2026-01-01', rate: 1000 / 140 });
  wallet = await account('110301'); cash = await account('110101');
  vendor = await Vendor.create({ name: 'Valuation broker', type: 'service' });
  const customer = (await mongoose.connection.collection('users').insertOne({ customerId: 'VAL-TEST', firstName: 'Valuation' })).insertedId;
  orderId = (await require('../../models/order').collection.insertOne({ orderId: 'VAL-ORDER', user: customer, placedAt: 'tripoli', isRemittance: true,
    isPayment: true, totalInvoice: 400, purchaseItems: [], paymentList: [], createdAt: new Date('2026-09-01') })).insertedId;
});
const buy = (cny, usd, day = '2026-09-01') => tx(session => alipay.createYuanPurchase({ vendorId: vendor._id, fromAccountId: cash._id, toAccountId: wallet._id,
  day, amount: usd, cnyReceived: cny }, { session, req }));
const send = (cny = 1500, extra = {}) => tx(session => alipay.sendRemittance(orderId, { accountId: wallet._id, cny, day: '2026-09-03', ...extra }, { session, req }));

test('late earlier receipt corrects overspend cost and wallet USD without changing yuan or original bill', async () => {
  await buy(1000, 140);
  const bill = await send();
  expect(await getBalance(wallet._id)).toEqual({ foreign: -50000, usd: -7000 });
  await buy(2000, 300, '2026-09-02');
  expect(await getBalance(wallet._id)).toEqual({ foreign: 150000, usd: 22000 });
  const updated = await SupplierBill.findById(bill._id);
  expect(updated.totalUsd).toBe(21000);
  expect(updated.alipayValuationUsd).toBe(22000);
  expect(updated.alipayValuationAdjustmentUsd).toBe(1000);
  expect(updated.alipayValuationProvisional).toBe(false);
  const entry = await JournalEntry.findOne({ eventType: EVENT });
  expect(entry.totalDebit).toBe(entry.lines.reduce((s,l)=>s+l.credit,0));
  expect(entry.lines.find(l=>String(l.accountId)===String(wallet._id)).amountCurrency).toBe(0);
  expect(entry.lines.some(l=>String(l.orderId)===String(orderId))).toBe(true);
  const summary = await require('../services/reports/summaries').orderSummary(orderId);
  expect(summary.costExplanation.total).toBe(22000);
  expect(summary.bills[0].cost).toBe(22000);
  expect(summary.costExplanation.rows.some(r=>r.kind==='alipay_valuation')).toBe(true);
  expect(summary.totals.cost + summary.totals.costInProgress).toBe(22000);
  const count=await JournalEntry.countDocuments();
  await tx(session => revalue(wallet._id,{session,user:req.user}));
  expect(await JournalEntry.countDocuments()).toBe(count);
});

test('zero balance uses the valid daily rate, then revalues when earlier receipt is entered', async () => {
  const bill = await send();
  expect(await getBalance(wallet._id)).toEqual({ foreign: -150000, usd: -21000 });
  await buy(3000, 450, '2026-09-02');
  expect(await getBalance(wallet._id)).toEqual({ foreign: 150000, usd: 22500 });
  expect((await SupplierBill.findById(bill._id)).alipayValuationUsd).toBe(22500);
});

test('a genuinely later receipt never changes the earlier transfer price', async () => {
  await buy(1000,140); const bill=await send();
  await buy(2000,300,'2026-09-04');
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(0);
  expect(await JournalEntry.countDocuments({eventType:EVENT})).toBe(0);
});

test('a forgotten same-day receipt uses daily weighted valuation before outflows', async () => {
  await buy(1000,140); const bill=await send();
  await buy(2000,300,'2026-09-03');
  expect((await SupplierBill.findById(bill._id)).alipayValuationUsd).toBe(22000);
});

test('canceling the late receipt restores the previous cost and does not duplicate yuan', async () => {
  await buy(1000,140); const bill=await send(); const receipt=await buy(2000,300,'2026-09-02');
  await tx(session=>require('../services/cancel').cancelDocument('AccountingYuanPurchase',receipt._id,{session,req,reason:'Correct receipt'}));
  expect(await getBalance(wallet._id)).toEqual({foreign:-50000,usd:-7000});
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(0);
});

test('canceling a corrected remittance reverses its adjustment and returns the exact yuan', async () => {
  await buy(1000,140); const bill=await send(); await buy(2000,300,'2026-09-02');
  await tx(session=>require('../services/cancel').cancelDocument('AccountingSupplierBill',bill._id,{session,req,reason:'Cancel remittance'}));
  expect(await getBalance(wallet._id)).toEqual({foreign:300000,usd:44000});
});

test('valuation corrections shift to first open day and leave closed originals intact', async () => {
  await buy(1000,140); const bill=await send();
  await AccountingSettings.updateOne({key:'main'},{$set:{lockDate:'2026-09-05'}});
  require('../services/config').invalidateConfig();
  // Economic dates drive valuation, while adjustment entries post only into the open period.
  await buy(2000,300,'2026-09-02');
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(1000);
  expect((await JournalEntry.findOne({ eventType: EVENT })).day).toBe('2026-09-06');
  expect((await JournalEntry.findById(bill.entryId)).day).toBe('2026-09-03');
});


test('later remittances are revalued in order with exact cent rounding', async () => {
  await buy(1000,140); const first=await send();
  const second=await send(500,{day:'2026-09-04'});
  await buy(2000,300,'2026-09-02');
  expect((await SupplierBill.findById(first._id)).alipayValuationUsd).toBe(22000);
  expect((await SupplierBill.findById(second._id)).alipayValuationUsd).toBe(7333);
  expect(await getBalance(wallet._id)).toEqual({foreign:100000,usd:14667});
});

test('canceling a same-day receipt removes its valuation influence entirely', async () => {
  await buy(1000,140); const bill=await send(); const receipt=await buy(2000,300,'2026-09-03');
  await tx(session=>require('../services/cancel').cancelDocument('AccountingYuanPurchase',receipt._id,{session,req,reason:'Wrong receipt'}));
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(0);
  expect(await getBalance(wallet._id)).toEqual({foreign:-50000,usd:-7000});
});


test('receipts in another Alipay account never change this remittance valuation', async () => {
  await buy(1000,140); const bill=await send(); const other=await account('110302');
  await tx(session=>alipay.createYuanPurchase({vendorId:vendor._id,fromAccountId:cash._id,toAccountId:other._id,day:'2026-09-02',amount:300,cnyReceived:2000},{session,req}));
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(0);
  expect(await getBalance(wallet._id)).toEqual({foreign:-50000,usd:-7000});
  expect(await getBalance(other._id)).toEqual({foreign:200000,usd:30000});
});


test('a cheaper forgotten receipt credits order cost and increases wallet USD correctly', async () => {
  await buy(1000,140); const bill=await send(); await buy(2000,240,'2026-09-02');
  expect((await SupplierBill.findById(bill._id)).alipayValuationUsd).toBe(19000);
  expect((await SupplierBill.findById(bill._id)).alipayValuationAdjustmentUsd).toBe(-2000);
  expect(await getBalance(wallet._id)).toEqual({foreign:150000,usd:19000});
  expect((await require('../services/reports/summaries').orderSummary(orderId)).costExplanation.total).toBe(19000);
});

test('exactly covered overdraft leaves both CNY and USD at zero', async () => {
  await buy(1000,140); const bill=await send(3000); await buy(2000,300,'2026-09-02');
  expect(await getBalance(wallet._id)).toEqual({foreign:0,usd:0});
  expect((await SupplierBill.findById(bill._id)).alipayValuationUsd).toBe(44000);
  expect((await SupplierBill.findById(bill._id)).alipayValuationProvisional).toBe(false);
});
