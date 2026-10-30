const { startDb, stopDb, resetDb, account, post } = require('./helpers');
const { Account, JournalEntry, AccountingOffice } = require('../models');
const { Vendor, BankRule, BankStatementLine } = require('../models/documents');
const { BankMatchingHint: Hint, BankMatchingProfileRun: Run } = require('../models/bankMatchingProfile');
const profileService = require('../services/bankMatchingProfile');
const bank = require('../services/posting/bank');
beforeAll(startDb); afterAll(stopDb); beforeEach(resetDb);
async function fixture() {
  const accounts = await Account.find({ code: { $in: ['110204','530200'] } }).lean();
  return { version:1, accounts:accounts.map(a => ({ code:a.code, type:a.type, currency:a.currency || 'USD', office:a.office || '', isCash:!!a.isCash })),
    vendors:[{ name:'Portable merchant', type:'supplier', defaultCurrency:'USD', bankAliases:['portable shop'], mappings:[{ accountCode:'110204', merchant:'portable terminal', counterAccountCode:'530200' }] }],
    rules:[{ accountCode:'110204', keyword:'portable rule', direction:'out', counterAccountCode:'530200', office:'turkey', priority:1, vendorName:'Portable merchant' }],
    history:[{ accountCode:'110204', description:'exact past text', counterAccountCode:'530200', office:'turkey' }] };
}
test('portable profile maps new database IDs, survives restart without duplication, and does not copy transactions', async () => {
  const profile = await fixture(), oldId = String((await account('110204'))._id);
  await resetDb(); expect(String((await account('110204'))._id)).not.toBe(oldId);
  expect(await profileService.apply(profile)).toMatchObject({ dryRun:true, vendors:1, rules:1, history:1 });
  expect(await Vendor.exists({ name:'Portable merchant' })).toBeNull();
  await profileService.apply(profile, { dryRun:false });
  const vendor = await Vendor.findOne({ name:'Portable merchant' });
  expect(String(vendor.bankMappings[0].accountId)).toBe(String((await account('110204'))._id));
  expect(await profileService.apply(profile, { dryRun:false })).toMatchObject({ alreadyApplied:true });
  expect(await Run.countDocuments()).toBe(1); expect(await Hint.countDocuments()).toBe(1);
  expect(await JournalEntry.countDocuments()).toBe(0); expect(await BankStatementLine.countDocuments()).toBe(0);
  const source = await account('110204');
  const [hint] = await bank.classifyRows(source._id, [{ day:'2026-01-08', amount:-12345, description:'exact past text' }]);
  expect(hint).toMatchObject({ source:'history', account:{ code:'530200' } });
});
test('changed or missing target configuration prevents all writes rather than replacing production choices', async () => {
  const profile = await fixture();
  await BankRule.create({ accountId:(await account('110204'))._id, counterAccountId:(await account('510400'))._id, keyword:'portable rule', direction:'out', priority:1 });
  await expect(profileService.apply(profile, { dryRun:false })).rejects.toThrow(/rule differs/);
  expect(await Vendor.exists({ name:'Portable merchant' })).toBeNull(); expect(await Run.countDocuments()).toBe(0);
  await BankRule.deleteMany({ keyword:'portable rule' });
  await Account.updateOne({ code:'530200' }, { $set:{ isActive:false } });
  await expect(profileService.apply(profile, { dryRun:false })).rejects.toThrow(/account/);
  expect(await Hint.countDocuments()).toBe(0);
});

test('multiple rules and history hints import in one transaction and a late failure rolls everything back', async () => {
  const profile = await fixture();
  profile.rules.push({ ...profile.rules[0], keyword:'second portable rule' });
  profile.history.push({ ...profile.history[0], description:'second exact past text' });
  const before = { vendors:await Vendor.countDocuments(), rules:await BankRule.countDocuments() };
  const failure = jest.spyOn(Hint, 'create').mockRejectedValueOnce(new Error('Late history import failure'));
  try { await expect(profileService.apply(profile, { dryRun:false })).rejects.toThrow('Late history import failure'); }
  finally { failure.mockRestore(); }
  expect(await Vendor.countDocuments()).toBe(before.vendors);
  expect(await BankRule.countDocuments()).toBe(before.rules);
  expect(await Run.countDocuments()).toBe(0);
  expect(await Hint.countDocuments()).toBe(0);
  expect(await profileService.apply(profile, { dryRun:false })).toMatchObject({ vendors:1, rules:2, history:2 });
  expect(await Hint.countDocuments()).toBe(2);
  expect(await BankRule.countDocuments()).toBe(before.rules + 2);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await profileService.apply(profile, { dryRun:false })).toMatchObject({ alreadyApplied:true });
});
test('an existing merchant mapping cannot silently be reassigned to another supplier', async () => {
  const profile = await fixture(), accountId = (await account('110204'))._id;
  await Vendor.create({ name:'Production merchant', bankMappings:[{ accountId, merchant:'portable terminal' }] });
  await expect(profileService.apply(profile, { dryRun:false })).rejects.toThrow(/another vendor/);
  expect(await Vendor.exists({ name:'Portable merchant' })).toBeNull();
});
test('snapshot contains codes and exact historical classifications without financial documents or local IDs', async () => {
  const source = await account('110204'), expense = await account('530200');
  const entry = await post({ eventType:'SALARY', eventKey:'PORTABLE:HISTORY', date:'2026-01-05', description:'Original private financial entry',
    lines:[{ accountId:source._id, credit:10000, office:'turkey', currency:'TRY', amountCurrency:-10000, rate:1 },{ accountId:expense._id, debit:10000, office:'turkey' }] });
  await BankStatementLine.collection.insertOne({ accountId:source._id, entryId:entry._id, lineStatus:'created_entry', day:'2026-01-05', amount:-10000, description:'ÖDEME ١٢٣' });
  const profile = await profileService.snapshot();
  expect(profile.history).toContainEqual({ accountCode:'110204', description:bank.normalize('ÖDEME ١٢٣'), counterAccountCode:'530200', office:'turkey' });
  expect(JSON.stringify(profile)).not.toContain(String(entry._id));
  expect(JSON.stringify(profile)).not.toContain(String(source._id));
  expect(JSON.stringify(profile)).not.toContain('Original private financial entry');
});

test('entire shipped configuration imports on a new compatible database without copying financial operations', async () => {
  const profile = require('../seed/bankMatchingProfile.json');
  await resetDb({ setup:false });
  await AccountingOffice.create(require('../seed/defaults').OFFICES);
  await Account.create(profile.accounts.map(a => ({ ...a, name:`Target ${a.code}`, isActive:true, isGroup:false })));
  expect(await profileService.apply(profile, { dryRun:false })).toMatchObject({
    vendors:profile.vendors.length, rules:profile.rules.length, history:profile.history.length,
  });
  expect(await Hint.countDocuments()).toBe(profile.history.length);
  expect(await Vendor.countDocuments()).toBe(profile.vendors.length);
  expect(await JournalEntry.countDocuments()).toBe(0);
  expect(await BankStatementLine.countDocuments()).toBe(0);
  expect(await profileService.apply(profile, { dryRun:false })).toMatchObject({ alreadyApplied:true });
});
