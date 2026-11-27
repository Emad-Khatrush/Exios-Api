# Customer analytics: what each section returns

`GET /api/analytics/customers/:section?…` (permission `customer_analytics`; admins and owners always).
Every answer also carries `builtAt` (when the data was read; it is kept 10 minutes, `fresh=1` reads again).

Each section is `module.exports = function (dataset, query)` in `metrics/<section>.js`, pure (no
database): `dataset.customers` is `[{ id, name, customerId, phone, city, createdAt, invited, orders }]`
and each order `{ id, at: Date, kind: 'purchase'|'shipment', method: 'air'|'sea'|null, office, purchaseCents, shippingCents, valueCents }`,
oldest first (see dataset.js). `query` holds the query string (strings) and `now` (a Date).

Common query: `from`, `to` ('YYYY-MM-DD', Libya days; default: the last 12 whole months and the
current one, `util.period`), `office` ('tripoli' | 'benghazi' | …; empty = all; keeps only that
office's orders, `util.ordersOf`). Money is in US cents. Rates are 0..1 or `null` when there is
nothing to divide by. Months are 'YYYY-MM' (Libya time). Lists are paged with `page`/`limit` via
`util.paginate` → `{ total, page, limit, rows }`. A customer in a list carries `util.who(c)`:
`{ id, name, customerId, phone, city }`.

## repeat — نسبة رجوع العملاء
Query: from, to, office.
```
{ period: { from, to },
  customers,          // customers with ≥1 order in the period
  repeat,             // of them, with ≥2 orders in the period
  repeatRate,         // repeat / customers
  returning,          // of them, who also ordered before the period
  newCustomers,       // of them, whose first order ever (in this office filter) is in the period
  returningRate,      // returning / customers
  months: [{ month, customers, newCustomers, returning, returningRate }] }  // each month of the period; returning = had an order before that month
```

## cohorts — الاحتفاظ حسب شهر أول طلب
Query: months (how many cohorts, default 12, max 36), office.
Cohort = month of the customer's first order. Offsets 0..N where N = months since the oldest cohort shown.
```
{ cohorts: [{ month, size, retained: [n0, n1, …], rates: [1, r1, …] }],  // retained[k] = customers of the cohort with an order in month+k; arrays stop at the current month
  average: [ { offset, rate, cohorts } ] }   // weighted by size, over the cohorts that reached that offset
```

## churn — العملاء الخاملون
Query: days (default 90), minOrders (default 2), kind ('lost' default | 'atRisk'), office, page, limit, sort ('value' default | 'recent' | 'orders').
lost = last order more than `days` ago, ≥ minOrders orders. atRisk = not lost, ≥ minOrders orders, days since last order > max(2 × their average gap between orders, 30).
```
{ days, minOrders, kind,
  lost: { customers, valueCents },      // valueCents = lifetime value of those customers
  atRisk: { customers, valueCents },
  total, page, limit,
  rows: [{ ...who, orders, valueCents, firstOrderAt, lastOrderAt, daysSince, avgGapDays }] }
```

## conversion — من التسجيل إلى أول طلب
Query: from, to (on the account's createdAt). Not filtered by office.
```
{ period: { from, to },
  signups, converted, rate,           // converted = has any order
  medianDays,                         // days from sign-up to first order (orders before sign-up: 0)
  within7, within30,                  // converted within 7 / 30 days
  bySource: { invited: { signups, converted, rate, medianDays }, direct: { … } },
  months: [{ month, signups, converted, rate }],
  waiting: { total, page, limit, rows: [{ ...who, createdAt, days }] } }  // signed up in the period, no order yet, newest first
```

## value — قيمة العميل
Query: from, to, office.
```
{ period: { from, to },
  orders, customers, valueCents,
  avgOrderCents, ordersPerCustomer, avgCustomerCents,          // in the period
  perYear: { ordersPerCustomer },                              // period orders per customer, scaled to 365 days
  ltv: { avgCents, medianCents, buckets: [{ label, minCents, maxCents, customers }] },  // lifetime, customers with ≥1 order; buckets: <100$, 100–500$, 500–2,000$, 2,000–10,000$, ≥10,000$ (maxCents null on the last)
  top: [{ ...who, orders, valueCents, share }],               // top 20 by value in the period; share of the period's value
  concentration: { top10Share, top20Share, top10PercentShare } }
```

## rfm — شرائح العملاء
Query: office, segment (for the list), page, limit.
Over customers with ≥1 order (lifetime). R = days since last order, F = orders, M = value. Each scored
1..5 by quintile (5 best: most recent, most orders, most value; ties get the same score).
Segments, first match wins:
- champions «الأبطال»: R≥4 and F≥4
- loyal «الأوفياء»: F≥4 (or R≥3 and F≥3)
- promising «جدد واعدون»: R≥4 and F≤2
- needAttention «يحتاجون اهتماماً»: R=3
- atRisk «في خطر الفقدان»: R≤2 and F≥3
- hibernating «نائمون»: R=2
- lost «مفقودون»: everything else
```
{ segments: [{ key, label, customers, share, valueCents, avgRecencyDays, avgOrders }],   // all seven, in the order above
  segment, list: { total, page, limit, rows: [{ ...who, recencyDays, orders, valueCents, r, f, m, segment }] } }  // the asked segment (default champions), by value
```

## mix — مزيج الخدمات
Query: from, to, office.
```
{ period: { from, to },
  byKind: { purchase: { orders, customers, valueCents }, shipment: { … } },
  byMethod: { air: { orders, customers, valueCents }, sea: { … }, unknown: { … } },
  bothKinds,                                   // customers with a purchase and a shipment in the period
  months: [{ month, purchase, shipment, air, sea }],   // order counts
  transitions: { airFirst, airThenSea, seaFirst, seaThenAir } }   // lifetime: first method, and who later used the other one
```

## geo — المدن والمكاتب
Query: from, to.
```
{ period: { from, to },
  cities: [{ city, customers, orders, valueCents, newCustomers, share }],   // city null = «غير محدد»; by valueCents desc
  offices: [{ office, customers, orders, valueCents, share }] }            // order office (null = غير محدد)
```

---

# Second round (owner 2026-11-27)

Dataset additions (dataset.js): each order also has `madeBy` (staff or customer user id, or null),
`freeShippingCents` (what free shipping gave away), `packages: [{ id, arrivedAt, deliveredAt }]`
(registered at our warehouse abroad; handed to the customer = first revenue recognition of its
shipping, or null). Each customer also has `isCompany`, `rating: { count, avg } | null`,
`loyalty: { earned, redeemed }` (points; 1 point = 1 cent). The dataset also has `staff: Map(id -> name)`,
`costs: { marketing, commissions, gifts }` each `{ 'YYYY-MM': cents }` and `targets` (settings).
Production has the marketing/points data even where a local copy does not: build for it.

## Common additions (index.js)
- `compare` (default on; `compare=0` off): sections repeat, value, conversion, mix, cac, staff,
  delivery get `previous`: the same section over the period of equal length just before
  (`from`/`to` shifted back), reduced to its top-level numbers and one level of nested numbers
  (no arrays, no lists). The UI shows the change beside each tile.
- `companies=exclude`: company accounts (settings) are left out of every section (default: kept).
- `limit=all` on any paged list: every row (cap 20,000), for the full export.
- `targets` on every answer: the saved targets (see settings).

## staff — موظفو المبيعات وجودة عملائهم
Query: from, to, office. A customer "belongs" to the staff member who opened their FIRST order ever
(`madeBy` of that order, when it is in `dataset.staff`; else bucket `app` = opened by the customer
or unknown). Only customers whose first order is in the period.
```
{ period, rows: [{ staffId | 'app', name, newCustomers, returned, returnRate,      // returned = ≥2 orders ever
                   value90Cents, avgValue90Cents,                                   // their orders in the 90 days from their first
                   lost }] }                                                        // of them, no order for 90+ days now
```
by newCustomers desc. `name` for app = «التطبيق / غير معروف».

## delivery — مدة التوصيل وأثرها
Query: from, to (on the package's deliveredAt), office.
Days = deliveredAt − arrivedAt (packages with both; negatives dropped).
```
{ period, packages, medianDays, avgDays, p90Days,
  byMethod: { air: { packages, medianDays }, sea: {…}, unknown: {…} },
  months: [{ month, packages, medianDays }],
  buckets: [{ label, minDays, maxDays, packages }],          // 0–7, 8–14, 15–30, 31–60, >60
  effect: [{ label, customers, returned, returnRate }] }     // customers by the delivery days of their FIRST delivered package (same buckets): did they order again after it?
```

## ratings — التقييمات والتوقف
Query: none besides office/companies.
```
{ rated, avgRating,
  byStatus: [{ status: 'active'|'atRisk'|'lost', customers, rated, avgRating }],   // churn definitions of the churn section, defaults
  low: { total, page, limit, rows: [{ ...who, rating, count, status, lastOrderAt }] } }   // avg ≤ 3, lowest first
```

## loyalty — أثر النقاط
Query: office.
Groups of customers with ≥1 order: `redeemed` (spent points), `earnedOnly` (earned, never spent), `none`.
```
{ groups: [{ key, label, customers, repeatRate, ordersPerCustomer, avgValueCents, lostRate }] }
```
labels: «استعملوا نقاطاً», «كسبوا ولم يستعملوا», «بدون نقاط».

## cac — تكلفة جلب العميل
Query: from, to, office (office only filters new customers; costs are company-wide).
New customer = first order ever in that month.
```
{ period,
  totals: { marketingCents, giftsCents, commissionsCents, newCustomers, cacCents, cacWithCommissionsCents, value90Cents, avgValue90Cents, valueToCac },
  months: [{ month, marketingCents, giftsCents, commissionsCents, freeShippingCents, newCustomers, cacCents, avgValue90Cents }],
  note }   // cacCents = (marketing + gifts) / newCustomers; value90 = what the new customers ordered in their first 90 days; valueToCac = avgValue90 / cac
```
`freeShippingCents` = free shipping given on all orders that month (shown, not in cac).

## settings — الأهداف وحسابات الشركات
`GET /analytics/customers-settings` → `{ targets: { [key]: number }, companies: [{ id, name, customerId }] }`
`PUT /analytics/customers-settings` body `{ targets?, companies?: [userId] }` (permission customer_analytics) → same as GET; clears the dataset cache.
Target keys (rates 0..1, money cents, days): repeatRate, returningRate, month1Retention, conversionRate, medianDaysToFirstOrder,
lostCustomers, atRiskCustomers, avgOrderCents, ordersPerCustomer, cacCents, valueToCac, medianDeliveryDays, avgRating.
`GET /analytics/customers/companies-suggest` → `{ rows: [{ ...who, orders, valueCents }] }` the 20 customers with most orders (candidates to mark).

## campaign from a list
`POST /api/sendMessagesToClients` accepts `target: 'customList'` with `userIds: [id]` (max 5,000): the
campaign goes to those clients (same filters: not cancelled, has a phone). Needs the `marketing`
permission as before.

---

# Third round: the analyst («المحلل الذكي», owner 2026-11-27)

Not an LLM: a rule engine (`insights.js`) that reads each section's answer (with `previous` and
`targets`) and applies benchmarks and playbooks taken from published sources (listed in `sources`).
Every section answer gets `insights` (unless `insights=0`):
```
insights: {
  title, titleEn,                 // e.g. «رجوع العملاء», 'Repeat Purchase Rate'
  headline,                       // one Arabic sentence: the most important thing
  summary: [string],              // 2–4 short Arabic sentences: what the numbers say
  indicators: [{ key, label, labelEn, value,          // value: formatted text (e.g. '81%', '$1,246', '24 يوم')
                 status: 'good'|'warn'|'bad'|'info',
                 benchmark,                          // Arabic text: the reference and where it comes from, or null
                 target }],                          // text when a target is set, else null
  actions: [{ priority: 'high'|'medium'|'low', text }],   // what to do, most important first
  sources: [{ label, url }],
  method: string }                // one line: how the analyst decided (rules + benchmarks, not a guess)
```
