const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { Vendor, BankStatementLine, BankRule } = require('../models/documents');
const { JournalEntry } = require('../models');
const { runInTransaction: tx } = require('../services/transaction');
const { getBalance } = require('../services/carrying');
const { runSetup } = require('../seed/setup');
const merchants = require('../services/posting/bankMerchants');
const bank = require('../services/posting/bank');
const { ensureMerchantSetup } = require('../seed/merchantSetup');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb); beforeEach(async () => { await resetDb(); });

test('seed catalogue is idempotent, adopts existing suppliers, and keeps learned aliases', async () => {
  const vendor = await Vendor.findOne({ name: 'Alibaba' });
  await Vendor.updateOne({ _id: vendor._id }, { $unset: { seedKey: 1 }, $addToSet: { bankAliases: 'alibaba custom' } });
  const counts = [await Vendor.countDocuments(), await BankRule.countDocuments()];
  await runSetup();
  expect([await Vendor.countDocuments(), await BankRule.countDocuments()]).toEqual(counts);
  expect((await Vendor.findById(vendor._id)).bankAliases).toContain('alibaba custom');
  const rule = await BankRule.findOne({ keyword: 'alibaba' });
  await BankRule.updateOne({ _id: rule._id }, { $set: { priority: 99, vendorName: 'Owner edited name' } });
  await Vendor.deleteOne({ name: '1688' });
  const manual = await Vendor.create({ name: '1688.com' });
  await ensureMerchantSetup(); await ensureMerchantSetup();
  expect(await Vendor.countDocuments()).toBe(counts[0]);
  expect(await BankRule.countDocuments()).toBe(counts[1]);
  expect((await Vendor.findById(manual._id)).bankAliases).toContain('1688');
  expect(await BankRule.findById(rule._id)).toMatchObject({ priority: 99, vendorName: 'Owner edited name' });
  expect(await JournalEntry.countDocuments()).toBe(0);
});

test('known supplier credit without foreign metadata stays unposted and cannot bypass refund review', async () => {
  const source = await account('110204'); const equity = await account('310000');
  const row = { day: '2026-08-02', amount: 100, description: 'www.shein.comDubaiAE' };
  const preview = (await bank.classifyRows(source._id, [row]))[0];
  expect(preview).toMatchObject({ isRefund: true, vendorName: 'Shein', account: null, requiresConfirmation: true });
  await bank.importStatement(source._id, [row], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id });
  expect(line.lineStatus).toBe('unmatched');
  expect((await bank.suggestions(source._id))[line._id].vendorName).toBe('Shein');
  await expect(tx(session => bank.createEntryForLine(line._id, { counterAccountId: equity._id }, { session, req }))).rejects.toThrow('استرداد');
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await getBalance(source._id)).toEqual({ usd: 0, foreign: 0 });
});

test('card funding and company services are not inferred as purchase supplier refunds', async () => {
  const source = await account('250200');
  const results = await bank.classifyRows(source._id, [
    { day: '2026-08-02', amount: 100, description: 'ÖDEME İÇİN TEŞEKKÜR EDERİZ', movementKind: 'card_payment' },
    { day: '2026-08-02', amount: 101, description: 'Google cloud reimbursement' },
  ]);
  expect(results.every(r => !r.isRefund)).toBe(true);
});

test('approved unknown merchant is learned across changed amounts, in its bank only, and reassignment replaces the previous vendor', async () => {
  const source = await account('110204'); const otherBank = await account('110203');
  const expense = await account('530800'); const supplier = await Vendor.create({ name: 'Private Gulf supplier' });
  const line = { accountId: source._id, description: 'MF*NewShopKuwaitKW 55.00 SAR (14.65 USD)' };
  await tx(session => merchants.learn(line, supplier._id, expense._id, session));
  const next = { description: 'MF*NewShopKuwaitKW 25.00 SAR (6.66 USD)' };
  expect((await merchants.matcher(source._id))(next)).toMatchObject({ vendorName: supplier.name, learned: true });
  expect((await merchants.matcher(otherBank._id))(next)).toBeNull();
  expect((await merchants.matcher(source._id))({ description: 'MF*DifferentShopKuwaitKW' })).toBeNull();
  const replacement = await Vendor.create({ name: 'Correct supplier' });
  await tx(session => merchants.learn(line, replacement._id, expense._id, session));
  expect((await merchants.matcher(source._id))(next).vendorName).toBe(replacement.name);
  const hint = (await bank.classifyRows(source._id, [{ day: '2026-08-02', amount: 200, ...next }]))[0];
  expect(hint).toMatchObject({ isRefund: true, vendorName: replacement.name, account: null, refundAccount: { code: '530800' } });
});

test('gateway and country hints alone never identify a supplier or automatically post incoming purchase money', async () => {
  const source = await account('110204'); const supplier = await Vendor.create({ name: 'Private supplier' });
  await tx(session => merchants.learn({ accountId: source._id, description: 'TAP' }, supplier._id, null, session));
  expect((await merchants.matcher(source._id))({ description: 'TAP' })).toBeNull();
  const hint = (await bank.classifyRows(source._id, [{ day: '2026-08-02', amount: 200, description: 'MF*UnknownShopKuwaitKW' }]))[0];
  expect(hint).toMatchObject({ isRefund: true, requiresConfirmation: true, account: null, vendorId: null });
});

test('conflicting aliases and inactive vendors do not invent a supplier match', async () => {
  const source = await account('110204');
  await Vendor.create([{ name: 'Shop A', bankAliases: ['unique descriptor'] }, { name: 'Shop B', bankAliases: ['unique descriptor'] },
    { name: 'Disabled Shop', bankAliases: ['disabledsite'], isActive: false }]);
  const identify = await merchants.matcher(source._id);
  expect(identify({ description: 'unique descriptor' })).toBeNull();
  expect(identify({ description: 'disabledsite' })).toBeNull();
});

test('accepting a real unknown merchant invoice learns its supplier and subsequent refund context', async () => {
  const source = await account('110202'); const expense = await account('530800');
  const supplier = await Vendor.create({ name: 'New private China supplier' });
  const bill = await tx(session => require('../services/posting/payables').createBill({ vendorId: supplier._id,
    day: '2026-08-02', currency: 'USD', lines: [{ description: 'Purchased goods', target: 'expense', accountId: expense._id, office: 'turkey', amount: 55 }] }, { session, req, asDraft: true }));
  await bank.importStatement(source._id, [{ day: bill.day, amount: -55, description: 'MF*MyNewShop 55.00 USD', originalAmount: 55, originalCurrency: 'USD' }], { req });
  const line = await BankStatementLine.findOne({ accountId: source._id });
  await tx(session => require('../services/posting/bankPurchaseReview').matchPurchase(line._id, { kind: 'bill', billId: bill._id }, { session, req }));
  const row = { day: '2026-08-03', amount: 5, description: 'MF*MyNewShop 5.00 USD' };
  expect((await bank.classifyRows(source._id, [row]))[0]).toMatchObject({ isRefund: true, vendorName: supplier.name, refundAccount: { code: '530800' } });
  expect(await Vendor.countDocuments({ name: supplier.name })).toBe(1);
});


test('YalukII and IKEA get distinct service and goods classifications', async () => {
  const source = await account('110202');
  const hints = await bank.classifyRows(source._id, [
    {day:'2026-09-01', amount:-100, description:'YalukII factory visit'},
    {day:'2026-09-01', amount:-200, description:'IKEA goods'},
  ]);
  expect(hints[0]).toMatchObject({source:'service', vendorName:'YalukII', office:'china', account:{code:'531700'}});
  expect(hints[1]).toMatchObject({vendorName:'IKEA', account:{code:'510400'}});
  expect((await merchants.matcher(source._id))({description:'Yalukll truck service'})).toMatchObject({vendorName:'YalukII',vendorType:'service'});
});

test('AlQFILA is yuan purchase, never a goods expense or a supplier refund by merchant name alone', async () => {
  const source=await account('110202'); const expense=await account('510400');
  const rows=[{day:'2026-09-01',amount:-100,description:'AlQFILA'}, {day:'2026-09-01',amount:100,description:'AlQFILA'}];
  const hints=await bank.classifyRows(source._id,rows);
  expect(hints[0]).toMatchObject({source:'yuan',account:null,requiresConfirmation:true});
  expect(hints[1]).toMatchObject({source:'yuan',account:null,requiresConfirmation:true});
  expect(hints[1].isRefund).toBeFalsy();
  await bank.importStatement(source._id,[{...rows[0],counterAccountId:expense._id,office:'china'}],{req});
  expect(await require('../models/documents').SupplierBill.countDocuments()).toBe(0);
  expect(await getBalance(source._id)).toEqual({usd:0,foreign:0});
});

test('unknown purchase defaults to purchase cost while unknown transfers remain for review', async () => {
  const source=await account('110202');
  const hints=await bank.classifyRows(source._id,[{day:'2026-09-01',amount:-100,description:'Unlisted shop',originalAmount:100,originalCurrency:'USD'},
    {day:'2026-09-01',amount:-200,description:'Personal transfer to unknown person'}]);
  expect(hints[0]).toMatchObject({source:'purchase_default',account:{code:'510400'}});
  expect(hints[1].account).toBeNull();
});

test('original YalukII supplier invoice wins over the default service expense', async () => {
  const source=await account('110202');const expense=await account('531000');const vendor=await Vendor.findOne({name:'YalukII'});
  const bill=await tx(session=>require('../services/posting/payables').createBill({vendorId:vendor._id,day:'2026-09-01',currency:'USD',
    lines:[{target:'expense',accountId:expense._id,office:'china',description:'Recorded special service',amount:100}]},{session,req}));
  const hint=(await bank.classifyRows(source._id,[{day:'2026-09-01',amount:-100,description:'YalukII service payment',originalAmount:100,originalCurrency:'USD'}]))[0];
  expect(hint.source).toBe('bill');expect(String(hint.suggestedBillId)).toBe(String(bill._id));expect(hint.account).toBeNull();
});
