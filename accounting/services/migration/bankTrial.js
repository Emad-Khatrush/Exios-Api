// Bank trials are opt-in, QA-only, and keep a transactional undo log of actual writes.
// Scope is carried across Express and transaction callbacks; ordinary requests are untouched.
const mongoose = require('mongoose');
const { AsyncLocalStorage } = require('node:async_hooks');
const { BSON } = require('mongodb');
const ErrorHandler = require('../../../utils/errorHandler');
const scope = new AsyncLocalStorage();
const LOG = 'accounting_bank_trial_undo';
const fail = message => new ErrorHandler(400, message);
const pack = value => value == null ? null : Buffer.from(BSON.serialize(value));
const unpack = value => value == null ? null : BSON.deserialize(Buffer.isBuffer(value) ? value : Buffer.from(value.buffer));
const keyOf = (name, id) => `${name}:${String(id)}`;

function ignoredCollections() {
  const m = require('../../models');
  return new Set([LOG, m.MigrationRun.collection.name, m.Counter.collection.name,
    m.AccountingSettings.collection.name, m.AuditLog?.collection.name].filter(Boolean));
}

// Capture at the Mongo collection boundary, including writes made by nested refund/payment
// services. Read/write and undo records share the same session and transaction.
const writes = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'bulkWrite'];
for (const method of writes) {
  const original = mongoose.Collection.prototype[method];
  mongoose.Collection.prototype[method] = function (...args) {
    const ctx = scope.getStore();
    if (!ctx?.changes || ignoredCollections().has(this.name)) return original.apply(this, args);
    return capture(this, method, args, original, ctx);
  };
}

async function capture(collection, method, args, original, ctx) {
  if (method === 'bulkWrite') throw fail('هذه العملية المجمعة غير مدعومة داخل تجربة الكشف؛ استخدم إجراء السطر المفرد.');
  const options = args[method.startsWith('insert') || method.startsWith('delete') || method === 'findOneAndDelete' ? 1 : 2] || {};
  if (options.session !== ctx.session) throw fail('تجربة الكشف تتطلب حفظ كل التغييرات داخل معاملتها.');
  const raw = collection.conn.db.collection(collection.name);
  const inserting = method === 'insertOne' || method === 'insertMany';
  const docs = inserting ? (method === 'insertOne' ? [args[0]] : args[0]) : [];
  if (inserting) for (const doc of docs) if (!doc._id) doc._id = new mongoose.Types.ObjectId();
  const query = inserting ? { _id: { $in: docs.map(doc => doc._id) } } : args[0];
  let before = await raw.find(query, { session: ctx.session }).limit(1001).toArray();
  if (before.length > 1000) throw fail('تجربة الكشف تتجاوز الحد الآمن للتعديل الجماعي.');
  if (['updateOne', 'deleteOne', 'replaceOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'].includes(method) && before.length > 1)
    throw fail('إجراء التجربة يحتاج تحديد مستند واحد بشكل فريد.');
  const beforeById = new Map(before.map(doc => [String(doc._id), doc]));
  const result = await original.apply(collection, args);
  const ids = [...before.map(doc => doc._id), ...docs.map(doc => doc._id)];
  const upsertId = result?.upsertedId || result?.lastErrorObject?.upserted;
  if (upsertId) ids.push(upsertId);
  // findOneAndUpdate returns the new document on current Mongoose versions.
  if (!ids.length && result?._id) ids.push(result._id);
  if (!ids.length && options.upsert) {
    const created = await raw.findOne(args[0], { session: ctx.session });
    if (created) ids.push(created._id);
  }
  const after = ids.length ? await raw.find({ _id: { $in: ids } }, { session: ctx.session }).toArray() : [];
  const afterById = new Map(after.map(doc => [String(doc._id), doc]));
  const statements = require('../../models/documents').BankStatementLine.collection.name;
  for (const id of ids) {
    const key = keyOf(collection.name, id);
    if (ctx.changes.has(key)) continue;
    let previous = beforeById.get(String(id)) || null;
    // Keep newly imported statement rows, restored to their initial state on discard.
    if (!previous && inserting && collection.name === statements) previous = afterById.get(String(id)) || null;
    ctx.changes.set(key, { collection: collection.name, documentId: id, before: pack(previous) });
  }
  return result;
}

function requestScope(req, res, next) { return scope.run({ bankRequest: true }, next); }
function context() { return scope.getStore(); }

async function transact(session, fn) {
  if (!context()?.bankRequest) return fn();
  const { MigrationRun } = require('../../models');
  const run = await MigrationRun.findOne({ status: { $in: ['running', 'review', 'committing', 'discarding'] } }).session(session).lean();
  if (!run?.bankTrialEnabled) return fn();
  if (process.env.EXIOS_QA !== '1') throw fail('تجربة الكشف متاحة على QA فقط.');
  if (run.status !== 'review') throw fail('انتظر انتهاء الترحيل أو الاعتماد أو الإلغاء قبل تجربة الكشف.');
  const locked = await MigrationRun.findOneAndUpdate({ _id: run._id, status: 'review', bankTrialEnabled: true },
    { $inc: { bankTrialVersion: 1 } }, { new: true, session }).lean();
  if (!locked) throw fail('تغيرت حالة التشغيل؛ حدّث الصفحة.');
  const ctx = { bankRequest: true, session, runId: run.runId, count: require('../config').countOf(run), changes: new Map() };
  return scope.run(ctx, async () => {
    const result = await fn();
    const records = [];
    for (const change of ctx.changes.values()) {
      const after = pack(await mongoose.connection.db.collection(change.collection).findOne({ _id: change.documentId }, { session }));
      if ((change.before == null && after == null) || (change.before && after && change.before.equals(after))) continue;
      if ((change.before?.length || 0) + (after?.length || 0) > 8 * 1024 * 1024) throw fail('مستند التجربة كبير جداً للحفظ الآمن.');
      records.push({ ...change, after, runId: run.runId, version: locked.bankTrialVersion });
    }
    if (records.length) await mongoose.connection.db.collection(LOG).insertMany(records, { session });
    return result;
  });
}

async function enable(runId, user) {
  if (process.env.EXIOS_QA !== '1') throw fail('تجربة الكشف متاحة على QA فقط.');
  await mongoose.connection.db.collection(LOG).createIndex({ runId: 1, version: -1, _id: -1 });
  const { runInTransaction } = require('../transaction');
  return runInTransaction(async session => {
    const { MigrationRun } = require('../../models');
    const run = await MigrationRun.findOneAndUpdate({ runId, status: 'review' },
      { $set: { bankTrialEnabled: true } }, { new: true, session });
    if (!run) throw fail('فعّل التجربة بعد انتهاء الترحيل وقبل اعتماده.');
    await require('../audit').logAudit({ action: 'migration.bankTrial.enable', model: 'AccountingMigrationRun', docId: run._id,
      req: { user }, after: { runId } }, session);
    return run;
  });
}

// Refuse to overwrite a document changed outside the trial. The entire discard rolls back
// on conflict, leaving the run in review and preserving both the log and all ledger entries.
async function rollback(runId, session) {
  const log = mongoose.connection.db.collection(LOG);
  const cursor = log.find({ runId }, { session }).sort({ version: -1, _id: -1 });
  let restored = 0;
  for await (const record of cursor) {
    const raw = mongoose.connection.db.collection(record.collection);
    const current = pack(await raw.findOne({ _id: record.documentId }, { session }));
    const expected = record.after == null ? null : Buffer.from(record.after.buffer);
    if ((current == null) !== (expected == null) || (current && !current.equals(expected)))
      throw fail(`تعذر إلغاء التجربة: تغير مستند خارجها (${record.collection} / ${record.documentId}). راجعه أولاً.`);
    const before = unpack(record.before);
    if (before) await raw.replaceOne({ _id: record.documentId }, before, { upsert: true, session });
    else await raw.deleteOne({ _id: record.documentId }, { session });
    restored++;
  }
  await log.deleteMany({ runId }, { session });
  return restored;
}

module.exports = { requestScope, context, transact, enable, rollback, LOG };
