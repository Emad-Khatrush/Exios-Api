// node scripts/backfillImageVariants.js [--apply] [--limit N]
//
// Makes the light copies (utils/imageVariants: a thumbnail and a preview) of the order photos stored
// before uploads made them (owner, 2026-11-25: the shipment photos loaded slowly in the app). Package
// photos (paymentList.images) and the order's own files (images) are both done, newest orders first.
//
// Without --apply it only counts the photos (it reads and writes nothing). An image that already has
// its copies is skipped, so it is safe to run again and to run in parts with --limit (N = photos).
// A file that is not a readable image (a PDF, a HEIC) gets none and is tried again on the next run.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const Orders = require('../models/order');
const { isImage, makeVariants } = require('../utils/imageVariants');

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;

// A stored file that still needs its copies: an image by its type or name, with a path and no thumb
const needs = (img) => img && img.path && !img.thumb && isImage(img.fileType, img.path.split('?')[0]);
const missing = { $elemMatch: { path: { $exists: true }, thumb: { $exists: false } } };
const filter = { $or: [{ images: missing }, { 'paymentList.images': missing }] };

async function main() {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  console.log(`Database: ${mongoose.connection.db.databaseName}`);

  let total = 0;
  for await (const order of Orders.find(filter).select('images paymentList._id paymentList.images').lean().cursor()) {
    total += (order.images || []).filter(needs).length;
    (order.paymentList || []).forEach((p) => { total += (p.images || []).filter(needs).length; });
  }
  console.log(`Photos without light copies: ${total}${Number.isFinite(limit) ? ` (this run: ${Math.min(total, limit)})` : ''}`);
  if (!apply) {
    console.log('Dry run: nothing read or written. Add --apply to make the copies.');
    await mongoose.disconnect();
    return;
  }

  const { storage, saveToGoogleCloud } = require('../utils/googleClould');
  const bucket = storage.bucket(process.env.GOOGLE_BUCKET_ID);
  const prefix = `https://storage.googleapis.com/${bucket.name}/`;
  // The stored file's bytes, from its public URL in our bucket (names may be saved raw or encoded)
  const download = async (url) => {
    if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
    const raw = url.substring(prefix.length).split('?')[0];
    for (const name of [raw, (() => { try { return decodeURIComponent(raw); } catch (e) { return raw; } })()]) {
      const file = bucket.file(name);
      if ((await file.exists())[0]) return (await file.download())[0];
    }
    return null;
  };

  const totals = { done: 0, unreadable: 0, missing: 0, failed: 0 };
  let n = 0;
  // Makes and stores the copies of one photo; { thumb, preview } or null
  const copiesOf = async (img) => {
    const buffer = await download(img.path);
    if (!buffer) { totals.missing += 1; return null; }
    const variants = await makeVariants(buffer);
    if (!variants) { totals.unreadable += 1; return null; }
    const base = decodeURIComponent(img.path.split('?')[0].split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '').slice(0, 80);
    const out = {};
    for (const [key, buf] of Object.entries(variants)) {
      out[key] = (await saveToGoogleCloud({ buffer: buf, originalname: `${base}-${key}.webp`, mimetype: 'image/webp' }, `exios-admin-invoices/${key}`)).publicUrl;
    }
    return out;
  };

  const cursor = Orders.find(filter).sort({ createdAt: -1 }).select('images paymentList._id paymentList.images').lean().cursor();
  for await (const order of cursor) {
    const jobs = [
      ...(order.images || []).filter(needs).map((img) => ({ img, set: (k) => `images.$[i].${k}`, filters: [{ 'i._id': img._id }] })),
      ...(order.paymentList || []).flatMap((p) => (p.images || []).filter(needs)
        .map((img) => ({ img, set: (k) => `paymentList.$[p].images.$[i].${k}`, filters: [{ 'p._id': p._id }, { 'i._id': img._id }] }))),
    ];
    for (const job of jobs) {
      if (n >= limit) break;
      n += 1;
      try {
        const copies = await copiesOf(job.img);
        if (copies) {
          await Orders.updateOne({ _id: order._id }, { $set: { [job.set('thumb')]: copies.thumb, [job.set('preview')]: copies.preview } }, { arrayFilters: job.filters });
          totals.done += 1;
        }
      } catch (error) {
        totals.failed += 1;
        console.log(`${order._id} ${job.img.path}: ${error.message}`);
      }
      if (n % 50 === 0) console.log(`${n}/${Math.min(total, limit)}`, JSON.stringify(totals));
    }
    if (n >= limit) break;
  }
  console.log(`Done ${n}:`, JSON.stringify(totals));
  console.log('done = copies made; unreadable = not an image sharp reads (e.g. HEIC); missing = file not found in the bucket');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
