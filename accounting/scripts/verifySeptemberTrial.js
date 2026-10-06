// Checks and commits the separate local September trial; never connects to the original copy.
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { TARGET, START, COUNT, OUTPUT, URI } = require('./septemberTrialConfig');

async function main() {
  await mongoose.connect(URI, { autoIndex: false, autoCreate: false });
  if (mongoose.connection.db.databaseName !== TARGET) throw new Error('Unexpected database');
  const m = require('../models');
  const docs = require('../models/documents');
  const { getConfig, invalidateConfig } = require('../services/config');
  const { getBalance } = require('../services/carrying');
  const runId = fs.readFileSync(path.join(OUTPUT, 'run-id.txt'), 'utf8').trim();
  let run = await m.MigrationRun.findOne({ runId }).lean();
  if (!run || !['review', 'committed'].includes(run.status) || run.problems.length || !run.report?.balanced) throw new Error('Replay must be balanced and have zero posting problems before commit');
  const report = await require('../services/reports/exceptions').runChecks({ only: ['balanced', 'wallets', 'roles', 'failedEvents'] });
  fs.writeFileSync(path.join(OUTPUT, 'pre-commit-checks.json'), JSON.stringify(report, null, 2));
  if (report.results.some(r => r.severity === 'error' && r.count)) throw new Error('Financial checks found errors; trial retained in review');
  const metadata = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'trial-state.json'), 'utf8'));
  if (metadata.operationalStart !== START || metadata.countDay !== COUNT) throw new Error('Trial configuration differs from the recorded preparation');
  const cfg = await getConfig();
  for (const count of metadata.openingCounts) {
    const a = cfg.accountsById.get(String(count.accountId));
    const bal = await getBalance(a._id, { upToDay: COUNT });
    const native = (a.currency || 'USD') === 'USD' ? bal.usd : bal.foreign;
    const expected = Math.round(count.amount * 10 ** (cfg.currencies.get(a.currency || 'USD')?.decimals ?? 2));
    if (native !== expected) throw new Error(`Opening balance mismatch: ${a.code}`);
  }
  if (await docs.BankStatementLine.countDocuments() || await docs.CustomerRefund.countDocuments()) throw new Error('Old bank/refund experiments were not reset');
  console.log(JSON.stringify({ phase: 'verified', checks: report.results.map(r => ({ key: r.key, count: r.count })), countAccounts: metadata.openingCounts.length }));
  if (run.status === 'review') {
    console.log('Committing the trial migration');
    await require('../services/migration').commitRun(runId);
  } else console.log('Migration already committed; repeating verification only');
  invalidateConfig();
  const live = await getConfig();
  if (!live.settings.liveEnabled || live.count?.day !== COUNT || !live.count.endOfDay) throw new Error('Incorrect live trial boundary');

  // Exercise the actual trial database in an ABORTED transaction, leaving no test rows behind.
  const bank = [...live.accountsById.values()].find(a => a.isCash && !a.isGroup && a.isActive && a.currency === 'TRY');
  if (!bank) throw new Error('TRY bank is required for the statement smoke test');
  const opening = live.accountsByCode.get('390000');
  const before = await getBalance(bank._id);
  const session = await mongoose.startSession();
  let boundary;
  try {
    session.startTransaction();
    const expectedUsd = await new (require('../services/posting/common').RateBook)(session).toUsd(12345, 'TRY', START);
    const create = async day => {
      const [line] = await docs.BankStatementLine.create([{ accountId: bank._id, day, amount: 12345,
        description: 'September trial boundary verification', fingerprint: `SEPTEMBER-VERIFY:${day}` }], { session });
      await require('../services/posting/bank').createEntryForLine(line._id, { counterAccountId: opening._id,
        office: live.settings.defaultOffice, confirmNotRefund: true, confirmNotDuplicate: true }, { session });
      return getBalance(bank._id, { session });
    };
    const old = await create(COUNT);
    const current = await create(START);
    if (old.usd !== before.usd || old.foreign !== before.foreign) throw new Error('The count day incorrectly moved the bank');
    if (current.usd - old.usd !== expectedUsd || current.foreign - old.foreign !== 12345) throw new Error('The first operational day did not move the bank correctly');
    boundary = { countDay: COUNT, startDay: START, countDayBankDelta: 0, startDayTryDelta: 123.45, startDayUsdDelta: expectedUsd / 100, rolledBack: true };
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const after = await getBalance(bank._id);
  if (after.usd !== before.usd || after.foreign !== before.foreign) throw new Error('Verification transaction left changes');
  const checks = await require('../services/reports/exceptions').runAndStore();
  const balanceSheet = await require('../services/reports/statements').balanceSheet({ asOf: require('../services/dates').today() });
  run = await m.MigrationRun.findOne({ runId }).lean();
  const result = { database: TARGET, runId, status: run.status, operationalStart: START, countDay: live.count.day,
    entries: await m.JournalEntry.countDocuments(), problems: run.problems.length, boundary,
    checks: checks.results.map(r => ({ key: r.key, severity: r.severity, count: r.count })), balanceSheet,
    bankLines: await docs.BankStatementLine.countDocuments(), supplierBills: await docs.SupplierBill.countDocuments(),
    sourceUnchangedByTheseScripts: true, openingBasis: metadata.openingBasis };
  fs.writeFileSync(path.join(OUTPUT, 'verified-trial.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, balanceSheet: { balanced: balanceSheet.balanced }, checks: result.checks.filter(r => r.count) }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
