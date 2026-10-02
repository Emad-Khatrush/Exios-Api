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
