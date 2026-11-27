// cac — تكلفة جلب العميل: what each new customer cost (marketing and the points given to newcomers and
// their inviters) against what they ordered in their first 90 days. Costs are company-wide; the
// office filter only picks the new customers.
const { DAY_MS, period, inPeriod, monthKey, monthRange, ordersOf, ratio } = require('../util');

const round = (x) => (x == null ? null : Math.round(x));
const NOTE = 'تكلفة العميل = (التسويق + نقاط الهدايا للعملاء الجدد ومن دعاهم) ÷ العملاء الجدد. '
  + 'العميل الجديد = أول طلب له في ذلك الشهر. العمولات معروضة وحدها (ليست كلها لجلب العملاء)، والشحن المجاني معروض ولا يدخل في الحساب. '
  + 'التكاليف للشركة كلها لكل شهر كامل ولا تتأثر بالمكتب. قيمة 90 يوماً = ما طلبه العملاء الجدد في أول 90 يوماً (قد لا تكتمل للأشهر الأخيرة).';

module.exports = function cac(dataset, query = {}) {
  const p = period(query);
  const office = query.office || null;
  const costs = dataset.costs || {};
  const cost = (kind, month) => Number(costs[kind]?.[month] || 0);

  const months = new Map(monthRange(monthKey(p.from), monthKey(p.to)).map((month) => [month, {
    month,
    marketingCents: cost('marketing', month),
    giftsCents: cost('gifts', month),
    commissionsCents: cost('commissions', month),
    freeShippingCents: 0,
    newCustomers: 0,
    value90Cents: 0,
  }]));

  for (const c of dataset.customers) {
    // Free shipping given on every order of the period (company-wide, as the costs)
    for (const o of c.orders) {
      if (o.freeShippingCents && inPeriod(o.at, p)) months.get(monthKey(o.at)).freeShippingCents += o.freeShippingCents;
    }
    const own = ordersOf(c, office);
    const first = own[0];
    if (!first || !inPeriod(first.at, p)) continue;
    const m = months.get(monthKey(first.at));
    m.newCustomers += 1;
    const end = first.at.getTime() + 90 * DAY_MS;
    for (const o of own) {
      if (o.at.getTime() >= end) break;
      m.value90Cents += o.valueCents;
    }
  }

  const rows = [...months.values()];
  const total = (key) => rows.reduce((s, m) => s + m[key], 0);
  const marketingCents = total('marketingCents');
  const giftsCents = total('giftsCents');
  const commissionsCents = total('commissionsCents');
  const newCustomers = total('newCustomers');
  const value90Cents = total('value90Cents');

  return {
    period: p,
    totals: {
      marketingCents,
      giftsCents,
      commissionsCents,
      newCustomers,
      cacCents: round(ratio(marketingCents + giftsCents, newCustomers)),
      cacWithCommissionsCents: round(ratio(marketingCents + giftsCents + commissionsCents, newCustomers)),
      value90Cents,
      avgValue90Cents: round(ratio(value90Cents, newCustomers)),
      // avgValue90 / cac = value90 / acquisition costs (null without new customers or costs)
      valueToCac: newCustomers ? ratio(value90Cents, marketingCents + giftsCents) : null,
    },
    months: rows.map(({ value90Cents: v, ...m }) => ({
      ...m,
      cacCents: round(ratio(m.marketingCents + m.giftsCents, m.newCustomers)),
      avgValue90Cents: round(ratio(v, m.newCustomers)),
    })),
    note: NOTE,
  };
};
