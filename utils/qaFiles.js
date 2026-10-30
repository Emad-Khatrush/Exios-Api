// QA uploads stay in its dedicated MongoDB cluster, never in the live cloud bucket.
const mongoose = require('mongoose');
const express = require('express');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { isQa } = require('./qaEnvironment');

const router = express.Router();
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'qaAttachments' });
const digest = token => createHash('sha256').update(token).digest();
function baseUrl() {
  const url = new URL(process.env.QA_PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://exios-system.onrender.com');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid QA file origin.');
  return url.origin;
}
function contentType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
async function upload(file, folderName) {
  if (!isQa) throw new Error('QA storage is only available in QA.');
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > 25 * 1024 * 1024) throw new Error('Invalid file, or file exceeds 25 MB.');
  const origin = baseUrl();
  const token = randomBytes(32).toString('base64url');
  const filename = randomUUID();
  const stream = bucket().openUploadStream(filename, { metadata: {
    tokenHash: digest(token).toString('hex'), contentType: contentType(file.buffer),
    originalName: String(file.originalname || 'Attachment').replace(/[\r\n\\/]/g, '_').slice(0, 200),
    folder: String(folderName || '').slice(0, 200), purpose: 'qa-upload',
  } });
  try { await pipeline(Readable.from([file.buffer]), stream); }
  catch (error) { await bucket().delete(stream.id).catch(() => {}); throw error; }
  return { publicUrl: `${origin}/api/qa-files/${stream.id}/${token}`, filename,
    folder: '/' + folderName, bytes: String(file.buffer.length) };
}
async function findAuthorized(id, token) {
  if (!isQa || !/^[a-f\d]{24}$/i.test(id || '') || !/^[\w-]{43}$/.test(token || '')) return null;
  const [file] = await bucket().find({ _id: new mongoose.Types.ObjectId(id) }).limit(1).toArray();
  const expected = file?.metadata?.tokenHash;
  if (!/^[a-f\d]{64}$/i.test(expected || '')) return null;
  return timingSafeEqual(Buffer.from(expected, 'hex'), digest(token)) ? file : null;
}
router.get('/:id/:token', async (req, res, next) => {
  try {
    const file = await findAuthorized(req.params.id, req.params.token);
    if (!file) return res.sendStatus(404);
    const type = file.metadata.contentType || 'application/octet-stream';
    res.set({ 'Content-Type': type, 'Content-Length': String(file.length),
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.metadata.originalName || 'Attachment')}` });
    await pipeline(bucket().openDownloadStream(file._id), res);
  } catch (error) { if (res.headersSent) res.destroy(error); else next(error); }
});
async function remove(publicUrl) {
  if (!isQa) throw new Error('QA storage is only available in QA.');
  let url;
  try { url = new URL(publicUrl); } catch (_) { return; }
  if (url.origin !== baseUrl()) return;
  const match = /^\/api\/qa-files\/([a-f\d]{24})\/([\w-]{43})$/i.exec(url.pathname);
  if (!match) return;
  const file = await findAuthorized(match[1], match[2]);
  if (file) await bucket().delete(file._id);
}
module.exports = { router, upload, remove };
