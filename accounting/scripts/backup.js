// npm run db:backup - a full mongodump of the database (spec 19.12), taken before
// `npm run accounting:setup` on the real database and again before the historical migration is
// committed. Needs the MongoDB Database Tools (mongodump) installed.
//
//   BACKUP_URI   the database to copy (default: MONGO_URL_2 / MONGO_URL, as the app uses)
//   BACKUP_DIR   where the archive goes (default: ./backups)
//
// Writes backups/<database>-<date>-<time>.archive.gz and prints its size; nothing is changed in
// the database.
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTool } = require('./mongoTools');

const uri = process.env.BACKUP_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;
if (!uri) {
  console.error('Set BACKUP_URI (or MONGO_URL) to the database to back up.');
  process.exit(1);
}
// A URI with no database name (as on Atlas here) uses MongoDB's default database, "test": that is
// where the system's data lives. Only that one database is dumped, so the file says what it holds.
const database = process.env.BACKUP_DB || (uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/) || [])[1] || 'test';
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${database}-${stamp}.archive.gz`);

console.log(`Backing up ${database} to ${file} ...`);
const result = spawnSync(findTool('mongodump') || 'mongodump', [`--uri=${uri}`, `--db=${database}`, `--archive=${file}`, '--gzip'], { stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error(result.error?.code === 'ENOENT' ? 'mongodump was not found: install the MongoDB Database Tools.' : 'mongodump failed.');
  process.exit(1);
}
const size = fs.statSync(file).size;
console.log(`Done: ${file} (${(size / 1024 / 1024).toFixed(1)} MB). Test it with: npm run db:restore-local -- "${file}"`);
