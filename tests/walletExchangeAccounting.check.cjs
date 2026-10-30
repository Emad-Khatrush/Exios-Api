const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const available = fs.existsSync(path.join(__dirname, '../accounting/services/config.js'));

describe('wallet exchange accounting compatibility', { skip: !available }, () => {
  let mongoose, database, User, Wallet, Statement, Exchange, JournalEntry, Settings, actor, customer;
  let createExchange, tx, postStatement, config;
  const input = extra => ({ fromCurrency: 'USD', amount: '100', rate: '9.5', day: '2026-01-03', idempotencyKey: 'accounting_exchange_test_12345678', ...extra });
  before(async () => {
    process.env.ACCOUNTING_DEV_ALL_ADMINS = 'true';
    mongoose = require('mongoose');
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    User = require('../models/user'); Wallet = require('../models/wallet'); Statement = require('../models/userStatement'); Exchange = require('../models/walletExchange');
    ({ JournalEntry, AccountingSettings: Settings } = require('../accounting/models'));
    ({ createExchange } = require('../controllers/walletExchange'));
    tx = require('../accounting/services/transaction').runInTransaction;
    postStatement = require('../accounting/services/posting/operations').postStatement;
    config = require('../accounting/services/config');
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(database.getUri());
    await Promise.all(mongoose.modelNames().map(n => mongoose.model(n).init()));
  });
  after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
  beforeEach(async () => {
    for (const c of await mongoose.connection.db.collections()) await c.deleteMany({});
    config.invalidateConfig(); await require('../accounting/seed/setup').runSetup();
    await Settings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
    config.invalidateConfig();
    await require('../accounting/models').CurrencyRate.create({ currency: 'LYD', day: '2026-01-01', rate: 10 });
    actor = { _id: new mongoose.Types.ObjectId(), roles: { isAdmin: true }, office: 'tripoli' };
    await User.collection.insertOne({ ...actor, firstName: 'Admin', username: 'fx-admin', phone: 910000001, customerId: 'FX-ADMIN' });
    customer = (await User.collection.insertOne({ firstName: 'Test', username: 'fx-client', phone: 910000002, customerId: 'FX-COMPAT' })).insertedId;
    await Wallet.create({ user: customer, currency: 'USD', balance: 100 });
    const s = await Statement.create({ user: customer, createdBy: actor._id, currency: 'USD', amount: 100, total: 100,
      calculationType: '+', paymentType: 'wallet', actionType: 'cash', description: 'initial test deposit', office: 'tripoli', createdAt: new Date('2026-01-02T12:00:00Z') });
    await tx(session => postStatement(s._id, { session, user: actor }));
    await require('../accounting/services/events').emitAccountingEvent('statement', s._id, {}, actor);
    await require('../accounting/services/events').processQueue();
  });
  const balance = async c => (await Wallet.findOne({ user: customer, currency: c }))?.balance || 0;
  const entry = async id => JournalEntry.findOne({ eventKey: `WALLET_EXCHANGE:${id}` }).lean();
  const totals = async code => (await JournalEntry.find({ 'lines.accountCode': code }).lean()).flatMap(e => e.lines).filter(l => l.accountCode === code).reduce((s,l) => s+l.debit-l.credit,0);

  test('live conversions use wallet liabilities and actual FX gain/loss, never a cash account', async () => {
    const first = await createExchange(customer, input(), actor);
    const e = await entry(first.exchange._id);
    assert.ok(e); assert.equal(e.lines.reduce((s,l)=>s+l.debit-l.credit,0),0);
    assert.equal(await totals('220100'), 0); assert.equal(await totals('220200'), -9500);
    assert.equal(await totals('420100'), -500);
    assert.ok(e.lines.every(l => !l.accountCode.startsWith('110')));
    const lyd = e.lines.find(l => l.accountCode === '220200');
    assert.equal(lyd.amountCurrency, -950000); // Native LYD precision is three decimals.
    assert.equal(String(lyd.partnerId), String(customer));
    await createExchange(customer, input({ fromCurrency: 'LYD', amount: '950', day: '2026-01-04', idempotencyKey: 'accounting_exchange_reverse_12345' }), actor);
    assert.equal(await balance('USD'), 100); assert.equal(await balance('LYD'), 0);
    assert.equal(await totals('220200'), 0); assert.equal(await totals('710300'), 500);
  });
  test('both statement events and retries reuse one journal entry', async () => {
    const { exchange } = await createExchange(customer, input(), actor);
    await require('../accounting/services/events').processQueue();
    await tx(session => postStatement(exchange.toStatementId, { session, user: actor }));
    await createExchange(customer, input(), actor);
    assert.equal(await JournalEntry.countDocuments({ eventKey: `WALLET_EXCHANGE:${exchange._id}` }), 1);
    const checks = require('../accounting/services/reports/exceptions').CHECKS;
    for (const name of ['balanced', 'wallets', 'walletDeductions', 'liveCoverage', 'failedEvents']) assert.equal((await checks[name]()).count, 0, name);
  });
  test('closed periods reject the conversion without moving either wallet', async () => {
    await Settings.updateOne({ key: 'main' }, { $set: { lockDate: '2026-01-03' } }); config.invalidateConfig();
    await assert.rejects(createExchange(customer, input(), actor));
    assert.equal(await balance('USD'), 100); assert.equal(await balance('LYD'), 0);
    assert.equal(await Exchange.countDocuments(), 0);
  });
  test('pre-live exchanges replay once from their paired statements without marking a dry run committed', async () => {
    await Settings.updateOne({ key: 'main' }, { $set: { liveEnabled: false } }); config.invalidateConfig();
    const { exchange } = await createExchange(customer, input(), actor);
    assert.equal(await entry(exchange._id), null);
    for (const id of [exchange.fromStatementId, exchange.toStatementId]) await tx(session => postStatement(id, { session, user: actor, isHistorical: true, migrationRunId: 'MIG-FX-COMPAT' }));
    assert.equal(await JournalEntry.countDocuments({ eventKey: `WALLET_EXCHANGE:${exchange._id}` }), 1);
    assert.equal((await Exchange.findById(exchange._id)).posting.status, 'pending');
    assert.equal((await entry(exchange._id)).migrationRunId, 'MIG-FX-COMPAT');
  });
  test('a journal failure rolls back both wallets, both statement legs and the exchange document', async () => {
    const ledger = require('../accounting/services/ledger'), original = ledger.postEntry;
    const statementCount = await Statement.countDocuments(), entries = await JournalEntry.countDocuments();
    ledger.postEntry = async () => { throw new Error('Simulated ledger failure'); };
    try { await assert.rejects(createExchange(customer, input(), actor), /Simulated ledger failure/); }
    finally { ledger.postEntry = original; }
    assert.equal(await balance('USD'),100); assert.equal(await balance('LYD'),0);
    assert.equal(await Statement.countDocuments(),statementCount);
    assert.equal(await JournalEntry.countDocuments(),entries);
    assert.equal(await Exchange.countDocuments(),0);
  });
  test('statement edit/delete cannot change one exchange leg and regular deposit/withdraw paths cannot forge an exchange', async () => {
    const { exchange } = await createExchange(customer,input(),actor);
    const cloud = require.resolve('../utils/googleClould'), previous = require.cache[cloud];
    require.cache[cloud] = { id:cloud, filename:cloud, loaded:true, exports:{ uploadToGoogleCloud:async()=>{throw new Error('Unexpected upload in exchange guard test');} } };
    let wallet;
    try { wallet = require('../controllers/wallet'); }
    finally { if(previous)require.cache[cloud]=previous;else delete require.cache[cloud]; }
    for (const action of ['updateStatement','deleteStatement']) {
      let error;
      await wallet[action]({ params:{ id:String(customer), statementId:String(exchange.toStatementId) }, body:{ amount:1 }, user:actor }, {}, e=>{error=e;});
      assert.equal(error?.statusCode,400);
    }
    for (const action of ['addBalanceToWallet','useBalanceOfWallet']) {
      let error;
      await wallet[action]({params:{id:String(customer)},body:{actionType:'exchange',amount:10,currency:'USD'},user:actor},{},e=>{error=e;});
      assert.equal(error?.statusCode,400);
    }
    assert.equal(await balance('USD'),0); assert.equal(await balance('LYD'),950);
    assert.equal(await JournalEntry.countDocuments({eventKey:`WALLET_EXCHANGE:${exchange._id}`}),1);
  });
  test('daily employee review shows the paired exchange once with its journal instead of two unrelated wallet payments', async () => {
    const { exchange } = await createExchange(customer,input(),actor);
    const today = require('../accounting/services/dates').today();
    const report = await require('../accounting/services/employeeOperations').list({from:today,to:today,kind:'wallet_exchange'});
    assert.equal(report.total,1);
    assert.equal(report.results[0].sourceModel,'WalletExchange');
    assert.equal(String(report.results[0].sourceId),String(exchange._id));
    assert.equal(report.results[0].entries.length,1);
    assert.match(report.results[0].description,/950 LYD/);
  });
});
