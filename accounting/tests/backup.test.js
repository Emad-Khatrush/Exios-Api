// Daily database backup (owner's request, 2026-10-02): a zip in mongodump's folder layout,
// streamed to a private bucket, old files pruned, one backup at a time
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const AdmZip = require('adm-zip');
const { startDb, stopDb } = require('./helpers');
const backup = require('../services/backup');

const { BSON } = mongoose.mongo;

beforeAll(startDb);
afterAll(stopDb);

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exios-backup-test-')), 'out.zip');

// Reads a .bson file: documents one after another, each starting with its own length
function readBson(buffer) {
  const docs = [];
  let at = 0;
  while (at < buffer.length) {
    const size = buffer.readInt32LE(at);
    docs.push(BSON.deserialize(buffer.subarray(at, at + size)));
    at += size;
  }
  return docs;
}

// A bucket kept on disk, shaped like the Google client's
function fakeBucket(dir) {
  return {
    name: 'test-private-bucket',
    file: (name) => ({
      createWriteStream: () => {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        return fs.createWriteStream(path.join(dir, name));
      },
      delete: async () => fs.rmSync(path.join(dir, name), { force: true }),
    }),
    getFiles: async ({ prefix }) => [fs.readdirSync(path.join(dir, prefix)).map((f) => ({ name: `${prefix}${f}` }))],
  };
}

test('the zip holds every collection as BSON with its indexes, without the WhatsApp session', async () => {
  const db = mongoose.connection.db;
  const id = new mongoose.Types.ObjectId();
  await db.collection('orders').insertMany([{ _id: id, orderId: 'A1', total: mongoose.mongo.Decimal128.fromString('12.50'), at: new Date('2026-01-02') }, { orderId: 'A2' }]);
  await db.collection('orders').createIndex({ orderId: 1 }, { unique: true });
  await db.collection('whatsappsessions').insertOne({ secret: 'session' });

  const file = tmp();
  const result = await backup.writeDump(db, fs.createWriteStream(file));
  const zip = new AdmZip(file);
  const dbName = db.databaseName;

  const orders = readBson(zip.readFile(`${dbName}/orders.bson`));
  expect(orders).toHaveLength(2);
  // Raw BSON: types come back exactly (ObjectId, Decimal128, Date)
  expect(String(orders[0]._id)).toBe(String(id));
  expect(orders[0].total.toString()).toBe('12.50');
  expect(orders[0].at.toISOString()).toBe('2026-01-02T00:00:00.000Z');

  const metadata = BSON.EJSON.parse(zip.readAsText(`${dbName}/orders.metadata.json`));
  expect(metadata.indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['_id_', 'orderId_1']));

  expect(zip.getEntry(`${dbName}/whatsappsessions.bson`)).toBeNull();
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  expect(manifest.database).toBe(dbName);
  expect(manifest.collections.find((c) => c.name === 'orders').documents).toBe(2);
  expect(result.bytes).toBeGreaterThan(0);
  expect(zip.readAsText('README.txt')).toContain('mongorestore');
});

test('retention keeps 30 days and the first backup of each of the last 12 months', () => {
  const names = [
    'db-backups/exios-test-2026-10-02-0300.zip',
    'db-backups/exios-test-2026-09-05-0300.zip',
    'db-backups/exios-test-2026-08-20-0300.zip', // 43 days old, not first of August
    'db-backups/exios-test-2026-08-01-0300.zip', // first of August: kept
    'db-backups/exios-test-2025-08-01-0300.zip', // first of a month 14 months ago: deleted
    'other/not-a-backup.zip',
  ];
  expect(backup.expired(names, { keepDays: 30, now: new Date('2026-10-02T12:00:00Z') }).sort()).toEqual([
    'db-backups/exios-test-2025-08-01-0300.zip',
    'db-backups/exios-test-2026-08-20-0300.zip',
  ]);
});

test('a run uploads, records itself, and a second run at the same time is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exios-bucket-'));
  fs.mkdirSync(path.join(dir, 'db-backups'));
  const bucket = fakeBucket(dir);
  const first = backup.runBackup({ trigger: 'manual', bucket, checkPublic: false });
  await expect(backup.runBackup({ trigger: 'manual', bucket, checkPublic: false })).rejects.toMatchObject({ statusCode: 409 });
  const run = await first;
  expect(run.status).toBe('done');
  expect(fs.existsSync(path.join(dir, run.file))).toBe(true);
  // The lock is released: the next run works
  expect((await backup.runBackup({ trigger: 'manual', bucket, checkPublic: false })).status).toBe('done');
});

test('the public uploads bucket is refused', async () => {
  const before = { BACKUP_BUCKET: process.env.BACKUP_BUCKET, GOOGLE_BUCKET_ID: process.env.GOOGLE_BUCKET_ID };
  process.env.BACKUP_BUCKET = 'uploads';
  process.env.GOOGLE_BUCKET_ID = 'uploads';
  await expect(backup.runBackup()).rejects.toMatchObject({ statusCode: 400 });
  Object.assign(process.env, before);
});

test('the database is read in full before the upload starts; the server copy is removed; a cut-off run is closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exios-bucket-'));
  const bucket = fakeBucket(dir);
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`exios-backup-${process.pid}-`));
  // A run left 'running' by a restart
  const stale = await backup.BackupRun.create({ day: '2026-11-04', trigger: 'daily', status: 'running', startedAt: new Date() });
  // The upload only begins once the dump is complete on disk (the snapshot is no longer read)
  let completeAtUpload = false;
  const file = bucket.file;
  bucket.file = (name) => ({ ...file(name), createWriteStream: () => {
    const temp = leftovers().map((n) => path.join(os.tmpdir(), n))[0];
    completeAtUpload = !!temp && new AdmZip(temp).getEntry('README.txt') !== null;
    return file(name).createWriteStream();
  } });
  const run = await backup.runBackup({ trigger: 'manual', bucket, checkPublic: false });
  expect(run.status).toBe('done');
  expect(completeAtUpload).toBe(true);
  expect(new AdmZip(path.join(dir, run.file)).getEntry('manifest.json')).not.toBeNull();
  expect(leftovers()).toEqual([]);
  expect(await backup.BackupRun.findById(stale._id).lean()).toMatchObject({ status: 'failed' });
});

test('opening the page closes a run cut off by a restart, but never a run in progress', async () => {
  const locks = mongoose.connection.db.collection('systembackuplocks');
  const stale = await backup.BackupRun.create({ day: '2026-11-04', trigger: 'manual', status: 'running', startedAt: new Date() });
  // A run in progress holds the lock: left alone
  await locks.updateOne({ _id: 'backup' }, { $set: { until: new Date(Date.now() + 60000) } }, { upsert: true });
  await backup.overview();
  expect((await backup.BackupRun.findById(stale._id).lean()).status).toBe('running');
  // Nobody holds the lock: it was cut off
  await locks.updateOne({ _id: 'backup' }, { $set: { until: new Date(0) } });
  const { runs } = await backup.overview();
  expect((await backup.BackupRun.findById(stale._id).lean()).status).toBe('failed');
  expect(runs.some((r) => r.status === 'running')).toBe(false);
});
