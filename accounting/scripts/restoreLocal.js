// npm run db:restore-local -- <archive> - restores a backup made by `npm run db:backup` (or a daily
// .zip downloaded from the Backups page) into the
// LOCAL database, to prove the backup works (spec 19.12). It refuses any target that is not on
// this machine, so the production database can never be overwritten by mistake.
//
//   RESTORE_URI  the local database (default: mongodb://127.0.0.1:27017/?directConnection=true)
//   RESTORE_DB   the database name to restore into (default: exios-restore-test, so the working
//                local copy is not replaced; set it to exios-admin to replace that one)
//
// The copy's WhatsApp session is removed (see below).
// Needs the MongoDB Database Tools (mongorestore). Prints the number of documents restored per
// collection for a quick comparison with the source.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { findTool } = require('./mongoTools');
const mongoose = require('mongoose');

const archive = process.argv[2];
if (!archive || !fs.existsSync(archive)) {
  console.error('Usage: npm run db:restore-local -- <path to .archive.gz or .zip>');
  process.exit(1);
}
const uri = process.env.RESTORE_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) {
  console.error(`Refusing to restore into ${uri}: only a database on this machine (127.0.0.1 / localhost) is allowed.`);
  process.exit(1);
}
const target = process.env.RESTORE_DB || 'exios-restore-test';
// A daily backup is a zip of a dump folder: it is extracted to a temporary folder first, and its
// manifest names the database inside
const isZip = /\.zip$/i.test(archive);
let dumpDir = null;
let zipSource = null;
if (isZip) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archive);
  zipSource = JSON.parse(zip.readAsText('manifest.json')).database;
  dumpDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'exios-restore-'));
  zip.extractAllTo(dumpDir, true);
}
// The database the backup came from: in the file name made by db:backup (<database>-<date>-<time>),
// or RESTORE_FROM_DB
const named = (require('path').basename(archive).match(/^(.+)-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.archive\.gz$/) || [])[1];
// Backups taken before the database name was read correctly are called "database-..." and hold
// the default database, "test"
const source = process.env.RESTORE_FROM_DB || zipSource || (named === 'database' ? 'test' : named);
if (!source) {
  console.error('Set RESTORE_FROM_DB to the name of the database inside the backup.');
  process.exit(1);
}

(async () => {
  // Every collection of the source database is restored under the target name
  const from = isZip ? [`--dir=${dumpDir}`] : [`--archive=${archive}`, '--gzip'];
  const args = [`--uri=${uri}`, ...from, '--drop', `--nsInclude=${source}.*`, `--nsFrom=${source}.*`, `--nsTo=${target}.*`];
  console.log(`Restoring ${archive} into ${target} ...`);
  const result = spawnSync(findTool('mongorestore') || 'mongorestore', args, { stdio: 'inherit' });
  if (dumpDir) fs.rmSync(dumpDir, { recursive: true, force: true });
  if (result.error || result.status !== 0) {
    console.error(result.error?.code === 'ENOENT' ? 'mongorestore was not found: install the MongoDB Database Tools.' : 'mongorestore failed.');
    process.exit(1);
  }
  const base = uri.replace(/\/(\?|$)/, `/${target}$1`);
  await mongoose.connect(base);
  // A copy of production holds the company's WhatsApp session: a local server started on it would
  // log in as the company number (and could send campaigns). It is removed from the copy unless
  // RESTORE_KEEP_WHATSAPP=true.
  if (process.env.RESTORE_KEEP_WHATSAPP !== 'true') {
    const all = await mongoose.connection.db.listCollections().toArray();
    for (const { name } of all.filter((c) => /^whatsapp/i.test(c.name))) {
      await mongoose.connection.db.dropCollection(name);
      console.log(`  removed ${name} (WhatsApp session of the source)`);
    }
  }
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${name}: ${await mongoose.connection.db.collection(name).countDocuments()}`);
  }
  await mongoose.disconnect();
  console.log('Restore worked. Compare these counts with the source database before going on.');
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
