// loyalty: customers with 1+ order (in the office filter), grouped by their points: redeemed
// (spent some), earnedOnly (earned, never spent), none. Lifetime figures: repeat = 2+ orders;
// lost = last order more than 90 days ago (as the churn section counts days).
const { daysBetween, ordersOf, ratio } = require('../util');

const LOST_DAYS = 90;
const GROUPS = [
  { key: 'redeemed', label: 'استعملوا نقاطاً' },
  { key: 'earnedOnly', label: 'كسبوا ولم يستعملوا' },
  { key: 'none', label: 'بدون نقاط' },
];

const round = (x) => (x == null ? null : Math.round(x));

function groupOf(points) {
  if (points?.redeemed > 0) return 'redeemed';
  if (points?.earned > 0) return 'earnedOnly';
  return 'none';
}

module.exports = function loyalty(dataset, query = {}) {
  const now = query.now || new Date();
  const acc = Object.fromEntries(GROUPS.map((g) => [g.key, { customers: 0, repeat: 0, orders: 0, valueCents: 0, lost: 0 }]));

  for (const c of dataset.customers) {
    const orders = ordersOf(c, query.office);
    if (!orders.length) continue;
    const g = acc[groupOf(c.loyalty)];
    g.customers += 1;
    if (orders.length >= 2) g.repeat += 1;
    g.orders += orders.length;
    for (const o of orders) g.valueCents += o.valueCents;
    if (daysBetween(orders[orders.length - 1].at, now) > LOST_DAYS) g.lost += 1;
  }

  return {
    groups: GROUPS.map(({ key, label }) => {
      const g = acc[key];
      return {
        key,
        label,
        customers: g.customers,
        repeatRate: ratio(g.repeat, g.customers),
        ordersPerCustomer: ratio(g.orders, g.customers),
        avgValueCents: round(ratio(g.valueCents, g.customers)),
        lostRate: ratio(g.lost, g.customers),
      };
    }),
  };
};
