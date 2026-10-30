// Daily backup of the whole database to a private Google Cloud Storage bucket (owner's request,
// 2026-10-02). The server runs on Heroku without mongodump and with little memory, so the backup
// is streamed: every collection is read as raw BSON and written straight into a zip that uploads
// while it is being made.
//
// The zip is a standard mongodump folder (<database>/<collection>.bson + .metadata.json), so
// `mongorestore` can load it into a new Atlas cluster or a local MongoDB (see README.txt inside).
//
//   BACKUP_BUCKET     the private bucket (required; never the public uploads bucket)
//   BACKUP_HOUR       Libya hour from which the daily backup runs (default 3)
//   BACKUP_KEEP_DAYS  daily backups kept (default 30); the first backup of each month is kept 12 months
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const archiver = require('archiver');
const { Readable } = require('stream');
const { TZ, today } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');

const PREFIX = 'db-backups/';
const NAME = /^db-backups\/exios-([\w.-]+)-(\d{4}-\d{2}-\d{2})-(\d{4})\.zip$/;
const LOCK_MINUTES = 120;
const MAX_DAILY_ATTEMPTS = 3;
// The WhatsApp session logs in as the company number: it is not put in a downloadable file
const SKIPPED = (name) => name.startsWith('system.') || /^whatsapp/i.test(name);

const runSchema = new mongoose.Schema({
  day: String,
  trigger: { type: String, enum: ['daily', 'manual'] },
  by: mongoose.Schema.Types.ObjectId,
  status: { type: String, enum: ['running', 'done', 'failed'] },
  file: String,
  bytes: Number,
  collections: Number,
  documents: Number,
  deleted: [String],
  error: String,
  startedAt: Date,
  finishedAt: Date,
}, { collection: 'systembackupruns' });
const BackupRun = mongoose.models.SystemBackupRun || mongoose.model('SystemBackupRun', runSchema);

const settings = () => ({
  bucketName: process.env.BACKUP_BUCKET || '',
  hour: Number(process.env.BACKUP_HOUR || 3),
  keepDays: Number(process.env.BACKUP_KEEP_DAYS || 30),
});

function defaultBucket() {
  const { bucketName } = settings();
  if (!bucketName) throw new ErrorHandler(400, 'لم يُضبط BACKUP_BUCKET على الخادم');
  // Customer uploads in that bucket have public links: a database copy must never go there
  if (bucketName === process.env.GOOGLE_BUCKET_ID) throw new ErrorHandler(400, 'BACKUP_BUCKET هو نفس مخزن رفع الملفات العام. أنشئ مخزناً خاصاً للنسخ الاحتياطي.');
  return require('../../utils/googleClould').storage.bucket(bucketName);
}

// Writes the database into `output` as a zip; resolves with what was written
async function writeDump(db, output) {
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('close', () => { if (!output.writableFinished) reject(new Error('Backup output closed before completion')); });
    output.on('error', reject);
    zip.on('error', reject);
    zip.on('warning', reject);
  });
  // The stream may fail while the next BSON entry is being prepared.
  done.catch(() => {});
  zip.pipe(output);
  // One entry at a time: the next starts once the previous is fully written
  const add = (source, name) => {
    const written = new Promise((resolve) => zip.once('entry', resolve));
    zip.append(source, { name });
    return Promise.race([written, done]);
  };
  const dbName = db.databaseName;
  const all = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => c.type !== 'view' && !SKIPPED(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifest = { database: dbName, createdAt: new Date().toISOString(), skipped: 'system.*, whatsapp*', collections: [] };
  // One snapshot for every collection: a payment committed while the dump is streaming
  // must not appear in the journal without its corresponding wallet/order documents.
  const session = db.client.startSession({ snapshot: true });
  try {
    for (const info of all) {
      const collection = db.collection(info.name);
      let count = 0;
      // Raw BSON as stored: nothing is decoded and re-encoded, so every value comes back exactly
      const cursor = collection.find({}, { raw: true, batchSize: 500, session });
      async function* documents() {
        for await (const doc of cursor) {
          count += 1;
          yield doc;
        }
      }
      await add(Readable.from(documents()), `${dbName}/${info.name}.bson`);
      const indexes = await collection.indexes();
      const metadata = { indexes, uuid: '', collectionName: info.name, type: 'collection', options: info.options || {} };
      await add(mongoose.mongo.BSON.EJSON.stringify(metadata, { relaxed: false }), `${dbName}/${info.name}.metadata.json`);
      manifest.collections.push({ name: info.name, documents: count });
    }
    manifest.documents = manifest.collections.reduce((sum, c) => sum + c.documents, 0);
    await add(JSON.stringify(manifest, null, 2), 'manifest.json');
    await add(readme(dbName), 'README.txt');
    await zip.finalize();
    await done;
    return { ...manifest, bytes: zip.pointer() };
  } catch (error) {
    zip.destroy();
    output.destroy();
    throw error;
  } finally {
    await session.endSession();
  }
}

const readme = (dbName) => `Exios database backup (${dbName})
=====================================

Extract this zip, then load it with the MongoDB Database Tools (mongorestore).

Into a NEW Atlas cluster (if the old one is lost):
  mongorestore --uri="mongodb+srv://USER:PASSWORD@NEW-CLUSTER/" --dir="<extracted folder>" --nsInclude="${dbName}.*"
  Then point MONGO_URL_2 on the server to the new cluster.

Into a local MongoDB, to look at it or test:
  mongorestore --uri="mongodb://127.0.0.1:27017/" --dir="<extracted folder>" --nsFrom="${dbName}.*" --nsTo="exios-restore-test.*" --drop
  or, from Exios-Api: npm run db:restore-local -- "<this zip>"

Not included: the WhatsApp session (scan the QR code again after a restore).
This file holds customer data and password hashes: keep it private.

---------------------------------------------------------------
نسخة احتياطية لقاعدة بيانات إكسيوس. فك الضغط ثم استعمل mongorestore كما في الأوامر أعلاه.
بعد الاسترجاع إلى Atlas جديد: غيّر MONGO_URL_2 على الخادم إلى الرابط الجديد، وامسح رمز واتساب من جديد.
الملف فيه بيانات العملاء: لا تشاركه.
`;

const fileName = (dbName, at = new Date()) => `${PREFIX}exios-${dbName}-${moment(at).tz(TZ).format('YYYY-MM-DD-HHmm')}.zip`;

// Which backups to delete: older than keepDays, except the first one of each of the last 12 months
function expired(names, { keepDays, now = new Date() }) {
  const day = moment(now).tz(TZ).format('YYYY-MM-DD');
  const cutoff = moment.tz(day, TZ).subtract(keepDays, 'days').format('YYYY-MM-DD');
  const monthCutoff = moment.tz(day, TZ).subtract(12, 'months').format('YYYY-MM');
  const parsed = names.map((name) => ({ name, match: name.match(NAME) })).filter((x) => x.match)
    .map(({ name, match }) => ({ name, day: match[2], stamp: `${match[2]}-${match[3]}` }))
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
  const firstOfMonth = new Set();
  const seen = new Set();
  for (const file of parsed) {
    const month = file.day.slice(0, 7);
    if (!seen.has(month)) { seen.add(month); firstOfMonth.add(file.name); }
  }
  return parsed.filter((file) => file.day < cutoff && !(firstOfMonth.has(file.name) && file.day.slice(0, 7) > monthCutoff)).map((file) => file.name);
}

// Only one backup at a time, across every server instance
async function takeLock() {
  const now = new Date();
  try {
    await mongoose.connection.db.collection('systembackuplocks').updateOne(
      { _id: 'backup', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
      { $set: { until: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}
const releaseLock = () => mongoose.connection.db.collection('systembackuplocks').updateOne({ _id: 'backup' }, { $set: { until: new Date(0) } });

async function runBackup({ trigger = 'manual', by, bucket = defaultBucket(), checkPublic = true } = {}) {
  if (!(await takeLock())) throw new ErrorHandler(409, 'نسخة احتياطية أخرى قيد التنفيذ الآن');
  const run = await BackupRun.create({ day: today(), trigger, by, status: 'running', startedAt: new Date() });
  try {
    const db = mongoose.connection.db;
    const name = fileName(db.databaseName);
    const file = bucket.file(name);
    const result = await writeDump(db, file.createWriteStream({
      resumable: true,
      contentType: 'application/zip',
      metadata: { cacheControl: 'private, no-store' },
    }));
    // Refuse a bucket anyone can read: the file would be open to the internet
    if (checkPublic) {
      const response = await fetch(`https://storage.googleapis.com/${bucket.name}/${name}`, { method: 'HEAD' }).catch(() => null);
      if (response?.ok) {
        await file.delete({ ignoreNotFound: true });
        throw new Error(`المخزن ${bucket.name} عام (يُقرأ بلا تسجيل دخول)، فحُذفت النسخة. اجعله خاصاً ثم أعد المحاولة.`);
      }
    }
    const [files] = await bucket.getFiles({ prefix: PREFIX });
    const toDelete = expired(files.map((f) => f.name), { keepDays: settings().keepDays });
    for (const old of toDelete) await bucket.file(old).delete({ ignoreNotFound: true });
    Object.assign(run, { status: 'done', file: name, bytes: result.bytes, collections: result.collections.length, documents: result.documents, deleted: toDelete, finishedAt: new Date() });
    await run.save();
    return run.toObject();
  } catch (error) {
    Object.assign(run, { status: 'failed', error: error.message, finishedAt: new Date() });
    await run.save();
    throw error;
  } finally {
    await releaseLock().catch(() => {});
  }
}

// Checked every hour: from BACKUP_HOUR (Libya time) one daily backup, retried up to 3 times
let timer = null;
function startDailyBackup() {
  if (timer || !settings().bucketName) return;
  const tick = async () => {
    try {
      if (moment().tz(TZ).hour() < settings().hour) return;
      const day = today();
      if (await BackupRun.exists({ day, status: 'done' })) return;
      if ((await BackupRun.countDocuments({ day, trigger: 'daily', status: 'failed' })) >= MAX_DAILY_ATTEMPTS) return;
      const run = await runBackup({ trigger: 'daily' });
      console.log(`[backup] ${run.file} (${(run.bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (error) {
      if (error.statusCode !== 409) console.error('[backup] daily backup failed:', error.message);
    }
  };
  timer = setInterval(tick, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 60 * 1000).unref?.();
}

// The backups in the bucket and the latest runs, for the owner's page
async function overview() {
  const { bucketName, hour, keepDays } = settings();
  const runs = await BackupRun.find().sort({ startedAt: -1 }).limit(20).lean();
  if (!bucketName) return { configured: false, hour, keepDays, files: [], runs };
  let files = [];
  let error = null;
  try {
    const [list] = await defaultBucket().getFiles({ prefix: PREFIX });
    files = list.filter((f) => NAME.test(f.name))
      .map((f) => ({ name: f.name, bytes: Number(f.metadata.size), createdAt: f.metadata.timeCreated }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) {
    error = e.message;
  }
  return { configured: true, bucket: bucketName, hour, keepDays, files, runs, error };
}

// A link valid 15 minutes, made for the owner who asked
async function downloadUrl(name) {
  if (!NAME.test(String(name))) throw new ErrorHandler(400, 'اسم ملف غير صالح');
  const [url] = await defaultBucket().file(name).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 15 * 60 * 1000,
    responseDisposition: `attachment; filename="${name.slice(PREFIX.length)}"`,
  });
  return url;
}

// Started from the page: answers at once (Heroku cuts requests after 30 s), the page polls the runs
async function startManual(user) {
  const run = runBackup({ trigger: 'manual', by: user?._id });
  const early = await Promise.race([run.then(() => null, (error) => error), new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
  if (early?.statusCode) throw early;
  run.catch((error) => console.error('[backup] manual backup failed:', error.message));
  return { started: true };
}

module.exports = { writeDump, runBackup, startDailyBackup, overview, downloadUrl, startManual, expired, fileName, BackupRun };
