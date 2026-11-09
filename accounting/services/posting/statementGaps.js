// Movements missing from inside a statement (owner's request 2026-11-10). The coverage report
// counts a month as covered once it holds one line, so a page lost from a PDF, or days never
// uploaded between two files, went unseen: with costs taken from the statements, a missing
// movement is a cost missing from the books.
//
// A statement's running balance says what is missing: the balance before a line (its balance
// after, less its amount) is the balance after the line before it. Where no line ends on the
// balance the next one starts from, movements adding up to the difference are not in the system.
// The trail is read as in statementClosingBalance: by the balances themselves, never by the order
// of the file or of same-day lines (banks print newest first, or oldest first).
const mongoose = require('mongoose');
const { BankStatementLine } = require('../../models/documents');

// One day's lines as trails over its balances: [{ start, end, values }] (a trail that returns to
// where it began, a day netting to nothing, has no start: it joins wherever the balance stands)
function trailsOf(lines) {
  const degree = new Map(), neighbours = new Map();
  const touch = value => { if (!neighbours.has(value)) { neighbours.set(value, new Set()); degree.set(value, 0); } };
  for (const line of lines) {
    const before = line.balanceAfter - line.amount, after = line.balanceAfter;
    touch(before); touch(after);
    degree.set(before, degree.get(before) + 1); degree.set(after, degree.get(after) - 1);
    neighbours.get(before).add(after); neighbours.get(after).add(before);
  }
  const seen = new Set(), trails = [];
  for (const first of neighbours.keys()) {
    if (seen.has(first)) continue;
    const values = [], pending = [first];
    while (pending.length) {
      const value = pending.pop();
      if (seen.has(value)) continue;
      seen.add(value); values.push(value); pending.push(...neighbours.get(value));
    }
    // A balance more lines leave than reach starts a trail; one more reach than leave ends it
    const starts = values.flatMap(value => Array(Math.max(degree.get(value), 0)).fill(value)).sort((a, b) => a - b);
    const ends = values.flatMap(value => Array(Math.max(-degree.get(value), 0)).fill(value)).sort((a, b) => a - b);
    if (!starts.length) trails.push({ loop: true, values: new Set(values) });
    else starts.forEach((start, index) => trails.push({ start, end: ends[index], values: new Set(values) }));
  }
  return trails;
}

// rows: [{ day, amount, balanceAfter }] in minor units. Returns the breaks of the balance trail.
function findGaps(rows) {
  const usable = rows.filter(row => Number.isSafeInteger(row.balanceAfter) && Number.isSafeInteger(row.amount));
  // A line printed without a balance cannot be placed on the trail; it may be what a break is
  const loose = rows.filter(row => !Number.isSafeInteger(row.balanceAfter) && Number.isSafeInteger(row.amount)).sort((a, b) => a.day.localeCompare(b.day));
  if (!usable.length) return { status: rows.length ? 'no_balances' : 'missing', checked: 0, withoutBalance: loose.length, gaps: [] };
  const days = new Map();
  for (const row of usable) { if (!days.has(row.day)) days.set(row.day, []); days.get(row.day).push(row); }
  const gaps = [];
  let balance = null, lastDay = null;
  for (const day of [...days.keys()].sort()) {
    const waiting = trailsOf(days.get(day));
    while (waiting.length) {
      // The trail that goes on from where the balance stands, else the nearest one
      let index = balance === null ? -1 : waiting.findIndex(trail => (trail.loop ? trail.values.has(balance) : trail.start === balance));
      const joined = index >= 0;
      if (!joined) index = waiting.reduce((best, trail, i) => {
        const at = t => (t.loop ? Math.min(...t.values) : t.start);
        return best < 0 || Math.abs(at(trail) - balance) < Math.abs(at(waiting[best]) - balance) ? i : best;
      }, -1);
      const [trail] = waiting.splice(index, 1);
      const start = trail.loop ? (joined ? balance : Math.min(...trail.values)) : trail.start;
      if (balance !== null && !joined) gaps.push({ afterDay: lastDay, beforeDay: day, expected: balance, found: start, missing: start - balance });
      balance = trail.loop ? start : trail.end;
      lastDay = day;
    }
  }
  // Lines without a balance dated inside a break and adding up to it are the break itself
  const open = gaps.filter(gap => {
    const inside = loose.filter(row => !row.used && row.day >= gap.afterDay && row.day <= gap.beforeDay);
    if (!inside.length || inside.reduce((sum, row) => sum + row.amount, 0) !== gap.missing) return true;
    inside.forEach(row => { row.used = true; });
    return false;
  });
  const sorted = [...days.keys()].sort();
  return { status: open.length ? 'gaps' : 'verified', checked: usable.length, withoutBalance: loose.length, firstDay: sorted[0], lastDay: sorted[sorted.length - 1], gaps: open };
}

// A line kept only as a possible second copy of another is not a movement of its own
const REAL = { duplicateReviewPending: { $ne: true }, duplicateResolvedToId: { $exists: false } };

async function forAccount(accountId, { session } = {}) {
  if (!mongoose.isValidObjectId(accountId)) return findGaps([]);
  const rows = await BankStatementLine.find({ accountId, ...REAL }).select('day amount balanceAfter').session(session || null).lean();
  return findGaps(rows.map(row => ({ day: row.day, amount: row.amount, balanceAfter: row.balanceAfter })));
}

// The same for several accounts in one read: Map of account id → result
async function forAccounts(accountIds) {
  const rows = accountIds.length ? await BankStatementLine.find({ accountId: { $in: accountIds }, ...REAL }).select('accountId day amount balanceAfter').lean() : [];
  const byAccount = new Map(accountIds.map(id => [String(id), []]));
  for (const row of rows) byAccount.get(String(row.accountId))?.push({ day: row.day, amount: row.amount, balanceAfter: row.balanceAfter });
  return new Map([...byAccount].map(([id, list]) => [id, findGaps(list)]));
}

module.exports = { findGaps, forAccount, forAccounts };
