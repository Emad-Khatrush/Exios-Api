if (process.env.NODE_ENV !== 'production') require('dotenv').config({ quiet: true });
const mongoose = require('mongoose'), fs = require('fs'), path = require('path');
const profiles = require('../services/bankMatchingProfile');
async function main() {
  const args = process.argv.slice(2), mode = args[0];
  if (!['export', 'check', 'apply'].includes(mode)) throw Error('Usage: node accounting/scripts/bankMatchingProfile.js export|check|apply [file.json]');
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!uri) throw Error('Database connection is not configured.');
  if (mode === 'export' && (!['127.0.0.1','localhost','[::1]'].includes(new URL(uri).hostname) || process.env.NODE_ENV === 'production' || process.env.EXIOS_QA === '1')) throw Error('Export is restricted to the local database.');
  const file = path.resolve(args[1] || path.join(__dirname, '../seed/bankMatchingProfile.json'));
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  if (mode === 'export') {
    const profile = await profiles.snapshot();
    fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8' });
    console.log(JSON.stringify({ file, accounts: profile.accounts.length, vendors: profile.vendors.length, rules: profile.rules.length, history: profile.history.length }));
  } else console.log(JSON.stringify(await profiles.apply(JSON.parse(fs.readFileSync(file, 'utf8')), { dryRun: mode !== 'apply' })));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
