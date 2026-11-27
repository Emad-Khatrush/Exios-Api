// value — قيمة العميل: what the period's orders are worth, lifetime value and how concentrated it is.
const { DAY_MS, period, inPeriod, ordersOf, median, ratio, who } = require('../util');

const BUCKETS = [
  { label: '<100$', minCents: 0, maxCents: 10000 },
  { label: '100–500$', minCents: 10000, maxCents: 50000 },
  { label: '500–2,000$', minCents: 50000, maxCents: 200000 },
  { label: '2,000–10,000$', minCents: 200000, maxCents: 1000000 },
  { label: '≥10,000$', minCents: 1000000, maxCents: null },
];

const round = (x) => (x == null ? null : Math.round(x));
const sum = (values) => values.reduce((s, v) => s + v, 0);

module.exports = function value(dataset, query = {}) {
  const p = period(query);
  const office = query.office || null;

  let orders = 0;
  let valueCents = 0;
  const lifetime = []; // lifetime value of each customer with an order
  const inPeriodRows = []; // { c, orders, valueCents } per customer with an order in the period
  for (const c of dataset.customers) {
    const own = ordersOf(c, office);
    if (!own.length) continue;
    lifetime.push(sum(own.map((o) => o.valueCents)));
    let n = 0;
    let cents = 0;
    for (const o of own) {
      if (!inPeriod(o.at, p)) continue;
      n += 1;
      cents += o.valueCents;
    }
    if (!n) continue;
    orders += n;
    valueCents += cents;
    inPeriodRows.push({ c, orders: n, valueCents: cents });
  }
  const customers = inPeriodRows.length;

  // The period's length in whole days (`to` is the end of its day)
  const days = Math.max(Math.round((p.to - p.from) / DAY_MS), 1);
  const ordersPerCustomer = ratio(orders, customers);

  const buckets = BUCKETS.map((b) => ({ ...b, customers: 0 }));
  for (const cents of lifetime) {
    const b = buckets.find((x) => cents >= x.minCents && (x.maxCents == null || cents < x.maxCents));
    if (b) b.customers += 1;
  }

  inPeriodRows.sort((a, b) => b.valueCents - a.valueCents || b.orders - a.orders || a.c.id.localeCompare(b.c.id));
  const shareOfTop = (n) => ratio(sum(inPeriodRows.slice(0, n).map((r) => r.valueCents)), valueCents);

  return {
    period: p,
    orders,
    customers,
    valueCents,
    avgOrderCents: round(ratio(valueCents, orders)),
    ordersPerCustomer,
    avgCustomerCents: round(ratio(valueCents, customers)),
    perYear: { ordersPerCustomer: ordersPerCustomer == null ? null : (ordersPerCustomer * 365) / days },
    ltv: {
      avgCents: round(ratio(sum(lifetime), lifetime.length)),
      medianCents: round(median(lifetime)),
      buckets,
    },
    top: inPeriodRows.slice(0, 20).map((r) => ({ ...who(r.c), orders: r.orders, valueCents: r.valueCents, share: ratio(r.valueCents, valueCents) })),
    concentration: {
      top10Share: shareOfTop(10),
      top20Share: shareOfTop(20),
      // The top 10% of the period's customers by value, at least one customer
      top10PercentShare: shareOfTop(Math.max(1, Math.round(customers / 10))),
    },
  };
};
