// ratings: the customers' ratings beside whether they still order. Over customers with 1+ order
// (in the office filter). Status by the churn section's rules and defaults: lost = last order more
// than 90 days ago, atRisk = silent longer than max(2 x their average gap, 30 days); both need
// 2+ orders; everyone else is active. Averages are over every rating (weighted by count).
const { DAY_MS, daysBetween, ordersOf, ratio, paginate, who } = require('../util');

const LOST_DAYS = 90;
const MIN_ORDERS = 2;
const MIN_RISK_DAYS = 30;
const LOW = 3;
const STATUSES = ['active', 'atRisk', 'lost'];

function statusOf(orders, now) {
  if (orders.length < MIN_ORDERS) return 'active';
  const first = orders[0].at;
  const last = orders[orders.length - 1].at;
  const since = daysBetween(last, now);
  if (since > LOST_DAYS) return 'lost';
  const gap = (last - first) / DAY_MS / (orders.length - 1);
  return since > Math.max(2 * gap, MIN_RISK_DAYS) ? 'atRisk' : 'active';
}

const empty = () => ({ customers: 0, rated: 0, count: 0, sum: 0 });
const add = (g, rating) => {
  g.rated += 1;
  g.count += rating.count;
  g.sum += rating.avg * rating.count;
};

module.exports = function ratings(dataset, query = {}) {
  const now = query.now || new Date();
  const all = empty();
  const groups = Object.fromEntries(STATUSES.map((s) => [s, empty()]));
  const low = [];

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    if (!orders.length) continue;
    const status = statusOf(orders, now);
    groups[status].customers += 1;
    const rating = c.rating && c.rating.count > 0 ? c.rating : null;
    if (!rating) continue;
    add(all, rating);
    add(groups[status], rating);
    if (rating.avg <= LOW) {
      low.push({ ...who(c), rating: rating.avg, count: rating.count, status, lastOrderAt: orders[orders.length - 1].at });
    }
  }

  // Lowest first; ties: more ratings first, then by id so pages stay stable
  low.sort((a, b) => a.rating - b.rating || b.count - a.count || a.id.localeCompare(b.id));
  return {
    rated: all.rated,
    avgRating: ratio(all.sum, all.count),
    byStatus: STATUSES.map((status) => ({
      status, customers: groups[status].customers, rated: groups[status].rated, avgRating: ratio(groups[status].sum, groups[status].count),
    })),
    low: paginate(low, query),
  };
};
