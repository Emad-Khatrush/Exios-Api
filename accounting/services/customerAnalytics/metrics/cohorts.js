// cohorts: customers grouped by the month of their first order, and how many ordered again k months later.
const { monthKey, addMonths, monthRange, ordersOf, ratio } = require('../util');

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 36;

function cohortCount(value) {
  const n = Math.floor(Number(value));
  if (!(n >= 1)) return DEFAULT_MONTHS;
  return Math.min(n, MAX_MONTHS);
}

// Weighted by size: sum retained / sum size over the non-empty cohorts that reached the offset
function averages(cohorts, n) {
  const out = [];
  for (let offset = 0; offset < n; offset += 1) {
    let retained = 0;
    let size = 0;
    let count = 0;
    for (const c of cohorts) {
      if (c.retained.length <= offset || !c.size) continue;
      retained += c.retained[offset];
      size += c.size;
      count += 1;
    }
    out.push({ offset, rate: ratio(retained, size), cohorts: count });
  }
  return out;
}

module.exports = function cohorts(dataset, query = {}) {
  const n = cohortCount(query.months);
  const current = monthKey(query.now || new Date());
  const keys = monthRange(addMonths(current, -(n - 1)), current);
  const index = new Map(keys.map((m, i) => [m, i]));
  // retained arrays stop at the current month: cohort i has n - i offsets
  const rows = keys.map((month, i) => ({ month, size: 0, retained: new Array(n - i).fill(0) }));

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    if (!orders.length) continue;
    const start = index.get(monthKey(orders[0].at));
    if (start === undefined) continue; // first order before the oldest cohort shown (or in the future)
    const row = rows[start];
    row.size += 1;
    const offsets = new Set();
    for (const o of orders) {
      const at = index.get(monthKey(o.at));
      if (at !== undefined) offsets.add(at - start);
    }
    for (const k of offsets) row.retained[k] += 1;
  }

  const shaped = rows.map((r) => ({ ...r, rates: r.retained.map((x) => ratio(x, r.size)) }));
  return { cohorts: shaped, average: averages(shaped, n) };
};
