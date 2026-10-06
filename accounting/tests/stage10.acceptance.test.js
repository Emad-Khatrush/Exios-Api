jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, post: ledgerPost } = require('./helpers');
const post = input => ledgerPost({ eventType: 'MANUAL', eventKey: `STAGE10:${input.description}`, ...input });
const { CHECKS } = require('../services/reports/exceptions');
const { writeDump } = require('../services/backup');
const { findTool } = require('../scripts/mongoTools');

jest.setTimeout(120000);
beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

test('purchase-only orders require no shipping method while shipments still require one', () => {
  const Order = require('../../models/order');
  const body = { orderId: 'STAGE10-NOSHIP', placedAt: 'tripoli', customerInfo: { fullName: 'Test' }, shipment: { fromWhere: 'china', toWhere: 'tripoli' }, isPayment: true, isShipment: false };
  expect(new Order(body).validateSync()).toBeUndefined();
  expect(new Order({ ...body, isShipment: true }).validateSync().errors).toHaveProperty(['shipment.method']);
});

test('ready-to-deliver customer view follows individual packages despite a stale order status', async () => {
  const Order = require('../../models/order');
  const { call } = require('./e2eKit');
  const { getUserPackagesOfOrdersAdmin } = require('../../controllers/orders');
  const customer = new mongoose.Types.ObjectId();
  const ready = new mongoose.Types.ObjectId();
  const packages = [
    { _id: ready, status: { arrivedLibya: true, received: false } },
    { _id: new mongoose.Types.ObjectId(), status: { arrivedLibya: false, received: false } },
    { _id: new mongoose.Types.ObjectId(), status: { arrivedLibya: true, received: true } },
  ];
  const body = { user: customer, orderId: 'STAGE10-READY', isShipment: true, isPayment: false, unsureOrder: false, isCanceled: false, orderStatus: 0, paymentList: packages };
  await Order.collection.insertMany([
    body,
    { ...body, orderId: 'STAGE10-CANCELLED', isCanceled: true },
    { ...body, orderId: 'STAGE10-UNCONFIRMED', unsureOrder: true },
    { ...body, orderId: 'STAGE10-PURCHASE', isShipment: false, isPayment: true },
    { ...body, orderId: 'STAGE10-OTHER-CUSTOMER', user: new mongoose.Types.ObjectId() },
  ]);
  const response = await call(getUserPackagesOfOrdersAdmin, { params: { id: String(customer) }, query: { tabType: 'readyForPickup' } });
  expect(response.status).toBe(200);
  expect(response.body.results).toHaveLength(1);
  expect(response.body.results[0].paymentList.map(p => String(p._id))).toEqual([String(ready)]);
});

test('a payment committed between backup collections cannot split wallet and journal versions', async () => {
  const db = mongoose.connection.getClient().db(`stage10_snapshot_${process.pid}`);
  await db.collection('a_wallets').insertOne({ _id: 'wallet', amount: 100 });
  await db.collection('b_journals').insertOne({ _id: 'opening', amount: 100 });
  const getCollection = db.collection.bind(db);
  let committed = false;
  const spy = jest.spyOn(db, 'collection').mockImplementation(name => {
    const collection = getCollection(name);
    if (name === 'a_wallets') {
      const indexes = collection.indexes.bind(collection);
      collection.indexes = async (...args) => {
        if (!committed) {
          const session = db.client.startSession();
          try {
            await session.withTransaction(async () => {
              await getCollection('a_wallets').updateOne({ _id: 'wallet' }, { $inc: { amount: 25 } }, { session });
              await getCollection('b_journals').insertOne({ _id: 'payment', amount: 25 }, { session });
            });
          } finally { await session.endSession(); }
          committed = true;
        }
        return indexes(...args);
      };
    }
    return collection;
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exios-stage10-snapshot-')), 'daily.zip');
  try { await writeDump(db, fs.createWriteStream(file)); } finally { spy.mockRestore(); }
  const zip = new (require('adm-zip'))(file);
  const read = name => {
    const bytes = zip.readFile(`${db.databaseName}/${name}.bson`);
    const rows = [];
    for (let at = 0; at < bytes.length;) {
      const size = bytes.readInt32LE(at);
      rows.push(mongoose.mongo.BSON.deserialize(bytes.subarray(at, at + size)));
      at += size;
    }
    return rows;
  };
  expect(committed).toBe(true);
  expect(read('a_wallets')[0].amount).toBe(100);
  expect(read('b_journals').reduce((sum, row) => sum + row.amount, 0)).toBe(100);
  expect((await db.collection('a_wallets').findOne({ _id: 'wallet' })).amount).toBe(125);
});

test('normal creditor current account and credit-card balances are not negative cash errors', async () => {
  await post({ date: '2026-03-01', description: 'Creditor current account', lines: [
    { accountCode: '110101', debit: 7100, office: 'tripoli' },
    { accountCode: '260100', credit: 7100, office: 'tripoli' },
  ] });
  await post({ date: '2026-03-01', description: 'Credit card balance', lines: [
    { accountCode: '110101', debit: 1000, office: 'tripoli' },
    { accountCode: '250100', credit: 1000, currency: 'TRY', amountCurrency: -40000, rate: 40, office: 'turkey' },
  ] });
  expect((await CHECKS.cashBoxes()).count).toBe(0);
  // Physical cash still cannot have a negative balance.
  await post({ date: '2026-03-01', description: 'Bad historical cash', isHistorical: true, lines: [
    { accountCode: '110103', credit: 100, office: 'benghazi' },
    { accountCode: '310000', debit: 100 },
  ] });
  expect((await CHECKS.cashBoxes()).items.map(i => i.label)).toEqual([expect.stringContaining('110103')]);
});

test('daily backup ZIP restores with real mongorestore and preserves every document and index', async () => {
  if (!findTool('mongorestore')) throw Error('Install MongoDB Database Tools to verify the restore');
  const db = mongoose.connection.db;
  await db.collection('stage10types').insertOne({ decimal: mongoose.mongo.Decimal128.fromString('123.450'), date: new Date('2026-10-05'), bytes: Buffer.from([0, 255, 3]), count: mongoose.mongo.Long.fromString('9007199254740993') });
  await db.collection('stage10types').createIndex({ date: 1 }, { unique: true });
  await post({ date: '2026-03-01', description: 'Restore journal', lines: [
    { accountCode: '110101', debit: 12345, office: 'tripoli' },
    { accountCode: '310000', credit: 12345 },
  ] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'exios-stage10-restore-'));
  const zip = path.join(directory, 'daily.zip');
  const manifest = await writeDump(db, fs.createWriteStream(zip));
  // A different database on the isolated server. Never use the normal local server.
  const target = `stage10_restore_${process.pid}`;
  const uri = `mongodb://127.0.0.1:${mongoose.connection.port}/?directConnection=true`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/restoreLocal.js'), zip], {
      env: { ...process.env, RESTORE_URI: uri, RESTORE_DB: target, RESTORE_FROM_DB: db.databaseName },
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => { child.kill(); reject(Error(`Restore timed out: ${output.slice(-2000)}`)); }, 90000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error(output.slice(-4000))); });
  });
  const restored = mongoose.connection.getClient().db(target);
  let documents = 0;
  for (const { name } of manifest.collections) {
    const original = await db.collection(name).find().sort({ _id: 1 }).toArray();
    const copy = await restored.collection(name).find().sort({ _id: 1 }).toArray();
    expect(mongoose.mongo.BSON.EJSON.stringify(copy, { relaxed: false })).toEqual(mongoose.mongo.BSON.EJSON.stringify(original, { relaxed: false }));
    const sortIndexes = list => list.sort((a, b) => a.name.localeCompare(b.name));
    expect(sortIndexes(await restored.collection(name).indexes())).toEqual(sortIndexes(await db.collection(name).indexes()));
    documents += copy.length;
  }
  expect(documents).toBe(manifest.documents);
  expect(await restored.collection('accountingjournalentries').countDocuments()).toBeGreaterThan(0);
});
