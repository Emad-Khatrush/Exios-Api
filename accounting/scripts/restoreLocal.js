// npm run db:restore-local -- <archive> - restores a backup made by `npm run db:backup` into the
// LOCAL database, to prove the backup works (spec 19.12). It refuses any target that is not on
// this machine, so the production database can never be overwritten by mistake.
//
//   RESTORE_URI  the local database (default: mongodb://127.0.0.1:27017/?directConnection=true)
//   RESTORE_DB   the database name to restore into (default: exios-restore-test, so the working
//                local copy is not replaced; set it to exios-admin to replace that one)
//
// Needs the MongoDB Database Tools (mongorestore). Prints the number of documents restored per
// collection for a quick comparison with the source.
const fs = require('fs');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const archive = process.argv[2];
if (!archive || !fs.existsSync(archive)) {
  console.error('Usage: npm run db:restore-local -- <path to .archive.gz>');
  process.exit(1);
}
const uri = process.env.RESTORE_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) {
  console.error(`Refusing to restore into ${uri}: only a database on this machine (127.0.0.1 / localhost) is allowed.`);
  process.exit(1);
}
const target = process.env.RESTORE_DB || 'exios-restore-test';

(async () => {
  // The archive holds one database: every collection of it is renamed into the target
  const args = [`--uri=${uri}`, `--archive=${archive}`, '--gzip', '--drop', `--nsFrom=*.*`, `--nsTo=${target}.*`];
  console.log(`Restoring ${archive} into ${target} ...`);
  const result = spawnSync('mongorestore', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) {
    console.error(result.error?.code === 'ENOENT' ? 'mongorestore was not found: install the MongoDB Database Tools.' : 'mongorestore failed.');
    process.exit(1);
  }
  const base = uri.replace(/\/(\?|$)/, `/${target}$1`);
  await mongoose.connect(base);
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
