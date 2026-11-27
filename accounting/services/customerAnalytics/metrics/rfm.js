// rfm — شرائح العملاء: recency, frequency and value scored 1..5 by quintile, then named segments.
const { daysBetween, ordersOf, ratio, paginate, who } = require('../util');

const SEGMENTS = [
  { key: 'champions', label: 'الأبطال' },
  { key: 'loyal', label: 'الأوفياء' },
  { key: 'promising', label: 'جدد واعدون' },
  { key: 'needAttention', label: 'يحتاجون اهتماماً' },
  { key: 'atRisk', label: 'في خطر الفقدان' },
  { key: 'hibernating', label: 'نائمون' },
  { key: 'lost', label: 'مفقودون' },
];

// The segment of R and F scores; first match wins
function segmentOf(r, f) {
  if (r >= 4 && f >= 4) return 'champions';
  if (f >= 4 || (r >= 3 && f >= 3)) return 'loyal';
  if (r >= 4 && f <= 2) return 'promising';
  if (r === 3) return 'needAttention';
  if (r <= 2 && f >= 3) return 'atRisk';
  if (r === 2) return 'hibernating';
  return 'lost';
}

// Quintile score of each value (5 = best). A value scores by how many values are worse than it,
// so equal values share a score: 1 + floor(5 × worse / n).
function scores(values, { lowerIsBetter = false } = {}) {
  const n = values.length;
  const sorted = values.map((v) => (lowerIsBetter ? -v : v)).sort((a, b) => a - b);
  const worse = new Map();
  sorted.forEach((v, i) => { if (!worse.has(v)) worse.set(v, i); });
  return values.map((v) => Math.min(5, 1 + Math.floor((5 * worse.get(lowerIsBetter ? -v : v)) / n)));
}

function rfm(dataset, query = {}) {
  const now = query.now || new Date();
  const office = query.office || null;

  const rows = [];
  for (const c of dataset.customers) {
    const own = ordersOf(c, office);
    if (!own.length) continue;
    rows.push({
      c,
      recencyDays: daysBetween(own[own.length - 1].at, now),
      orders: own.length,
      valueCents: own.reduce((s, o) => s + o.valueCents, 0),
    });
  }
  const r = scores(rows.map((x) => x.recencyDays), { lowerIsBetter: true });
  const f = scores(rows.map((x) => x.orders));
  const m = scores(rows.map((x) => x.valueCents));
  rows.forEach((x, i) => Object.assign(x, { r: r[i], f: f[i], m: m[i], segment: segmentOf(r[i], f[i]) }));

  const segments = SEGMENTS.map(({ key, label }) => {
    const of = rows.filter((x) => x.segment === key);
    return {
      key,
      label,
      customers: of.length,
      share: ratio(of.length, rows.length),
      valueCents: of.reduce((s, x) => s + x.valueCents, 0),
      avgRecencyDays: ratio(of.reduce((s, x) => s + x.recencyDays, 0), of.length),
      avgOrders: ratio(of.reduce((s, x) => s + x.orders, 0), of.length),
    };
  });

  const segment = SEGMENTS.some((s) => s.key === query.segment) ? query.segment : 'champions';
  const list = rows
    .filter((x) => x.segment === segment)
    .sort((a, b) => b.valueCents - a.valueCents || a.c.id.localeCompare(b.c.id))
    .map((x) => ({ ...who(x.c), recencyDays: x.recencyDays, orders: x.orders, valueCents: x.valueCents, r: x.r, f: x.f, m: x.m, segment: x.segment }));

  return { segments, segment, list: paginate(list, query) };
}

module.exports = rfm;
module.exports.segmentOf = segmentOf;
module.exports.scores = scores;
module.exports.SEGMENTS = SEGMENTS;
