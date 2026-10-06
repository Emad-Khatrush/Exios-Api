const routes = require('./routes');
const systemRoutes = require('./systemRoutes');
const { runSetup, isSetupDone } = require('./seed/setup');
const { startWorker } = require('./services/events');

// Called once the database is connected: a database without accounting settings gets the
// default setup, so the section works right after deploy, and the live posting worker starts
// (it does nothing while live posting is off). Never stops the app on failure.
async function initAccounting() {
  try {
    if (!(await isSetupDone())) {
      const report = await runSetup();
      console.log(`[accounting] default setup created ${report.created.length} items`);
    }
    await require('./seed/merchantSetup').ensureMerchantSetup();
  } catch (error) {
    console.error('[accounting] default setup failed:', error.message);
  }
  try {
    await require('./services/settingsRate').syncSettingsRate();
  } catch (error) {
    console.error('[accounting] could not align the settings rate:', error.message);
  }
  startWorker();
  startDailyReconciliation();
  // The whole database, once a day, to the private backup bucket (only when BACKUP_BUCKET is set)
  require('./services/backup').startDailyBackup();
}

// Spec 10: the reconciliation runs once a day (checked every hour, so a server that was down at
// midnight still runs it) and its result is kept for the dashboard. Nothing runs before the
// historical migration is committed: there is nothing to reconcile yet.
let reconciliationTimer = null;
function startDailyReconciliation() {
  if (reconciliationTimer) return;
  const tick = async () => {
    try {
      const { getConfig } = require('./services/config');
      const { today } = require('./services/dates');
      const { latest, runAndStore } = require('./services/reports/exceptions');
      const { settings } = await getConfig();
      if (!settings?.migrationDate) return;
      if ((await latest())?.day === today()) return;
      await runMonthlySchedules();
      await runAndStore();
    } catch (error) {
      console.error('[accounting] daily reconciliation:', error.message);
    }
  };
  reconciliationTimer = setInterval(tick, 60 * 60 * 1000);
  if (reconciliationTimer.unref) reconciliationTimer.unref();
  setTimeout(tick, 30 * 1000).unref?.();
}

// Spec 7-ب.2: monthly depreciation and prepaid instalments run by themselves, once a day before
// the reconciliation. Each posts only the months that ended and are not posted yet, so running it
// daily is harmless; a failure (a locked month, say) is logged and tried again the next day.
async function runMonthlySchedules() {
  const { runInTransaction } = require('./services/transaction');
  const schedules = require('./services/posting/schedules');
  for (const [name, job] of [['depreciation', schedules.runDepreciation], ['prepaid', schedules.runPrepaidAmortization]]) {
    try {
      const result = await runInTransaction((session) => job({ session }));
      if (result?.posted) console.log(`[accounting] ${name}: posted ${result.posted} month(s) up to ${result.upToMonth}`);
    } catch (error) {
      console.error(`[accounting] ${name}:`, error.message);
    }
  }
}

module.exports = { routes, systemRoutes, initAccounting, runMonthlySchedules };
