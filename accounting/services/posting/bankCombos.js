// A statement line that is the total of two or three operations already in the books (one transfer
// paying a supplier and a salary, two supplier payments sent together...). Every set of unmatched
// movements on the same account, in the same direction, a week around the line, whose total is the
// line exactly, is offered for review: the person picks the right one or none. Never matched
// automatically: equal totals alone do not prove it (only a shared reference does, in autoMatch).
const evidence = require('./bankEvidence');

const DAYS = 7;
const POOL = 40;
const LIMIT = 6;
const dayDistance = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

function combinations(line, movements, { days = DAYS, limit = LIMIT } = {}) {
  const sign = Math.sign(line.amount);
  if (!sign) return { options: [], more: 0 };
  const lineRef = evidence.ref(line.sourceTransactionId || line.reference);
  const pool = movements
    .filter((m) => !m.balanceAdjustment && Math.sign(m.amount) === sign && Math.abs(m.amount) < Math.abs(line.amount)
      && dayDistance(m.day, line.day) <= days && evidence.referenceCompatible(line, m))
    .sort((a, b) => dayDistance(a.day, line.day) - dayDistance(b.day, line.day))
    .slice(0, POOL);
  const byAmount = new Map();
  pool.forEach((m, i) => byAmount.set(m.amount, [...(byAmount.get(m.amount) || []), i]));
  const sets = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const pair = pool[i].amount + pool[j].amount;
      if (pair === line.amount) sets.push([i, j]);
      else for (const k of byAmount.get(line.amount - pair) || []) if (k > j) sets.push([i, j, k]);
    }
  }
  const shared = (m) => !!lineRef && evidence.movementRef(m, line.accountId) === lineRef;
  const options = sets.map((set) => {
    const entries = set.map((i) => pool[i]);
    return {
      entries: entries.map((m) => ({ _id: m._id, number: m.number, day: m.day, description: m.description, amount: m.amount })),
      strong: entries.every(shared),
      days: entries.reduce((s, m) => s + dayDistance(m.day, line.day), 0),
    };
  }).sort((a, b) => Number(b.strong) - Number(a.strong) || a.days - b.days || a.entries.length - b.entries.length);
  return { options: options.slice(0, limit), more: Math.max(options.length - limit, 0) };
}

module.exports = { combinations };
