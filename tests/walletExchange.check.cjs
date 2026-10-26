const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/user');
const Wallet = require('../models/wallet');
const Statement = require('../models/userStatement');
const Exchange = require('../models/walletExchange');
const { createExchange } = require('../controllers/walletExchange');
const { quote } = require('../utils/walletExchangeAmounts');
let database, customer, actor;
const input = extra => ({ fromCurrency: 'USD', amount: '100', rate: '9.5', day: '2026-01-01', idempotencyKey: 'exchange_test_key_12345678', ...extra });

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([User.init(), Wallet.init(), Statement.init(), Exchange.init()]);
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
beforeEach(async () => {
  for (const collection of await mongoose.connection.db.collections()) await collection.deleteMany({});
  customer = (await User.collection.insertOne({ firstName: 'Exchange', customerId: 'TEST-X' })).insertedId;
  actor = { _id: new mongoose.Types.ObjectId(), roles: { isAdmin: true }, office: 'tripoli' };
  await Wallet.create({ user: customer, currency: 'USD', balance: 100 });
});
const balance = async currency => Number((await Wallet.findOne({ user: customer, currency }))?.balance || 0);

test('USD to LYD creates one exchange and two linked non-cash statements, including a new destination wallet', async () => {
  const { exchange } = await createExchange(customer, input(), actor);
  assert.equal(await balance('USD'), 0); assert.equal(await balance('LYD'), 950);
  const statements = await Statement.find({ walletExchangeId: exchange._id }).sort({ _id: 1 }).lean();
  assert.equal(statements.length, 2);
  assert.deepEqual(statements.map(s => [s.currency, s.amount, s.calculationType]), [['USD', 100, '-'], ['LYD', 950, '+']]);
  assert.ok(statements.every(s => s.actionType === 'exchange' && s.paymentType === 'wallet' && s.accountingSource.model === 'WalletExchange'));
  assert.equal(exchange.day, '2026-01-01'); assert.equal(exchange.posting.status, 'pending');
});
test('LYD to USD uses the same LYD-per-dollar rate', async () => {
  await Wallet.create({ user: customer, currency: 'LYD', balance: 950 });
  await createExchange(customer, input({ fromCurrency: 'LYD', amount: '950' }), actor);
  assert.equal(await balance('USD'), 200); assert.equal(await balance('LYD'), 0);
});

test('entering the received amount derives LYD per USD in either direction', () => {
  const usd = quote(input({ pricingMode: 'received', toAmount: '950', rate: '-999' }));
  assert.equal(usd.rate, '9.500000'); assert.equal(usd.toMinor, 95000);
  const lyd = quote(input({ fromCurrency: 'LYD', amount: '950', toAmount: '100' }));
  assert.equal(lyd.rate, '9.500000'); assert.equal(lyd.toMinor, 10000);
  assert.equal(quote(input({ fromCurrency: 'LYD', amount: '1000', toAmount: '100' })).rate, '10.000000');
});

test('received-amount conversion moves the exact two amounts and stores its calculation mode', async () => {
  await Wallet.updateOne({ user: customer, currency: 'USD' }, { balance: 1000000 });
  const request = input({ pricingMode: 'received', amount: '1000000', toAmount: '9500000.01' });
  const { exchange } = await createExchange(customer, request, actor);
  assert.equal(exchange.rate, '9.500000');
  assert.equal(exchange.pricingMode, 'received');
  assert.equal(await balance('USD'), 0); assert.equal(await balance('LYD'), 9500000.01);
  assert.equal(exchange.toMinor, 950000001);
  assert.equal((await createExchange(customer, request, actor)).replayed, true);
  // Both rates round to 9.500000, but changing the actual received amount is not a retry.
  await assert.rejects(createExchange(customer, { ...request, toAmount: '9500000.02' }, actor), e => e.statusCode === 409);
  assert.equal(await Exchange.countDocuments(), 1);
});

test('invalid received amounts and pricing modes are refused without moving a wallet', async () => {
  for (const toAmount of ['0', '-1', '1.001', true, '1e3', '0.00001']) {
    await assert.rejects(createExchange(customer, input({ pricingMode: 'received', toAmount }), actor));
  }
  await assert.rejects(createExchange(customer, input({ pricingMode: 'unknown' }), actor));
  await assert.rejects(createExchange(customer, input({ pricingMode: 'received', toAmount: '100000001' }), actor));
  assert.equal(await balance('USD'), 100); assert.equal(await Exchange.countDocuments(), 0);
});

test('received-amount mode supports an actual LYD-to-USD transaction', async () => {
  await Wallet.create({ user: customer, currency: 'LYD', balance: 1000 });
  const { exchange } = await createExchange(customer, input({ fromCurrency: 'LYD', amount: '1000', toAmount: '100' }), actor);
  assert.equal(exchange.rate, '10.000000');
  assert.equal(await balance('USD'), 200); assert.equal(await balance('LYD'), 0);
});
test('rounding is decimal and the client cannot supply the destination amount', () => {
  assert.equal(quote(input({ amount: '0.01', toMinor: 999999 })).toMinor, 10);
  assert.equal(quote(input({ amount: '100.01', rate: '9.123456' })).toMinor, 91244);
  assert.throws(() => quote(input({ fromCurrency: 'LYD', amount: '0.01', rate: '100' })));
});
test('invalid values, currencies and future dates never move money', async () => {
  for (const extra of [{ amount: '-1' }, { amount: '1.001' }, { amount: true }, { rate: '0' }, { rate: '1e2' },
    { rate: '9.1234567' }, { fromCurrency: 'EUR' }, { day: '2026-02-30' }, { day: '2099-01-01' }]) {
    await assert.rejects(createExchange(customer, input(extra), actor));
  }
  assert.equal(await balance('USD'), 100); assert.equal(await Exchange.countDocuments(), 0);
});
test('insufficient funds and unauthorized customers are refused atomically', async () => {
  await assert.rejects(createExchange(customer, input({ amount: '100.01' }), actor));
  await assert.rejects(createExchange(customer, input(), { ...actor, roles: { isClient: true } }), e => e.statusCode === 403);
  assert.equal(await balance('USD'), 100); assert.equal(await balance('LYD'), 0);
  assert.equal(await Statement.countDocuments(), 0);
});
test('retries and simultaneous clicks execute once; reuse with changed amounts is refused', async () => {
  const replies = await Promise.all([createExchange(customer, input(), actor), createExchange(customer, input(), actor)]);
  assert.equal(replies.filter(r => r.replayed).length, 1);
  await createExchange(customer, input(), actor);
  await assert.rejects(createExchange(customer, input({ amount: '50' }), actor), e => e.statusCode === 409);
  assert.equal(await balance('USD'), 0); assert.equal(await balance('LYD'), 950);
  assert.equal(await Exchange.countDocuments(), 1); assert.equal(await Statement.countDocuments(), 2);
});
test('two competing conversions cannot overdraw the source wallet', async () => {
  const replies = await Promise.allSettled([
    createExchange(customer, input({ amount: '80' }), actor),
    createExchange(customer, input({ amount: '80', idempotencyKey: 'exchange_test_key_87654321' }), actor),
  ]);
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await balance('USD'), 20); assert.equal(await balance('LYD'), 760);
});
test('a failed statement write rolls back both wallets and the exchange', async () => {
  const original = Statement.create;
  Statement.create = async () => { throw Error('receipt storage unavailable'); };
  try { await assert.rejects(createExchange(customer, input(), actor), /receipt storage unavailable/); }
  finally { Statement.create = original; }
  assert.equal(await balance('USD'), 100); assert.equal(await balance('LYD'), 0);
  assert.equal(await Exchange.countDocuments(), 0);
});
test('backdated exchanges preserve insertion-based totals and duplicate wallets are refused', async () => {
  await Statement.create({ user: customer, createdBy: actor._id, amount: 100, currency: 'USD', total: 100,
    calculationType: '+', paymentType: 'wallet', actionType: 'cash', description: 'opening', createdAt: new Date('2026-02-01') });
  await createExchange(customer, input(), actor);
  const last = await Statement.findOne({ user: customer, currency: 'USD' }).sort({ _id: -1 });
  assert.equal(last.total, 0); assert.equal(last.createdAt.toISOString().slice(0, 10), '2026-01-01');
  await Wallet.create({ user: customer, currency: 'LYD', balance: 1 });
  await assert.rejects(createExchange(customer, input({ fromCurrency: 'LYD', amount: '1', idempotencyKey: 'exchange_test_key_00000000' }), actor), /مكررة/);
});

test('a legacy withdrawal cannot overwrite a conversion using an earlier balance snapshot', async () => {
  let releaseUpload, uploadStarted;
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const paused = new Promise(resolve => { releaseUpload = resolve; });
  const cloud = require.resolve('../utils/googleClould');
  const previous = require.cache[cloud];
  require.cache[cloud] = { id: cloud, filename: cloud, loaded: true, exports: {
    uploadToGoogleCloud: async () => { uploadStarted(); await paused; return { publicUrl: 'test://receipt', filename: 'test.png' }; },
  } };
  const controllerPath = require.resolve('../controllers/wallet');
  delete require.cache[controllerPath];
  try {
    const legacy = require('../controllers/wallet');
    let failure;
    const withdrawal = legacy.useBalanceOfWallet({ params: { id: String(customer) }, user: actor,
      body: { amount: 50, currency: 'USD', actionType: 'withdrawal', description: 'concurrent withdrawal', createdAt: new Date() },
      files: [{ originalname: 'test.png', mimetype: 'image/png' }],
    }, { status() { return this; }, json() {} }, error => { failure = error; });
    await started;
    await createExchange(customer, input({ amount: '80' }), actor);
    releaseUpload(); await withdrawal;
    assert.equal(failure.statusCode, 409);
    assert.equal(await balance('USD'), 20); assert.equal(await balance('LYD'), 760);
    assert.equal(await Statement.countDocuments(), 2);
  } finally {
    releaseUpload(); delete require.cache[controllerPath];
    if (previous) require.cache[cloud] = previous; else delete require.cache[cloud];
  }
});
