// node scripts/moveInventoryFilesToGoogle.js [--apply]
//
// Moves the Inventory files kept in MongoDB (GridFS, inventoryAttachments.*) to the company's
// Google bucket, where new uploads now go (owner, 2026-11-06: they made every daily backup larger).
// Each file keeps its name, type and access («all staff» or «admin & accountant only»); only
// where its bytes live changes. Without --apply it only lists what it would move.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
//
// Safe to run again: a file already moved is skipped, and a file is removed from GridFS only
// after its Google copy is written and the trip points to it.
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const Inventory = require('../models/inventory');
const attachments = require('../utils/inventoryAttachments');

const apply = process.argv.includes('--apply');
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;
const mb = (bytes) => (Number(bytes || 0) / 1048576).toFixed(2);

async function readGridFile(id) {
  const chunks = [];
  for await (const chunk of attachments.gridBucket().openDownloadStream(id)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  console.log(`Database: ${mongoose.connection.db.databaseName}${apply ? '' : '  (dry run: add --apply to move)'}`);
  const trips = await Inventory.find({ 'attachments.storageKind': 'gridfs' }, { attachments: 1, voyage: 1 }).lean();
  const referenced = new Set();
  let moved = 0;
  let bytes = 0;
  for (const trip of trips) {
    for (const file of trip.attachments.filter((f) => f.storageKind === 'gridfs' && f.storageId)) {
      referenced.add(String(file.storageId));
      const label = `${trip.voyage || trip._id} / ${file.originalName || file.filename} (${mb(file.bytes)} MB, ${file.visibility || 'staff'})`;
      if (!apply) { console.log(`would move  ${label}`); moved += 1; bytes += Number(file.bytes || 0); continue; }
      const buffer = await readGridFile(file.storageId);
      const path = await attachments.putCloud(buffer, file.fileType);
      const result = await Inventory.updateOne(
        { _id: trip._id, attachments: { $elemMatch: { _id: file._id, storageKind: 'gridfs', storageId: file.storageId } } },
        { $set: { 'attachments.$.storageKind': 'google', 'attachments.$.path': path }, $unset: { 'attachments.$.storageId': 1 } },
      );
      if (result.modifiedCount !== 1) {
        // Changed meanwhile (deleted, or moved by another run): the new copy is not needed
        await attachments.discard([{ storageKind: 'google', path }]);
        console.log(`skipped     ${label} (changed while moving)`);
        continue;
      }
      await attachments.gridBucket().delete(file.storageId).catch((error) => console.log(`  GridFS copy left in place: ${error.message}`));
      console.log(`moved       ${label}`);
      moved += 1;
      bytes += buffer.length;
    }
  }
  // GridFS files no trip points to (an interrupted upload): listed, never deleted here
  const orphans = (await attachments.gridBucket().find({}).toArray()).filter((f) => !referenced.has(String(f._id)));
  if (!apply || orphans.length) {
    const stillUsed = new Set((await Inventory.find({ 'attachments.storageId': { $in: orphans.map((f) => f._id) } }, { 'attachments.storageId': 1 }).lean())
      .flatMap((t) => t.attachments.map((a) => String(a.storageId))));
    const unused = orphans.filter((f) => !stillUsed.has(String(f._id)));
    if (unused.length) console.log(`\nGridFS files no trip uses (not touched): ${unused.map((f) => `${f._id} ${mb(f.length)} MB`).join(', ')}`);
  }
  console.log(`\n${apply ? 'Moved' : 'Would move'} ${moved} file(s), ${mb(bytes)} MB.`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
