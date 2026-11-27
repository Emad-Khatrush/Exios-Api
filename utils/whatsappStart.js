// When a WhatsApp start counts as stuck (owner 2026-11-27). A start restored from the saved session
// first downloads it from MongoDB; with Atlas throttled the 33 MB took 6 minutes, the 4-minute timer
// called the start stuck twice and the good session was deleted. The time is therefore counted from
// the end of the download, and never while it is still downloading.
//   armedAt     when the timer was armed (ms)
//   restoring   the session is being downloaded now
//   restoredAt  when the last download ended (ms), if any
// → { due, waitMs }: due when the start has had its full time; otherwise check again after waitMs
const RECHECK_MS = 15000;
// A download still going after this has hung: the start is stuck after all
const MAX_RESTORE_MS = 20 * 60 * 1000;

function startTimerCheck({ armedAt, now, timeoutMs, restoring = false, restoredAt = 0 }) {
  if (restoring) return now - armedAt >= MAX_RESTORE_MS ? { due: true, waitMs: 0 } : { due: false, waitMs: RECHECK_MS };
  const from = Math.max(armedAt, restoredAt || 0);
  const left = from + timeoutMs - now;
  return left <= 0 ? { due: true, waitMs: 0 } : { due: false, waitMs: left };
}

module.exports = { startTimerCheck, RECHECK_MS };
