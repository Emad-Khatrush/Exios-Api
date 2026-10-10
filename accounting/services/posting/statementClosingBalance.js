const { BankStatementLine } = require('../../models/documents');

// Running balances define a trail: before = after - movement. The endpoint is
// independent of file direction, insertion order and same-day timestamps.
function resolveClosing(rows) {
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
  const valid = seen.size === degrees.size && closing.length === 1 && opening.length === 1
    && [...degrees.values()].every(degree => Math.abs(degree) <= 1) && anchors.length === latest.length;
  if (!valid) return { balance: null, day, status: 'ambiguous' };
  return { balance: closing[0][0], day, status: 'verified' };
}

async function statementClosingBalance(accountId) {
  const latest = await BankStatementLine.findOne({ accountId }).sort({ day: -1 }).select('day').lean();
  if (!latest) return resolveClosing([]);
  const rows = await BankStatementLine.find({ accountId, day: latest.day }).select('day amount balanceAfter').lean();
  return resolveClosing(rows);
}

module.exports = { resolveClosing, statementClosingBalance };
