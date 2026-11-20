// node scripts/backfillPassportNumbers.js [--apply] [--limit N]
//
// Reads the passport number from the stored photo of every customer who signed up before sign-up
// asked for it (owner, 2026-11-20), so a second account with the same passport is refused. See
// utils/passportBackfill.js for what is saved.
//
// Without --apply it only counts the accounts and estimates the Google Cloud Vision cost (it reads
// nothing and spends nothing). Each account is read once (numberTriedAt), so it is safe to run again
// and to run in parts with --limit (Vision: first 1,000 images a month free, then $1.50 per 1,000).
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const { candidatesFilter, backfill } = require('../utils/passportBackfill');

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;

async function main() {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  const count = await User.countDocuments(candidatesFilter);
  const toRead = Math.min(count, limit);
  console.log(`Database: ${mongoose.connection.db.databaseName}`);
  console.log(`Accounts with a passport photo and no number: ${count}${Number.isFinite(limit) ? ` (this run: ${toRead})` : ''}`);
  console.log(`Vision cost if over the free 1,000 this month: about $${(Math.max(toRead - 1000, 0) * 1.5 / 1000).toFixed(2)}`);
  if (!apply) {
    console.log('Dry run: nothing read. Add --apply to read the photos.');
    await mongoose.disconnect();
    return;
  }
  const { readFromImage } = require('../utils/passportNumber');
  const { storage } = require('../utils/googleClould');
  const bucket = storage.bucket(process.env.GOOGLE_BUCKET_ID);
  const prefix = `https://storage.googleapis.com/${bucket.name}/`;
  // The stored photo's bytes, from its public URL in our bucket
  const download = async (url) => {
    if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
    const raw = url.substring(prefix.length).split('?')[0];
    for (const name of [raw, (() => { try { return decodeURIComponent(raw); } catch (e) { return raw; } })()]) {
      const file = bucket.file(name);
      if ((await file.exists())[0]) return (await file.download())[0];
    }
    return null;
  };
  let n = 0;
  const { done, totals, conflicts } = await backfill({
    read: readFromImage, download, limit,
    onEach: (user, out) => { n += 1; if (n % 25 === 0 || out.outcome === 'conflict' || out.outcome === 'failed') console.log(`${n}/${toRead} ${user.customerId}: ${out.outcome}${out.error ? ` (${out.error})` : ''}`); },
  });
  console.log(`Read ${done}:`, JSON.stringify(totals));
  console.log('saved = number confirmed by its check digit; to-confirm = staff confirm it when reviewing; unread = not a readable passport');
  if (conflicts.length) {
    console.log('Same passport on more than one account (customer ids):');
    conflicts.forEach((c) => console.log(`  ${c.customerId} with ${c.with.length} other account(s)`));
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
