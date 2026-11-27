// staff: which staff member brought each new customer, and how those customers did.
// A customer belongs to whoever opened their first order ever (madeBy, when a staff member);
// else the 'app' bucket (opened by the customer, or unknown). Only customers whose first order
// is in the period. returned = 2+ orders ever; value90 = their orders in the 90 days from the
// first; lost = last order more than 90 days ago (as the churn section counts days).
const { DAY_MS, period, inPeriod, daysBetween, ordersOf, ratio } = require('../util');

const APP = 'app';
const APP_NAME = 'التطبيق / غير معروف';
const WINDOW_DAYS = 90;
const LOST_DAYS = 90;

const round = (x) => (x == null ? null : Math.round(x));

module.exports = function staff(dataset, query = {}) {
  const now = query.now || new Date();
  const p = period(query);
  const names = dataset.staff || new Map();
  const groups = new Map();

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    if (!orders.length) continue;
    const first = orders[0];
    if (!inPeriod(first.at, p)) continue;
    const key = first.madeBy && names.has(first.madeBy) ? first.madeBy : APP;
    let g = groups.get(key);
    if (!g) {
      g = { staffId: key, name: key === APP ? APP_NAME : names.get(key), newCustomers: 0, returned: 0, value90Cents: 0, lost: 0 };
      groups.set(key, g);
    }
    g.newCustomers += 1;
    if (orders.length >= 2) g.returned += 1;
    const end = first.at.getTime() + WINDOW_DAYS * DAY_MS;
    for (const o of orders) {
      if (o.at.getTime() >= end) break; // oldest first
      g.value90Cents += o.valueCents;
    }
    if (daysBetween(orders[orders.length - 1].at, now) > LOST_DAYS) g.lost += 1;
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.newCustomers - a.newCustomers || String(a.name).localeCompare(String(b.name)) || a.staffId.localeCompare(b.staffId))
    .map((g) => ({
      staffId: g.staffId,
      name: g.name,
      newCustomers: g.newCustomers,
      returned: g.returned,
      returnRate: ratio(g.returned, g.newCustomers),
      value90Cents: g.value90Cents,
      avgValue90Cents: round(ratio(g.value90Cents, g.newCustomers)),
      lost: g.lost,
    }));
  return { period: p, rows };
};
