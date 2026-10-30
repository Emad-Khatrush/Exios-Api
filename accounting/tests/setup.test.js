const { startDb, stopDb, resetDb, oid } = require('./helpers');
const { Account, Journal, AccountingSettings, Currency, AccountingOffice } = require('../models');
const { runSetup } = require('../seed/setup');
const { ROLE_DEFAULTS, ACCOUNTS, CURRENCIES, OFFICES } = require('../seed/defaults');
const UserStatement = require('../../models/userStatement');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => resetDb({ setup: false }));

const statement = (office, currency) => ({
  user: oid(), createdBy: oid(), description: 'x', amount: 1, currency, total: 1,
  paymentType: 'wallet', calculationType: '+', actionType: 'cash', office,
});

describe('accounting setup (scenario 24)', () => {
  test('creates everything on an empty database, ready to post', async () => {
    const report = await runSetup();
    expect(report.created.length).toBeGreaterThan(50);
    // Every default account once (the bank funding setup adds its investment, loan and funder accounts beside them)
    expect(await Account.countDocuments({ seedKey: { $in: ACCOUNTS.map((a) => a.code) } })).toBe(ACCOUNTS.length);
    expect(await Currency.countDocuments()).toBe(CURRENCIES.length);
    expect(await AccountingOffice.countDocuments()).toBe(OFFICES.length);

    const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
    Object.keys(ROLE_DEFAULTS).forEach((role) => expect(settings.accountRoles[role]).toBeTruthy());
    expect(settings.officeAccounts.tripoli.LYD).toBeTruthy();
    expect(settings.eventJournals.DEPOSIT).toBe('@cash');

    // every cash, bank and e-wallet account has its journal
    const cashCount = await Account.countDocuments({ isCash: true });
    expect(await Journal.countDocuments({ defaultAccountId: { $ne: null } })).toBe(cashCount);
  });

  test('running it again creates nothing and keeps manual edits', async () => {
    await runSetup();
    const accounts = await Account.countDocuments();
    await Account.updateOne({ code: '530200' }, { $set: { name: 'إيجار المكاتب' } });
    await Account.updateOne({ code: '110101' }, { $set: { code: '110199' } });

    const second = await runSetup();
    expect(second.created).toEqual([]);
    expect((await Account.findOne({ seedKey: '530200' })).name).toBe('إيجار المكاتب');
    expect(await Account.exists({ code: '110101' })).toBeNull();
    expect(await Account.countDocuments()).toBe(accounts);
  });

  test('adds cash boxes for office/currency pairs found in deposits, and maps the bank alias', async () => {
    await UserStatement.create([statement('turkey', 'LYD'), statement('almutahidaTrBank', 'USD'), statement('almutahidaTrBank', 'LYD'), statement('tripoli', 'USD')]);
    await runSetup();

    const turkeyLyd = await Account.findOne({ seedKey: 'cash:turkey:LYD' });
    expect(turkeyLyd.code).toBe('110125');
    const bankLyd = await Account.findOne({ seedKey: 'cash:almutahidaTrBank:LYD' });
    expect(bankLyd.cashKind).toBe('bank');
    expect(bankLyd.office).toBe('turkey');

    const settings = await AccountingSettings.findOne({ key: 'main' }).lean();
    expect(String(settings.officeAccounts.turkey.LYD)).toBe(String(turkeyLyd._id));
    expect(String(settings.officeAccounts.almutahidaTrBank.LYD)).toBe(String(bankLyd._id));
    expect(String(settings.officeAccounts.almutahidaTrBank.USD)).toBe(String((await Account.findOne({ code: '110201' }))._id));
    expect(settings.officeAliases.almutahidaTrBank).toBe('turkey');
    // no duplicate for pairs the defaults already cover
    expect(await Account.exists({ seedKey: 'cash:tripoli:USD' })).toBeNull();

    const again = await runSetup();
    expect(again.created).toEqual([]);
  });
});
