const { BankStatementLine } = require('../../models/documents');

// Running balances define a trail: before = after - movement. The endpoint is
// independent of file direction, insertion order and same-day timestamps.
// `startHint`: the balance the day started from (the previous day's closing). A day whose balance
// comes back to where it started ("+25.592,95" then "-25.592,95", both around 25.000 on Kuveyt Türk
// 2026-11-11) is a closed loop with no single end; the day's start tells which balance it closed on.
function resolveClosing(rows, startHint = null) {
  if (!rows.length) return { balance: null, day: null, status: 'missing' };
  const day = rows.reduce((latest, row) => row.day > latest ? row.day : latest, '');
  const latest = rows.filter(row => row.day === day);
  const anchors = latest.filter(row => Number.isSafeInteger(row.balanceAfter) && Number.isSafeInteger(row.amount));
  if (!anchors.length) return { balance: null, day, status: 'missing' };
  const degrees = new Map(), neighbours = new Map();
  const add = (value, delta) => degrees.set(value, (degrees.get(value) || 0) + delta);
  for (const row of anchors) {
    const before = row.balanceAfter - row.amount, after = row.balanceAfter;
    add(before, -1); add(after, 1);
    if (!neighbours.has(before)) neighbours.set(before, new Set());
    if (!neighbours.has(after)) neighbours.set(after, new Set());
    neighbours.get(before).add(after); neighbours.get(after).add(before);
  }
  const seen = new Set(), pending = [degrees.keys().next().value];
  while (pending.length) {
    const value = pending.pop();
    if (seen.has(value)) continue;
    seen.add(value); pending.push(...neighbours.get(value));
  }
  const closing = [...degrees].filter(([, degree]) => degree === 1);
  const opening = [...degrees].filter(([, degree]) => degree === -1);
  const loop = seen.size === degrees.size && anchors.length === latest.length && [...degrees.values()].every(degree => degree === 0);
  if (loop) return startHint !== null && degrees.has(startHint) ? { balance: startHint, day, status: 'verified' } : { balance: null, day, status: 'ambiguous' };
  const valid = seen.size === degrees.size && closing.length === 1 && opening.length === 1
    && [...degrees.values()].every(degree => Math.abs(degree) <= 1) && anchors.length === latest.length;
  if (!valid) return { balance: null, day, status: 'ambiguous' };
  return { balance: closing[0][0], day, status: 'verified' };
}

async function statementClosingBalance(accountId) {
  const latest = await BankStatementLine.findOne({ accountId }).sort({ day: -1 }).select('day').lean();
  if (!latest) return resolveClosing([]);
  const rows = await BankStatementLine.find({ accountId, day: latest.day }).select('day amount balanceAfter').lean();
  const result = resolveClosing(rows);
  if (result.status !== 'ambiguous') return result;
  // A day that came back to its start: the previous day's closing says where it started
  const previous = await BankStatementLine.findOne({ accountId, day: { $lt: latest.day } }).sort({ day: -1 }).select('day').lean();
  if (!previous) return result;
  const before = resolveClosing(await BankStatementLine.find({ accountId, day: previous.day }).select('day amount balanceAfter').lean());
  return before.status === 'verified' ? resolveClosing(rows, before.balance) : result;
}

module.exports = { resolveClosing, statementClosingBalance };
