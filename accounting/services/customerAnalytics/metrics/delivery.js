// delivery: days from our warehouse abroad (arrivedAt) to the customer (deliveredAt), for the
// packages handed over in the period; negatives (bad dates) are dropped. effect: each customer by
// their first package handed over (in the period), and whether they ordered again after it.
const { period, inPeriod, monthKey, monthRange, daysBetween, ordersOf, median, ratio } = require('../util');

const BUCKETS = [
  { label: '0–7', minDays: 0, maxDays: 7 },
  { label: '8–14', minDays: 8, maxDays: 14 },
  { label: '15–30', minDays: 15, maxDays: 30 },
  { label: '31–60', minDays: 31, maxDays: 60 },
  { label: '>60', minDays: 61, maxDays: null },
];
const bucketOf = (days) => BUCKETS.findIndex((b) => days >= b.minDays && (b.maxDays === null || days <= b.maxDays));

// p90 = the value at ceil(0.9 x n) - 1 of the sorted list
function p90(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}
const average = (values) => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null);

module.exports = function delivery(dataset, query = {}) {
  const p = period(query);
  const all = [];
  const byMethod = { air: [], sea: [], unknown: [] };
  const byMonth = new Map(monthRange(monthKey(p.from), monthKey(p.to)).map((m) => [m, []]));
  const effect = BUCKETS.map(() => ({ customers: 0, returned: 0 }));

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    let first = null; // the customer's first package handed over (any time)
    for (const o of orders) {
      for (const pkg of o.packages || []) {
        if (!pkg.arrivedAt || !pkg.deliveredAt) continue;
        const days = daysBetween(pkg.arrivedAt, pkg.deliveredAt);
        if (days < 0) continue;
        if (!first || pkg.deliveredAt < first.at) first = { at: pkg.deliveredAt, days };
        if (!inPeriod(pkg.deliveredAt, p)) continue;
        all.push(days);
        byMethod[o.method || 'unknown'].push(days);
        byMonth.get(monthKey(pkg.deliveredAt))?.push(days);
      }
    }
    if (!first || !inPeriod(first.at, p)) continue;
    const e = effect[bucketOf(first.days)];
    e.customers += 1;
    if (orders.some((o) => o.at > first.at)) e.returned += 1;
  }

  const counts = BUCKETS.map(() => 0);
  for (const days of all) counts[bucketOf(days)] += 1;
  const summary = (values) => ({ packages: values.length, medianDays: median(values) });
  return {
    period: p,
    packages: all.length,
    medianDays: median(all),
    avgDays: average(all),
    p90Days: p90(all),
    byMethod: { air: summary(byMethod.air), sea: summary(byMethod.sea), unknown: summary(byMethod.unknown) },
    months: [...byMonth].map(([month, values]) => ({ month, ...summary(values) })),
    buckets: BUCKETS.map((b, i) => ({ ...b, packages: counts[i] })),
    effect: BUCKETS.map((b, i) => ({ label: b.label, ...effect[i], returnRate: ratio(effect[i].returned, effect[i].customers) })),
  };
};
