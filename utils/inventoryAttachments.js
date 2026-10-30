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
async function putFile(file, user, visibility) {
  if (!file.buffer || file.buffer.length > MAX_SIZE) throw new ErrorHandler(400, 'Each file must be 25 MB or smaller.');
  const upload = bucket().openUploadStream(randomUUID(), { metadata: { purpose: 'inventory-attachment', uploadedBy: String(user._id) } });
  try { await pipeline(Readable.from([file.buffer]), upload); }
  catch (error) { await bucket().delete(upload.id).catch(() => {}); throw error; }
  return { _id: new mongoose.Types.ObjectId(), filename: randomUUID(), originalName: file.originalname || 'Attachment',
    bytes: String(file.buffer.length), fileType: file.mimetype || 'application/octet-stream', visibility,
    storageKind: 'gridfs', storageId: upload.id, uploadedBy: user._id };
}
async function discard(files) {
  await Promise.all(files.filter(file => file.storageKind === 'gridfs' && file.storageId).map(file => bucket().delete(file.storageId).catch(() => {})));
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
function legacyObject(path) {
  const prefix = `https://storage.googleapis.com/${process.env.GOOGLE_BUCKET_ID}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.length <= prefix.length) throw new ErrorHandler(409, 'This older file has an unsupported storage URL. Please upload it again before restricting access.');
  return require('./googleClould').storage.bucket(process.env.GOOGLE_BUCKET_ID).file(decodeURIComponent(path.substring(prefix.length)));
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

// Move an old public object before restricting it. Keep staff access until removal of
// the original public object succeeds. A failed cleanup can safely be retried.
async function privatizeLegacy(inventoryId, attachmentId, user) {
  let inventory = await loadInventory(inventoryId);
  let file = findFile(inventory, attachmentId);
  if (file.storageKind !== 'gridfs') {
    const object = legacyObject(file.path);
    const [metadata] = await object.getMetadata();
    if (Number(metadata.size) > MAX_SIZE) throw new ErrorHandler(409, 'This older file exceeds 25 MB. Upload a smaller private copy before restricting it.');
    const [buffer] = await object.download();
    const uploaded = await putFile({ buffer, originalname: describe(file).originalName, mimetype: file.fileType }, user, file.visibility || 'staff');
    const result = await Inventory.updateOne({ _id: inventoryId, attachments: { $elemMatch: { _id: file._id, storageId: { $exists: false } } } }, {
      $set: { 'attachments.$.storageId': uploaded.storageId, 'attachments.$.storageKind': 'gridfs', 'attachments.$.legacyStoragePath': file.path, 'attachments.$.originalName': uploaded.originalName },
      $unset: { 'attachments.$.path': 1 },
    });
    if (result.modifiedCount !== 1) await discard([uploaded]);
    inventory = await loadInventory(inventoryId);
    file = findFile(inventory, attachmentId);
  }
  if (file.legacyStoragePath) {
    try { await legacyObject(file.legacyStoragePath).delete({ ignoreNotFound: true }); }
    catch (_) { throw new ErrorHandler(409, 'The private copy is saved, but the old public link could not be removed. File access is unchanged. Retry to finish restricting access.'); }
    await Inventory.updateOne({ _id: inventoryId, 'attachments._id': file._id }, { $unset: { 'attachments.$.legacyStoragePath': 1 } });
  }
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
    let inventory = await loadInventory(req.params.id);
    let file = findFile(inventory, req.params.attachmentId);
    if (req.body.visibility === 'management' && (file.storageKind !== 'gridfs' || file.legacyStoragePath)) await privatizeLegacy(inventory._id, file._id, req.user);
    const updated = await runInTransaction(async session => {
      inventory = await Inventory.findById(req.params.id).session(session);
      if (!inventory) throw new ErrorHandler(404, 'Inventory not found.');
      file = findFile(inventory, req.params.attachmentId);
      if (req.body.visibility === 'management' && (file.storageKind !== 'gridfs' || file.legacyStoragePath)) throw new ErrorHandler(409, 'Private storage migration is not complete. Please retry.');
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
Object.assign(exports, { serialize, describe, canManage, canAccess, requestedAccess, storeUploads, discard, MAX_SIZE });
