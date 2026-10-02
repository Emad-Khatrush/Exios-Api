// Phase C of the V6 decisions: the Alipay section, customer refunds from the order page, supplier
// bills in the purchase's own currency, offices and currencies as data.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { runInTransaction } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { invalidateConfig } = require('../services/config');
const { AccountingSettings, CurrencyRate, JournalEntry } = require('../models');
const { Vendor } = require('../models/documents');

beforeAll(startDb);
afterAll(stopDb);

const tx = (fn) => runInTransaction(fn);
const admin = { _id: oid(), roles: { isAdmin: true } };
const req = { user: admin };
const balanceOf = async (code, filter = {}) => (await getBalance((await account(code))._id, filter)).usd;

beforeEach(async () => {
  await resetDb();
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true } });
  invalidateConfig();
  await CurrencyRate.create([{ currency: 'LYD', day: '2026-01-01', rate: 9 }, { currency: 'CNY', day: '2026-01-01', rate: 7 }]);
});

test('C1: yuan bought from brokers, one waiting for arrival; the Alipay dashboard', async () => {
  const alipay = require('../services/posting/alipay');
  const { cancelDocument } = require('../services/cancel');
  const [wasl, caravan] = await Vendor.create([{ name: 'وصل', type: 'service' }, { name: 'القافلة الآمنة', type: 'service' }]);
  const cash = await account('110101');
  const box = await account('110301');

  // 1000$ for 6600 yuan, arrived at once
  const first = await tx((session) => alipay.createYuanPurchase({ vendorId: wasl._id, day: '2026-02-01', fromAccountId: cash._id, amount: 1000, toAccountId: box._id, cnyReceived: 6600 }, { session, req }));
  expect(first).toMatchObject({ usd: 100000, rate: 6.6, arrived: true });
  expect(await getBalance(box._id)).toEqual({ usd: 100000, foreign: 660000 });

  // 500$ paid, yuan not here yet: the dollars wait on the broker
  const second = await tx((session) => alipay.createYuanPurchase({ vendorId: caravan._id, day: '2026-02-02', fromAccountId: cash._id, amount: 500, toAccountId: box._id, cnyExpected: 3300, arrived: false }, { session, req }));
  expect(await balanceOf('110501')).toBe(50000);
  expect((await alipay.dashboard()).pending).toHaveLength(1);

  // 3290 arrived: same dollars, a slightly lower rate
  await tx((session) => alipay.completeYuanPurchase(second._id, { cnyReceived: 3290, day: '2026-02-05' }, { session, req }));
  expect(await balanceOf('110501')).toBe(0);
  expect(await getBalance(box._id)).toEqual({ usd: 150000, foreign: 989000 });

  const board = await alipay.dashboard();
  expect(board.accounts.find((a) => a.code === '110301')).toMatchObject({ cny: 989000, usd: 150000, rate: 6.5933 });
  expect(board.brokers.find((b) => b.name === 'القافلة الآمنة')).toMatchObject({ usd: 50000, cny: 3290, rate: 6.58 });
  expect(board.pending).toHaveLength(0);
  expect(board.months[0]).toMatchObject({ month: '2026-02', boughtUsd: 150000 });

  // Cancelling takes both the purchase and its arrival back
  await tx((session) => cancelDocument('AccountingYuanPurchase', second._id, { session, req, reason: 'خطأ' }));
  expect(await getBalance(box._id)).toEqual({ usd: 100000, foreign: 660000 });
  expect(await balanceOf('110501')).toBe(0);
  expect(await balanceOf('110101')).toBe(-100000);
});

test('C2: a supplier refund on a purchase: cost down by what came in, sale down by what went to the wallet', async () => {
  const { createCustomerRefund } = require('../services/posting/customerRefund');
  const { cancelDocument } = require('../services/cancel');
  const { syncOrder } = require('../services/claims/sync');
  const operations = require('../services/posting/operations');
  const payables = require('../services/posting/payables');
  const Order = require('../../models/order');
  const UserStatement = require('../../models/userStatement');
  const Wallet = require('../../models/wallet');
  await CurrencyRate.create([{ currency: 'TRY', day: '2026-01-01', rate: 40 }]);
  const customer = (await mongoose.connection.collection('users').insertOne({ firstName: 'عميل', customerId: 'C2' })).insertedId;
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'C2-1', user: customer, placedAt: 'tripoli', isPayment: true, totalInvoice: 200, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-02-01'),
  });
  const [alibaba] = await Vendor.create([{ name: 'Alibaba', type: 'supplier' }]);
  const cash = await account('110101');
  await tx((session) => payables.createBill({ vendorId: alibaba._id, day: '2026-02-01', currency: 'USD', paidImmediatelyFrom: cash._id, lines: [{ description: 'goods', amount: 180, target: 'order', orderId }] }, { session, req }));
  await tx((session) => syncOrder(orderId, { session }));
  const dep = await UserStatement.create({ user: customer, createdBy: oid(), description: 'إيداع', amount: 200, currency: 'USD', total: 200, paymentType: 'wallet', calculationType: '+', actionType: 'cash', office: 'tripoli', createdAt: new Date('2026-02-02') });
  await tx((session) => operations.postStatement(dep._id, { session }));
  const spend = await UserStatement.create({ user: customer, createdBy: oid(), description: 'دفع', amount: 200, currency: 'USD', total: 0, paymentType: 'wallet', calculationType: '-', actionType: 'wallet', createdAt: new Date('2026-02-02') });
  await tx((session) => operations.postStatement(spend._id, { session, target: { orderId, category: 'invoice' } }));
  await Wallet.create([{ user: customer, currency: 'USD', balance: 0 }]);
  expect(await balanceOf('410300')).toBe(-20000);
  expect(await balanceOf('510400')).toBe(18000);

  // 1200 lira came into the Kuveyt Türk account, worth 30$ by the bank; 29$ go to the wallet
  const bank = await account('110204');
  const refund = await tx((session) => createCustomerRefund({ day: '2026-03-01', orderId, accountId: bank._id, amount: 1200, walletUsd: 29 }, { session, req }));
  expect(await balanceOf('410300')).toBe(-17100);
  expect(await balanceOf('510400')).toBe(15000);
  expect(await getBalance(bank._id)).toEqual({ usd: 3000, foreign: 120000 });
  expect(await balanceOf('220100', { partnerId: customer })).toBe(-2900);
  expect(await balanceOf('121000')).toBe(0);
  expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(29);
  const line = await UserStatement.findOne({ 'accountingSource.id': refund._id }).lean();
  expect(line).toMatchObject({ actionType: 'refund', amount: 29, calculationType: '+' });

  await tx((session) => cancelDocument('AccountingCustomerRefund', refund._id, { session, req, reason: 'خطأ' }));
  expect(await balanceOf('410300')).toBe(-20000);
  expect(await balanceOf('510400')).toBe(18000);
  expect((await Wallet.findOne({ user: customer, currency: 'USD' })).balance).toBe(0);
});

test('C3: a purchase in Kuwaiti dinars is billed in dinars at the bank dollars; a dollar purchase within 2% links to its order', async () => {
  const bank = require('../services/posting/bank');
  const { SupplierBill, BankStatementLine } = require('../models/documents');
  const Order = require('../../models/order');
  await CurrencyRate.create([{ currency: 'TRY', day: '2026-01-01', rate: 40 }]);
  const lira = await account('110204');
  const fees = await account('530800');
  await tx((session) => bank.importLines(lira._id, [{ day: '2026-03-02', description: 'XCITE KW (12.500 Kuwaiti Dinar)', amount: -1640 }], { session, req }));
  const kwLine = await BankStatementLine.findOne({ accountId: lira._id }).lean();
  await tx((session) => bank.createEntryForLine(kwLine._id, { counterAccountId: fees._id, office: 'turkey', confirmNotDuplicate: true }, { session, req }));
  const bill = await SupplierBill.findOne({ idempotencyKey: `BANK_LINE_BILL:${kwLine._id}` }).lean();
  // 1640 lira at 40 = 41$; 12.500 KD ÷ 41$
  expect(bill).toMatchObject({ currency: 'KWD', total: 12.5, totalUsd: 4100 });
  expect(bill.rate).toBeCloseTo(12.5 / 41, 6);
  expect(await getBalance(lira._id)).toEqual({ usd: -4100, foreign: -164000 });

  // 101.50$ on the card, typed on the order as 100$ two days earlier: linked (within 2%)
  const usdBank = await account('110205');
  const { insertedId: orderId } = await Order.collection.insertOne({
    orderId: 'C3-1', user: oid(), placedAt: 'tripoli', isPayment: true, totalInvoice: 120, unsureOrder: false, isCanceled: false, paymentList: [],
    purchaseItems: [{ _id: oid(), date: new Date('2026-03-08'), description: 'Amazon', unitPrice: 100, currency: 'USD' }], createdAt: new Date('2026-03-08'),
  });
  await tx((session) => bank.importLines(usdBank._id, [{ day: '2026-03-10', description: 'AMAZON US (101.50 US Dollar)', amount: -101.5 }], { session, req }));
  const suggestions = await bank.suggestions(usdBank._id);
  const [suggestion] = Object.values(suggestions);
  expect(suggestion.link).toMatchObject({ orderNumber: 'C3-1', near: true });
  expect(String(suggestion.link.orderId)).toBe(String(orderId));
});

test('C4: an office added in accounting is accepted by the system models; an unknown one is refused', async () => {
  const { AccountingOffice } = require('../models');
  const Balance = require('../../models/balance');
  const UserStatement = require('../../models/userStatement');
  const debt = (createdOffice) => new Balance({ owner: oid(), createdBy: oid(), createdOffice, balanceType: 'debt', amount: 1, initialAmount: 1, currency: 'USD', notes: 'x' });
  await expect(debt('zawiya').validate()).rejects.toThrow('Unknown office');
  await AccountingOffice.create({ code: 'zawiya', name: 'الزاوية' });
  invalidateConfig();
  await expect(debt('zawiya').validate()).resolves.toBeUndefined();
  await expect(debt('tripoli').validate()).resolves.toBeUndefined();
  // Old bank values on a wallet line stay valid
  const line = new UserStatement({ user: oid(), createdBy: oid(), description: 'x', amount: 1, currency: 'USD', total: 1, paymentType: 'wallet', calculationType: '+', office: 'almutahidaTrBank' });
  await expect(line.validate()).resolves.toBeUndefined();
});
