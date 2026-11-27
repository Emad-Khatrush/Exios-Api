// mix — مزيج الخدمات: purchases vs shipments, air vs sea, by month, and who moved between methods.
const { period, inPeriod, ordersOf, monthKey, monthRange } = require('../util');

const bucket = () => ({ orders: 0, customers: 0, valueCents: 0 });

module.exports = function mix(dataset, query = {}) {
  const p = period(query);
  const office = query.office || null;

  const byKind = { purchase: bucket(), shipment: bucket() };
  const byMethod = { air: bucket(), sea: bucket(), unknown: bucket() };
  const months = new Map(monthRange(monthKey(p.from), monthKey(p.to)).map((month) => [month, { month, purchase: 0, shipment: 0, air: 0, sea: 0 }]));
  const transitions = { airFirst: 0, airThenSea: 0, seaFirst: 0, seaThenAir: 0 };
  let bothKinds = 0;

  for (const c of dataset.customers) {
    const own = ordersOf(c, office);
    const kinds = new Set();
    const methods = new Set();
    for (const o of own) {
      if (!inPeriod(o.at, p)) continue;
      const method = o.method || 'unknown';
      for (const b of [byKind[o.kind], byMethod[method]]) {
        b.orders += 1;
        b.valueCents += o.valueCents;
      }
      kinds.add(o.kind);
      methods.add(method);
      const row = months.get(monthKey(o.at));
      if (row) {
        row[o.kind] += 1;
        if (o.method) row[o.method] += 1;
      }
    }
    for (const k of kinds) byKind[k].customers += 1;
    for (const m of methods) byMethod[m].customers += 1;
    if (kinds.size === 2) bothKinds += 1;

    // Lifetime: the method of the first order that has one, and whether the other came later
    const first = own.findIndex((o) => o.method);
    if (first < 0) continue;
    const firstMethod = own[first].method;
    const other = firstMethod === 'air' ? 'sea' : 'air';
    const switched = own.slice(first + 1).some((o) => o.method === other);
    if (firstMethod === 'air') {
      transitions.airFirst += 1;
      if (switched) transitions.airThenSea += 1;
    } else {
      transitions.seaFirst += 1;
      if (switched) transitions.seaThenAir += 1;
    }
  }

  return { period: p, byKind, byMethod, bothKinds, months: [...months.values()], transitions };
};
