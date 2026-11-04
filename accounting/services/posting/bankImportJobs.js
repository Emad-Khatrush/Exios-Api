// A bank statement import runs in the background so a large file does not hit the hosting
// request timeout (a 503 the browser shows while the server keeps importing, which invites a
// second click). The page starts the import, gets its id at once and asks for its progress.
// Kept in memory: one API instance. A restart loses the job; the page then says so and the
// owner checks the statement, which re-import cannot duplicate (fingerprints).
const crypto = require('crypto');

const jobs = new Map();
const KEEP_MS = 60 * 60 * 1000;

const view = job => job && ({
  jobId: job.id, accountId: job.accountId, status: job.status, phase: job.phase, done: job.done, total: job.total,
  rows: job.rows, startedAt: job.startedAt, updatedAt: job.updatedAt, result: job.result, error: job.error,
});

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.status !== 'running' && now - job.updatedAt > KEEP_MS) jobs.delete(id);
}

// One import at a time per bank account: a second click joins the running one
function start(accountId, rows, { req, matchingSettings }) {
  prune();
  const running = [...jobs.values()].find(job => job.accountId === String(accountId) && job.status === 'running');
  if (running) return { ...view(running), alreadyRunning: true };
  const now = Date.now();
  const job = { id: crypto.randomUUID(), accountId: String(accountId), userId: String(req?.user?._id || ''), status: 'running',
    phase: 'saving', done: 0, total: rows.length, rows: rows.length, startedAt: now, updatedAt: now, result: null, error: null };
  jobs.set(job.id, job);
  const onProgress = ({ phase, done, total }) => Object.assign(job, { phase, done, total, updatedAt: Date.now() });
  require('./bank').importStatement(accountId, rows, { req, matchingSettings, onProgress })
    .then(result => Object.assign(job, { status: 'done', phase: 'done', done: job.total, result, updatedAt: Date.now() }))
    .catch(error => Object.assign(job, { status: 'failed', error: error?.message || 'تعذر الاستيراد', updatedAt: Date.now() }));
  return view(job);
}

const status = id => view(jobs.get(String(id)));

module.exports = { start, status };
