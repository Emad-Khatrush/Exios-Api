// churn: customers who stopped ordering.
// lost = last order more than `days` ago; atRisk = not lost but silent longer than
// max(2 x their usual gap between orders, 30 days). Both need at least `minOrders` orders.
const { DAY_MS, daysBetween, ordersOf, paginate, who } = require('../util');

const MIN_RISK_DAYS = 30;

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return n >= 1 ? n : fallback;
}

// The customer's order history as one row, or null when too few orders
function profile(c, office, minOrders, now) {
  const orders = ordersOf(c, office);
  if (!orders.length || orders.length < minOrders) return null;
  const first = orders[0];
  const last = orders[orders.length - 1];
  // Average days between consecutive orders; none with a single order
  const gap = orders.length > 1 ? (last.at - first.at) / DAY_MS / (orders.length - 1) : null;
  return {
    ...who(c),
    orders: orders.length,
    valueCents: orders.reduce((sum, o) => sum + o.valueCents, 0),
    firstOrderAt: first.at,
    lastOrderAt: last.at,
    daysSince: daysBetween(last.at, now),
    avgGapDays: gap === null ? null : Math.round(gap * 10) / 10,
    gap,
  };
}

function classify(row, days) {
  if (row.daysSince > days) return 'lost';
  if (row.daysSince > Math.max(2 * (row.gap || 0), MIN_RISK_DAYS)) return 'atRisk';
  return null;
}

const SORTS = {
  value: (a, b) => b.valueCents - a.valueCents,
  recent: (a, b) => b.lastOrderAt - a.lastOrderAt,
  orders: (a, b) => b.orders - a.orders,
};

module.exports = function churn(dataset, query = {}) {
  const now = query.now || new Date();
  const days = positiveInt(query.days, 90);
  const minOrders = positiveInt(query.minOrders, 2);
  const kind = query.kind === 'atRisk' ? 'atRisk' : 'lost';
  const sort = SORTS[query.sort] || SORTS.value;
  const summary = { lost: { customers: 0, valueCents: 0 }, atRisk: { customers: 0, valueCents: 0 } };
  const rows = [];

  for (const c of dataset.customers) {
    const row = profile(c, query.office, minOrders, now);
    const group = row && classify(row, days);
    if (!group) continue;
    summary[group].customers += 1;
    summary[group].valueCents += row.valueCents;
    if (group === kind) rows.push(row);
  }

  // Ties: more value first, then by id so pages stay stable
  rows.sort((a, b) => sort(a, b) || b.valueCents - a.valueCents || a.id.localeCompare(b.id));
  const page = paginate(rows, query);
  return {
    days, minOrders, kind,
    lost: summary.lost,
    atRisk: summary.atRisk,
    ...page,
    rows: page.rows.map(({ gap, ...row }) => row),
  };
};
