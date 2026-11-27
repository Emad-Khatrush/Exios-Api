// conversion: of the accounts opened in the period, who placed an order and how fast.
// Any order counts (all offices, any date); an order dated before sign-up counts as 0 days.
const { period, monthKey, monthRange, daysBetween, inPeriod, median, ratio, paginate, who } = require('../util');

const group = () => ({ signups: 0, converted: 0, days: [] });
const summary = (g) => ({ signups: g.signups, converted: g.converted, rate: ratio(g.converted, g.signups), medianDays: median(g.days) });

module.exports = function conversion(dataset, query = {}) {
  const now = query.now || new Date();
  const p = period(query);
  const byMonth = new Map(monthRange(monthKey(p.from), monthKey(p.to)).map((m) => [m, { month: m, signups: 0, converted: 0 }]));
  const all = group();
  const sources = { invited: group(), direct: group() };
  const waiting = [];
  let within7 = 0;
  let within30 = 0;

  for (const c of dataset.customers) {
    if (!c.createdAt || !inPeriod(c.createdAt, p)) continue;
    const source = c.invited ? sources.invited : sources.direct;
    const month = byMonth.get(monthKey(c.createdAt));
    all.signups += 1;
    source.signups += 1;
    month.signups += 1;
    if (!c.orders.length) {
      waiting.push(c);
      continue;
    }
    const days = Math.max(daysBetween(c.createdAt, c.orders[0].at), 0);
    for (const g of [all, source]) {
      g.converted += 1;
      g.days.push(days);
    }
    month.converted += 1;
    if (days <= 7) within7 += 1;
    if (days <= 30) within30 += 1;
  }

  waiting.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const page = paginate(waiting, query);
  return {
    period: p,
    signups: all.signups,
    converted: all.converted,
    rate: ratio(all.converted, all.signups),
    medianDays: median(all.days),
    within7,
    within30,
    bySource: { invited: summary(sources.invited), direct: summary(sources.direct) },
    months: [...byMonth.values()].map((m) => ({ ...m, rate: ratio(m.converted, m.signups) })),
    waiting: { ...page, rows: page.rows.map((c) => ({ ...who(c), createdAt: c.createdAt, days: daysBetween(c.createdAt, now) })) },
  };
};
