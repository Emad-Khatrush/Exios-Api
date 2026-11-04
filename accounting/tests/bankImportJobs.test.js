const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { BankStatementLine } = require('../models/documents');
const jobs = require('../services/posting/bankImportJobs');

const req = { user: { _id: oid(), roles: { isAdmin: true } } };
beforeAll(startDb); afterAll(stopDb);
beforeEach(resetDb);

async function finished(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = jobs.status(jobId);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('import did not finish');
}

test('a background import reports progress, posts the chosen rows and a second click joins it', async () => {
  const cash = await account('110101');
  const expense = await account('520100');
  const rows = [
    { day: '2026-09-10', description: 'Office rent', amount: -50, counterAccountId: String(expense._id) },
    { day: '2026-09-11', description: 'Unknown deposit', amount: 20 },
  ];
  const started = jobs.start(cash._id, rows, { req });
  expect(started).toMatchObject({ status: 'running', rows: 2 });
  const joined = jobs.start(cash._id, rows, { req });
  expect(joined).toMatchObject({ jobId: started.jobId, alreadyRunning: true });
  const job = await finished(started.jobId);
  expect(job).toMatchObject({ status: 'done', phase: 'done', done: 1, total: 1, result: { count: 2, posted: 1 } });
  expect(await BankStatementLine.countDocuments()).toBe(2);
  expect(await BankStatementLine.countDocuments({ lineStatus: 'created_entry' })).toBe(1);
  // The same file again: nothing new, nothing posted twice
  const again = await finished(jobs.start(cash._id, rows, { req }).jobId);
  expect(again.result).toMatchObject({ count: 0, skipped: 2, posted: 0 });
  expect(await BankStatementLine.countDocuments({ lineStatus: 'created_entry' })).toBe(1);
});

test('a failed import is reported with its reason and an unknown job is not found', async () => {
  const job = await finished(jobs.start(oid(), [{ day: '2026-09-10', description: 'x', amount: -1 }], { req }).jobId);
  expect(job.status).toBe('failed');
  expect(job.error).toBeTruthy();
  expect(jobs.status('missing')).toBeUndefined();
});
