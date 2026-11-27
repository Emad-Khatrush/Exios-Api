// geo — المدن والمكاتب: the period's customers and value by the customer's city and by the order's office.
// Not filtered by office: the offices are what it compares.
const { period, inPeriod, ratio } = require('../util');

// By value, then customers; a missing name last
const byValue = (key) => (a, b) => b.valueCents - a.valueCents || b.customers - a.customers
  || (a[key] == null) - (b[key] == null) || String(a[key] ?? '').localeCompare(String(b[key] ?? ''));

module.exports = function geo(dataset, query = {}) {
  const p = period(query);
  const cities = new Map();
  const offices = new Map();
  let total = 0;
  const row = (map, key, fields) => {
    if (!map.has(key)) map.set(key, fields);
    return map.get(key);
  };

  for (const c of dataset.customers) {
    const city = c.city || null;
    const seenOffices = new Set();
    let n = 0;
    let cents = 0;
    for (const o of c.orders) {
      if (!inPeriod(o.at, p)) continue;
      n += 1;
      cents += o.valueCents;
      const office = row(offices, o.office || null, { office: o.office || null, customers: 0, orders: 0, valueCents: 0 });
      office.orders += 1;
      office.valueCents += o.valueCents;
      if (!seenOffices.has(office)) {
        seenOffices.add(office);
        office.customers += 1;
      }
    }
    if (!n) continue;
    total += cents;
    const r = row(cities, city, { city, customers: 0, orders: 0, valueCents: 0, newCustomers: 0 });
    r.customers += 1;
    r.orders += n;
    r.valueCents += cents;
    // New: the customer's first order ever is in the period
    if (inPeriod(c.orders[0].at, p)) r.newCustomers += 1;
  }

  const withShare = (r) => ({ ...r, share: ratio(r.valueCents, total) });
  return {
    period: p,
    cities: [...cities.values()].sort(byValue('city')).map(withShare),
    offices: [...offices.values()].sort(byValue('office')).map(withShare),
  };
};
