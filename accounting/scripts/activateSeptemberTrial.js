// Select an already verified local trial for the existing development server.
// Keeps .env private, backs it up, and never launches a server or messaging worker.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { TARGET, START, COUNT, OUTPUT, URI } = require('./septemberTrialConfig');

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'verified-trial.json'), 'utf8'));
  if (state.database !== TARGET || state.status !== 'committed' || state.operationalStart !== START || state.countDay !== COUNT || state.problems) {
    throw new Error('The requested trial has not passed verification');
  }
  await mongoose.connect(URI, { autoIndex: false, autoCreate: false });
  const cfg = await require('../services/config').getConfig();
  if (mongoose.connection.db.databaseName !== TARGET || !cfg.settings?.liveEnabled || cfg.count?.day !== COUNT || !cfg.count.endOfDay) {
    throw new Error('The database does not match the verified trial');
  }
  await mongoose.disconnect();
  const backend = path.resolve(__dirname, '..', '..');
  const envPath = path.join(backend, '.env');
  const backup = path.join(OUTPUT, 'backend.env.before-switch');
  if (!fs.existsSync(backup)) fs.copyFileSync(envPath, backup, fs.constants.COPYFILE_EXCL);
  let contents = fs.readFileSync(envPath, 'utf8');
  const set = (name, value) => {
    const re = new RegExp(`^${name}=.*$`, 'm');
    contents = re.test(contents) ? contents.replace(re, `${name}=${value}`) : `${contents.replace(/\s*$/, '')}\r\n${name}=${value}\r\n`;
  };
  set('MONGO_URL_2', URI);
  set('EXIOS_LOCAL_ACCOUNTING_TRIAL', '1');
  fs.writeFileSync(envPath, contents);
  // nodemon does not normally watch .env. Touch its existing JS entry to reload configuration.
  const at = new Date();
  fs.utimesSync(path.join(backend, 'app.js'), at, at);
  console.log(JSON.stringify({ database: TARGET, openingCountDay: COUNT, operationalStartDate: START, configurationUpdated: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
