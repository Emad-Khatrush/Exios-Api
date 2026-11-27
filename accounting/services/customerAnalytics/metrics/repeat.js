// repeat: how many of the period's customers ordered again, and how many came back from before.
const { period, monthKey, monthRange, inPeriod, ordersOf, ratio } = require('../util');

const emptyMonth = (month) => ({ month, customers: 0, newCustomers: 0, returning: 0 });

// One customer's orders inside the period: how many, and in which months
function periodOrders(orders, p) {
  let count = 0;
  const months = new Set();
  for (const o of orders) {
    if (!inPeriod(o.at, p)) continue;
    count += 1;
    months.add(monthKey(o.at));
  }
  return { count, months };
}

module.exports = function repeat(dataset, query = {}) {
  const p = period(query);
  const byMonth = new Map(monthRange(monthKey(p.from), monthKey(p.to)).map((m) => [m, emptyMonth(m)]));
  const totals = { customers: 0, repeat: 0, returning: 0, newCustomers: 0 };

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    if (!orders.length) continue;
    const { count, months } = periodOrders(orders, p);
    if (!count) continue;
    totals.customers += 1;
    if (count >= 2) totals.repeat += 1;
    // Orders are oldest first: the first one decides new vs returning (within the office filter)
    if (orders[0].at < p.from) totals.returning += 1;
    else totals.newCustomers += 1;
    const firstMonth = monthKey(orders[0].at);
    for (const m of months) {
      const row = byMonth.get(m);
      row.customers += 1;
      if (m === firstMonth) row.newCustomers += 1;
      else row.returning += 1; // had an order in an earlier month
    }
  }

  return {
    period: p,
    customers: totals.customers,
    repeat: totals.repeat,
    repeatRate: ratio(totals.repeat, totals.customers),
    returning: totals.returning,
    newCustomers: totals.newCustomers,
    returningRate: ratio(totals.returning, totals.customers),
    months: [...byMonth.values()].map((row) => ({ ...row, returningRate: ratio(row.returning, row.customers) })),
  };
};
