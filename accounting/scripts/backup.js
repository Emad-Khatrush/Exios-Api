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

const uri = process.env.BACKUP_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;
if (!uri) {
  console.error('Set BACKUP_URI (or MONGO_URL) to the database to back up.');
  process.exit(1);
}
const database = (uri.match(/\/([^/?]+)(\?|$)/) || [])[1] || 'database';
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${database}-${stamp}.archive.gz`);

console.log(`Backing up ${database} to ${file} ...`);
const result = spawnSync('mongodump', [`--uri=${uri}`, `--archive=${file}`, '--gzip'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error || result.status !== 0) {
  console.error(result.error?.code === 'ENOENT' ? 'mongodump was not found: install the MongoDB Database Tools.' : 'mongodump failed.');
  process.exit(1);
}
const size = fs.statSync(file).size;
console.log(`Done: ${file} (${(size / 1024 / 1024).toFixed(1)} MB). Test it with: npm run db:restore-local -- "${file}"`);
