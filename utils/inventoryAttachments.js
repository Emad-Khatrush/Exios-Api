const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const Inventory = require('../models/inventory');
const Activities = require('../models/activities');
const ErrorHandler = require('./errorHandler');
const { runInTransaction } = require('../accounting/services/transaction');

const MAX_SIZE = 25 * 1024 * 1024;
const canManage = user => !!(user?.roles?.isAdmin || user?.roles?.isAccountant);
const canAccess = (file, user) => (file.visibility || 'staff') === 'staff' || canManage(user);
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'inventoryAttachments' });

function describe(file) {
  const item = file.toObject ? file.toObject() : file;
  let legacyName;
  if (item.path || item.legacyStoragePath) {
    try { legacyName = decodeURIComponent(new URL(item.path || item.legacyStoragePath).pathname.split('/').pop()).substring(10); } catch (_) {}
  }
  return { _id: item._id, filename: item.filename, originalName: item.originalName || legacyName || item.filename || 'Attachment',
    fileType: item.fileType || 'application/octet-stream', bytes: item.bytes, description: item.description,
    visibility: item.visibility || 'staff' };
}
function serialize(inventory, user) {
  if (!inventory) return inventory;
  const data = inventory.toObject ? inventory.toObject() : { ...inventory };
  data.attachments = (data.attachments || []).filter(file => canAccess(file, user)).map(describe);
  return data;
}
function requestedAccess(req) {
  let values;
  try { values = req.body.attachmentVisibilities ? JSON.parse(req.body.attachmentVisibilities) : (req.files || []).map(() => 'staff'); }
  catch (_) { throw new ErrorHandler(400, 'Invalid file visibility settings.'); }
  if (!Array.isArray(values) || values.length !== (req.files || []).length || values.some(value => !['staff', 'management'].includes(value))) throw new ErrorHandler(400, 'Choose a valid visibility for each file.');
  if (!canManage(req.user) && values.includes('management')) throw new ErrorHandler(403, 'Only admins and accountants can set restricted file access.');
  return values;
}
// Files go to the company's Google bucket like every other upload (owner, 2026-11-06), under a
// random name that is never sent to the browser: every download passes through `content`, which
// checks the viewer's role, so an «admin & accountant only» file stays hidden from other staff.
// Before that they were kept in MongoDB (GridFS), so every daily backup carried them again.
// QA never writes to the live bucket, so there they stay in QA's own database.
const OBJECT_PREFIX = 'inventory-files/';
let cloudBucketOverride = null;
const cloudBucket = () => cloudBucketOverride || require('./googleClould').storage.bucket(process.env.GOOGLE_BUCKET_ID);
const useGoogle = () => !!cloudBucketOverride || !require('./qaEnvironment').isQa;

async function putCloud(buffer, contentType) {
  const b = cloudBucket();
  const name = OBJECT_PREFIX + randomUUID();
  const object = b.file(name);
  try {
    await pipeline(Readable.from([buffer]), object.createWriteStream({ resumable: false, contentType: contentType || 'application/octet-stream', metadata: { cacheControl: 'private, no-store' } }));
  } catch (error) { await object.delete({ ignoreNotFound: true }).catch(() => {}); throw error; }
  return `https://storage.googleapis.com/${b.name}/${name}`;
}
async function putFile(file, user, visibility) {
  if (!file.buffer || file.buffer.length > MAX_SIZE) throw new ErrorHandler(400, 'Each file must be 25 MB or smaller.');
  const base = { _id: new mongoose.Types.ObjectId(), filename: randomUUID(), originalName: file.originalname || 'Attachment',
    bytes: String(file.buffer.length), fileType: file.mimetype || 'application/octet-stream', visibility, uploadedBy: user._id };
  if (useGoogle()) return { ...base, storageKind: 'google', path: await putCloud(file.buffer, file.mimetype) };
  const upload = bucket().openUploadStream(randomUUID(), { metadata: { purpose: 'inventory-attachment', uploadedBy: String(user._id) } });
  try { await pipeline(Readable.from([file.buffer]), upload); }
  catch (error) { await bucket().delete(upload.id).catch(() => {}); throw error; }
  return { ...base, storageKind: 'gridfs', storageId: upload.id };
}
async function discard(files) {
  await Promise.all(files.map(file => {
    if (file.storageKind === 'gridfs' && file.storageId) return bucket().delete(file.storageId).catch(() => {});
    // Only objects this feature created; older shared uploads are left where they are
    if (file.storageKind === 'google' && file.path) return Promise.resolve().then(() => legacyObject(file.path).delete({ ignoreNotFound: true })).catch(() => {});
    return null;
  }));
}
async function storeUploads(req) {
  const visibilities = requestedAccess(req);
  const files = [];
  try {
    for (let index = 0; index < (req.files || []).length; index++) files.push(await putFile(req.files[index], req.user, visibilities[index]));
    return files;
  } catch (error) { await discard(files); throw error; }
}
function findFile(inventory, id) {
  const file = (inventory.attachments || []).find(item => String(item._id) === String(id) || item.filename === String(id));
  if (!file) throw new ErrorHandler(404, 'File not found.');
  return file;
}
// The Google object behind a stored link (new uploads and older shared ones)
function legacyObject(path) {
  const b = cloudBucket();
  const prefix = `https://storage.googleapis.com/${b.name}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.length <= prefix.length) throw new ErrorHandler(404, 'File content is unavailable.');
  return b.file(decodeURIComponent(path.substring(prefix.length)));
}
async function loadInventory(id) {
  if (!mongoose.isValidObjectId(id)) throw new ErrorHandler(400, 'Invalid inventory ID.');
  const inventory = await Inventory.findById(id);
  if (!inventory) throw new ErrorHandler(404, 'Inventory not found.');
  return inventory;
}
async function audit(inventoryId, file, user, from, to, session) {
  await Activities.create([{
    user: user._id,
    details: { path: `/inventory/${inventoryId}/edit`, status: to === 'deleted' ? 'deleted' : 'updated', type: 'inventory', actionId: String(inventoryId) },
    changedFields: [{ label: `Attachment: ${file.originalName || file.filename}`, changedFrom: from, changedTo: to }],
  }], { session });
}

exports.upload = async (req, res, next) => {
  let files = [];
  let saved = false;
  try {
    await loadInventory(req.body.id);
    if (!req.files?.length) throw new ErrorHandler(400, 'Choose at least one file.');
    files = await storeUploads(req);
    const inventory = await runInTransaction(async session => {
      const updated = await Inventory.findByIdAndUpdate(req.body.id, { $push: { attachments: { $each: files } } }, { new: true, session });
      if (!updated) throw new ErrorHandler(404, 'Inventory not found.');
      for (const file of files) await audit(updated._id, file, req.user, '', file.visibility, session);
      return updated;
    });
    saved = true;
    res.json(serialize(inventory, req.user));
  } catch (error) { if (!saved) await discard(files); next(error); }
};
exports.changeVisibility = async (req, res, next) => {
  try {
    if (!canManage(req.user)) throw new ErrorHandler(403, 'Only admins and accountants can change file visibility.');
    if (!['staff', 'management'].includes(req.body.visibility)) throw new ErrorHandler(400, 'Choose a valid file visibility.');
    // The server checks the role on every download, wherever the file is stored, so changing
    // access is only this field
    let inventory;
    let file;
    const updated = await runInTransaction(async session => {
      inventory = await Inventory.findById(req.params.id).session(session);
      if (!inventory) throw new ErrorHandler(404, 'Inventory not found.');
      file = findFile(inventory, req.params.attachmentId);
      const previous = file.visibility || 'staff';
      file.visibility = req.body.visibility;
      await inventory.save({ session });
      await audit(inventory._id, file, req.user, previous, req.body.visibility, session);
      return inventory;
    });
    res.json(serialize(updated, req.user));
  } catch (error) { next(error); }
};
exports.remove = async (req, res, next) => {
  try {
    if (!canManage(req.user)) throw new ErrorHandler(403, 'Only admins and accountants can remove inventory files.');
    let removed;
    await runInTransaction(async session => {
      const inventory = await Inventory.findById(req.body.id).session(session);
      if (!inventory) throw new ErrorHandler(404, 'Inventory not found.');
      const file = findFile(inventory, req.body.attachmentId || req.body.image?._id || req.body.image?.filename);
      removed = file.toObject();
      inventory.attachments.pull(file._id);
      await inventory.save({ session });
      await audit(inventory._id, file, req.user, file.visibility || 'staff', 'deleted', session);
    });
    await discard([removed]);
    res.json({ isSuccess: true });
  } catch (error) { next(error); }
};
exports.content = async (req, res, next) => {
  try {
    const inventory = await loadInventory(req.params.id);
    const file = findFile(inventory, req.params.attachmentId);
    if (!canAccess(file, req.user)) throw new ErrorHandler(403, 'This file is available to admins and accountants only.');
    const stream = file.storageKind === 'gridfs' ? bucket().openDownloadStream(file.storageId) : legacyObject(file.path).createReadStream();
    const filename = String(describe(file).originalName).replace(/[\r\n]/g, '');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    stream.on('error', error => { if (!res.headersSent) next(new ErrorHandler(404, 'File content is unavailable.')); else res.destroy(error); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) { next(error); }
};
// Tests replace the Google bucket with an in-memory one
const setCloudBucket = (b) => { cloudBucketOverride = b; };
Object.assign(exports, { serialize, describe, canManage, canAccess, requestedAccess, storeUploads, discard, putCloud, setCloudBucket, gridBucket: bucket, MAX_SIZE });
