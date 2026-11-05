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
const { pipeline } = require('stream/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TZ, today } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');

const PREFIX = 'db-backups/';
const NAME = /^db-backups\/exios-([\w.-]+)-(\d{4}-\d{2}-\d{2})-(\d{4})\.zip$/;
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
  // 'snapshot' (one instant) or 'per-collection' (the snapshot expired, read again without it)
  consistency: String,
  // How long each step took (ms), to see where the time goes
  timing: { snapshotFailed: Boolean, snapshotMs: Number, dumpMs: Number, uploadMs: Number },
  // Where a run is (live) or was (when it ended): dump, upload or prune
  progress: { phase: String, uploadedBytes: Number, totalBytes: Number, at: Date },
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

// Writes the database into `output` as a zip; resolves with what was written.
// snapshot (default): every collection as of one instant. Without it each collection is read in
// full one after the other, as `mongodump` does by default.
async function writeDump(db, output, { snapshot = true } = {}) {
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
  const manifest = { database: dbName, createdAt: new Date().toISOString(), skipped: 'system.*, whatsapp*',
    consistency: snapshot ? 'snapshot' : 'per-collection', collections: [] };
  // One snapshot for every collection: a payment committed while the dump is streaming
  // must not appear in the journal without its corresponding wallet/order documents.
  const session = snapshot ? db.client.startSession({ snapshot: true }) : undefined;
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
    if (session) await session.endSession();
  }
}

// Atlas keeps a snapshot only a few minutes (less on shared plans); past that every read fails
const isSnapshotTooOld = (error) => error?.code === 239 || error?.codeName === 'SnapshotTooOld'
  || /older than the oldest available timestamp/i.test(error?.message || '');

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

// Only one backup at a time, across every server instance. The lock is short and kept alive by
// the run (a heartbeat): a run killed by a restart stops renewing it, so it frees itself within
// two minutes instead of two hours (2026-11-05: a run stayed «جارية» and the button disabled).
const LOCK_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
// A run still going after this is stopped and recorded as failed, never left hanging
const MAX_RUN_MS = () => Number(process.env.BACKUP_MAX_MINUTES || 20) * 60 * 1000;
const locks = () => mongoose.connection.db.collection('systembackuplocks');

async function takeLock(owner, ttlMs = LOCK_TTL_MS) {
  const now = new Date();
  try {
    await locks().updateOne(
      { _id: 'backup', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
      { $set: { until: new Date(now.getTime() + ttlMs), owner } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}
// Only the run that holds the lock renews or frees it
const renewLock = (owner, ttlMs = LOCK_TTL_MS) => locks().updateOne({ _id: 'backup', owner }, { $set: { until: new Date(Date.now() + ttlMs) } });
// A run still 'running' while nobody holds the lock was cut off (a server restart): it is closed
// as failed, else the page keeps «نسخة الآن» disabled forever (2026-11-04 09:45). A live run
// renews the lock every 30 seconds, so it is never touched.
async function closeCutOffRuns({ lockFree = true } = {}) {
  if (!lockFree) {
    const lock = await locks().findOne({ _id: 'backup' });
    if (lock?.until && lock.until > new Date()) return;
  }
  await BackupRun.updateMany({ status: 'running' }, { $set: { status: 'failed', error: 'انقطعت المحاولة (أُعيد تشغيل الخادم أثناءها)', finishedAt: new Date() } });
}

const releaseLock = (owner) => locks().updateOne({ _id: 'backup', owner }, { $set: { until: new Date(0) } });

// Dumps the database to the server's disk, then uploads it, then prunes old backups. The dump is
// written to disk first: streaming it straight to the bucket made the reads wait for the upload,
// and once the run passed Atlas's snapshot window (5 minutes) every read failed with "Read
// timestamp ... is older than the oldest available timestamp" (2026-11-04). Read alone, the
// database takes seconds.
// progress: { phase, uploadedBytes, totalBytes, timing } is filled as the run goes, so a failure or
// a stop says where it was, and the page shows it live (2026-11-05: a run hung 20 minutes and
// nothing said whether it was reading or uploading).
async function dumpAndUpload(bucket, { checkPublic, track, progress = {} }) {
  const db = mongoose.connection.db;
  const name = fileName(db.databaseName);
  const file = bucket.file(name);
  const temp = path.join(os.tmpdir(), `exios-backup-${process.pid}-${Date.now()}.zip`);
  let result;
  const timing = { snapshotFailed: false };
  progress.timing = timing;
  try {
    // A snapshot first; if Atlas has already dropped it, the same run reads again without one
    // (2026-11-05: the snapshot expired even with the upload separated)
    progress.phase = 'dump';
    let started = Date.now();
    try {
      result = await writeDump(db, track(fs.createWriteStream(temp, { flags: 'w' })));
    } catch (error) {
      if (!isSnapshotTooOld(error)) throw error;
      timing.snapshotFailed = true;
      timing.snapshotMs = Date.now() - started;
      started = Date.now();
      result = await writeDump(db, track(fs.createWriteStream(temp, { flags: 'w' })), { snapshot: false });
    }
    timing.dumpMs = Date.now() - started;
    progress.phase = 'upload';
    progress.totalBytes = result.bytes;
    progress.uploadedBytes = 0;
    started = Date.now();
    const source = track(fs.createReadStream(temp));
    source.on('data', (chunk) => { progress.uploadedBytes += chunk.length; });
    await pipeline(source, track(file.createWriteStream({
      resumable: true,
      contentType: 'application/zip',
      metadata: { cacheControl: 'private, no-store' },
    })));
    timing.uploadMs = Date.now() - started;
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
  progress.phase = 'prune';
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
  return { file: name, bytes: result.bytes, collections: result.collections.length, documents: result.documents, deleted: toDelete,
    consistency: result.consistency, timing };
}

// limits: { maxMs, heartbeatMs, lockTtlMs } for tests; the defaults are the ones above
async function runBackup({ trigger = 'manual', by, bucket = defaultBucket(), checkPublic = true, limits = {} } = {}) {
  const { maxMs = MAX_RUN_MS(), heartbeatMs = HEARTBEAT_MS, lockTtlMs = LOCK_TTL_MS } = limits;
  const owner = new mongoose.Types.ObjectId();
  if (!(await takeLock(owner, lockTtlMs))) throw new ErrorHandler(409, 'نسخة احتياطية أخرى قيد التنفيذ الآن');
  await closeCutOffRuns();
  const run = await BackupRun.create({ day: today(), trigger, by, status: 'running', startedAt: new Date() });
  const progress = {};
  const snapshotOf = () => ({ phase: progress.phase, uploadedBytes: progress.uploadedBytes, totalBytes: progress.totalBytes, at: new Date() });
  // The heartbeat keeps the lock and shows the page where the run is
  const heartbeat = setInterval(() => {
    renewLock(owner, lockTtlMs).catch(() => {});
    BackupRun.updateOne({ _id: run._id, status: 'running' }, { $set: { progress: snapshotOf(), timing: progress.timing } }).catch(() => {});
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();
  // Every stream of the run, destroyed when it is stopped (time limit or the owner's cancel) so
  // nothing keeps hanging
  const streams = new Set();
  const track = (stream) => { streams.add(stream); return stream; };
  let abort;
  const stopped = new Promise((resolve, reject) => {
    abort = (error) => { streams.forEach((stream) => stream.destroy(error)); reject(error); };
  });
  stopped.catch(() => {});
  const timer = setTimeout(() => abort(new Error(`تجاوزت النسخة ${Math.round(maxMs / 60000) || 1} دقيقة فأُلغيت. أعد المحاولة؛ إن تكرر فراجع اتصال الخادم بمخزن Google.`)), maxMs);
  active = { runId: run._id, abort };
  // The work keeps a handler of its own: if it is stopped, its later failure is not unhandled
  const work = dumpAndUpload(bucket, { checkPublic, track, progress });
  work.catch(() => {});
  try {
    const done = await Promise.race([stopped, work]);
    Object.assign(run, { status: 'done', ...done, progress: snapshotOf(), finishedAt: new Date() });
    await run.save();
    return run.toObject();
  } catch (error) {
    // Where it was when it failed, in the message the page shows
    const mb = (b) => (Number(b || 0) / 1048576).toFixed(1);
    const where = progress.phase === 'dump' ? 'أثناء قراءة قاعدة البيانات'
      : progress.phase === 'upload' ? `أثناء الرفع إلى مخزن Google (رُفع ${mb(progress.uploadedBytes)} من ${mb(progress.totalBytes)} MB؛ انتهت القراءة في ${Math.round((progress.timing?.dumpMs || 0) / 1000)} ث)`
        : progress.phase === 'prune' ? 'بعد الرفع، أثناء فحص المخزن وحذف النسخ القديمة' : '';
    Object.assign(run, { status: 'failed', error: where ? `${error.message} — ${where}` : error.message, progress: snapshotOf(), timing: progress.timing, finishedAt: new Date() });
    await run.save();
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (active?.runId === run._id) active = null;
    await releaseLock(owner).catch(() => {});
  }
}

// The run going on in this server, so the owner can stop it
let active = null;

// The owner's «إلغاء النسخة الجارية»: stops the run going on here, and closes any run left
// 'running' elsewhere (a restart, or a lock from before the heartbeat). A backup only reads the
// database, so stopping one never touches its data; the owner can start a new one at once.
async function cancelRunning(user) {
  const who = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  const reason = `أُلغيت يدوياً${who ? ` (${who})` : ''}`;
  if (active) {
    const { runId, abort } = active;
    abort(new Error(reason));
    // The run records itself as failed and frees its lock
    for (let i = 0; i < 50 && active?.runId === runId; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await locks().updateOne({ _id: 'backup' }, { $set: { until: new Date(0) }, $unset: { owner: '' } });
  const closed = await BackupRun.updateMany({ status: 'running' }, { $set: { status: 'failed', error: reason, finishedAt: new Date() } });
  return { cancelled: true, closed: closed.modifiedCount };
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
  await closeCutOffRuns({ lockFree: false });
  const runs =await BackupRun.find().sort({ startedAt: -1 }).limit(20).lean();
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

module.exports = { writeDump, runBackup, cancelRunning, startDailyBackup, overview, downloadUrl, startManual, expired, fileName, BackupRun };
