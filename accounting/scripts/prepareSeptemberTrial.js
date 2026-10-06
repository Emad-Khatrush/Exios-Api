// Creates a separate LOCAL trial. The source database is read through a snapshot backup only.
// Deliberately does not load app.js, start workers, or change .env.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
require('dotenv').config({ quiet: true });

const { SOURCE, TARGET, START, COUNT, OUTPUT, URI: trialUri } = require('./septemberTrialConfig');

async function main() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:27017)?\//.test(uri || '')) throw new Error('Only the existing local copy is allowed');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const source = mongoose.connection.db;
  if (source.databaseName !== SOURCE) throw new Error('Unexpected source database');
  const databases = await source.admin().listDatabases();
  if (databases.databases.some(d => d.name === TARGET)) throw new Error('Trial already exists; refusing to overwrite it');
  const hello = await source.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('A local replica set is required');
  const restore = require('./mongoTools').findTool('mongorestore');
  if (!restore) throw new Error('mongorestore is required');
  fs.mkdirSync(OUTPUT, { recursive: true });
  const archive = path.join(OUTPUT, 'original-copy.zip');
  let manifest;
  if (fs.existsSync(archive)) {
    if (!process.argv.includes('--resume-backup')) throw new Error('Backup already exists; use --resume-backup to retain it');
    manifest = JSON.parse(new (require('adm-zip'))(archive).readAsText('manifest.json'));
    if (manifest.database !== SOURCE) throw new Error('Backup source mismatch');
    console.log('Resuming from the existing consistent backup');
  } else {
    console.log('Creating consistent local backup');
    manifest = await require('../services/backup').writeDump(source, fs.createWriteStream(archive, { flags: 'wx' }));
  }
  console.log(JSON.stringify({ phase: 'backup', documents: manifest.documents, bytes: manifest.bytes }));
  const zip = new (require('adm-zip'))(archive);
  const savedManifest = JSON.parse(zip.readAsText('manifest.json'));
  if (savedManifest.database !== SOURCE || savedManifest.documents !== manifest.documents) throw new Error('Backup manifest mismatch');
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'exios-september-dump-'));
  zip.extractAllTo(extracted, true);
  const result = spawnSync(restore, ['--uri=mongodb://127.0.0.1:27017/?directConnection=true', `--dir=${extracted}`, `--nsInclude=${SOURCE}.*`, `--nsFrom=${SOURCE}.*`, `--nsTo=${TARGET}.*`, '--quiet'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Restore failed; backup retained');
  await mongoose.disconnect();
  await mongoose.connect(trialUri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (db.databaseName !== TARGET) throw new Error('Target mismatch');
  for (const c of savedManifest.collections) {
    if (await db.collection(c.name).countDocuments() !== c.documents) throw new Error(`Restored count mismatch: ${c.name}`);
  }
  console.log('Verified restored collection counts; preparing trial only');

  const m = require('../models');
  const docs = require('../models/documents');
  const { runInTransaction } = require('../services/transaction');
  const Wallet = require('../../models/wallet');
  const UserStatement = require('../../models/userStatement');
  // Remove effects of accounting-only wallet experiments together with their statement lines.
  // Legacy operational payments/deposits are retained for the historical replay.
  const accountingStatements = await UserStatement.find({ 'accountingSource.model': /^Accounting/ }).lean();
  const movements = new Map();
  for (const s of accountingStatements) {
    if (!['+', '-'].includes(s.calculationType) || !Number.isFinite(s.amount)) throw new Error('Invalid accounting wallet statement');
    const key = `${s.user}|${s.currency}`;
    const group = movements.get(key) || { user: s.user, currency: s.currency, cents: 0 };
    group.cents += Math.round(s.amount * 100) * (s.calculationType === '+' ? 1 : -1);
    movements.set(key, group);
  }
  await runInTransaction(async session => {
    for (const g of movements.values()) {
      const wallet = await Wallet.findOne({ user: g.user, currency: g.currency }).session(session);
      if (!wallet) throw new Error('Missing wallet for accounting experiment');
      wallet.balance = Math.round((Number(wallet.balance) * 100 - g.cents)) / 100;
      await wallet.save({ session });
    }
    if (accountingStatements.length) await UserStatement.deleteMany({ _id: { $in: accountingStatements.map(s => s._id) } }, { session });
  });
  // Correct remaining running totals by the removed preceding movements, preserving legacy gaps.
  for (const g of movements.values()) {
    const removed = accountingStatements.filter(s => String(s.user) === String(g.user) && s.currency === g.currency);
    const remaining = await UserStatement.find({ user: g.user, currency: g.currency }).select('_id total').lean();
    const updates = remaining.map(s => {
      const cents = removed.filter(r => String(r._id) < String(s._id)).reduce((sum, r) => sum + Math.round(r.amount * 100) * (r.calculationType === '+' ? 1 : -1), 0);
      return cents ? { updateOne: { filter: { _id: s._id }, update: { $set: { total: Math.round(Number(s.total) * 100 - cents) / 100 } } } } : null;
    }).filter(Boolean);
    if (updates.length) await UserStatement.bulkWrite(updates);
  }

  // Use book balances at the end of the day before START, not October's physical counts.
  // Accounts with no recorded balance start at zero; these are not verified bank balances.
  const accounts = await m.Account.find({ isCash: true, isGroup: false, isActive: true }).lean();
  const currencies = new Map((await m.Currency.find({}).lean()).map(c => [c.code, c]));
  const booked = await m.JournalEntry.aggregate([
    { $match: { day: { $lte: COUNT } } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': { $in: accounts.map(a => a._id) } } },
    { $group: { _id: '$lines.accountId', usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, foreign: { $sum: '$lines.amountCurrency' } } },
  ]);
  const byId = new Map(booked.map(b => [String(b._id), b]));
  const openingCounts = accounts.map(a => ({ accountId: a._id,
    amount: ((a.currency || 'USD') === 'USD' ? byId.get(String(a._id))?.usd || 0 : byId.get(String(a._id))?.foreign || 0) / 10 ** (currencies.get(a.currency || 'USD')?.decimals ?? 2) }));
  const clear = ['JournalEntry', 'Counter', 'MigrationRun', 'Voucher', 'AccountingEvent', 'Reconciliation', 'ReviewedItem', 'OdooExport', 'OdooComparison', 'AuditLog'].map(k => m[k])
    .concat(['SupplierBill', 'SupplierPayment', 'SupplierReceipt', 'ClaimWriteOff', 'YuanPurchase', 'CustomerRefund', 'TreasuryTransfer', 'CashCount', 'FixedAsset', 'PrepaidExpense', 'SalaryPayment', 'EquityTransaction', 'Netting', 'BankStatementLine'].map(k => docs[k]));
  for (const Model of clear) {
    if (!Model) throw new Error('Missing reset model');
    await Model.deleteMany({});
  }
  await m.CurrencyRate.updateMany({}, { $set: { isUsed: false } });
  await m.AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: false, migrationDate: null, cutoffAt: null, migrationGuardDay: null, historyStartDate: null, lockDate: null } });
  require('../services/config').invalidateConfig();
  const metadata = { source: SOURCE, target: TARGET, operationalStart: START, countDay: COUNT, archive,
    openingBasis: `Copied book balances at ${COUNT}; not a verified physical bank count`, openingCounts,
    removedAccountingStatements: accountingStatements.length, removedExperimentCollections: clear.map(x => x.collection.name), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUTPUT, 'trial-state.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  console.log(`Starting historical replay with ${COUNT} opening count`);
  const migration = require('../services/migration');
  const run = await migration.startRun({ config: { countDay: COUNT, openingCounts, costAccounts: [], closeSuspense: false } });
  fs.writeFileSync(path.join(OUTPUT, 'run-id.txt'), run.runId);
  const timer = setInterval(async () => {
    try { const r = await m.MigrationRun.findById(run._id).select('status progress problems').lean(); console.log(JSON.stringify({ status: r.status, progress: r.progress, problems: r.problems?.length || 0 })); } catch (_) { /* final check reports errors */ }
  }, 15000);
  let final;
  try {
    do { await new Promise(resolve => setTimeout(resolve, 2000)); final = await m.MigrationRun.findById(run._id).lean(); } while (['running', 'committing'].includes(final.status));
  } finally { clearInterval(timer); }
  fs.writeFileSync(path.join(OUTPUT, 'migration-result.json'), JSON.stringify(final, null, 2));
  console.log(JSON.stringify({ phase: 'replayed', status: final.status, runId: final.runId, problems: final.problems?.length || 0 }));
  if (final.status !== 'review') throw new Error('Replay did not finish in review');
  console.log('Trial ready for verification before commit');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
