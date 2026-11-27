// Customer and sales analyses (owner 2026-11-27). Each section is a pure function of the dataset
// (dataset.js) and the query; see CONTRACT.md for what each one returns.
const ErrorHandler = require('../../../utils/errorHandler');
const moment = require('moment-timezone');
const { loadDataset } = require('./dataset');
const { insightsFor } = require('./insights');
const { TZ, period, who } = require('./util');

const SECTIONS = {
  repeat: () => require('./metrics/repeat'),
  cohorts: () => require('./metrics/cohorts'),
  churn: () => require('./metrics/churn'),
  conversion: () => require('./metrics/conversion'),
  value: () => require('./metrics/value'),
  rfm: () => require('./metrics/rfm'),
  mix: () => require('./metrics/mix'),
  geo: () => require('./metrics/geo'),
  staff: () => require('./metrics/staff'),
  delivery: () => require('./metrics/delivery'),
  ratings: () => require('./metrics/ratings'),
  loyalty: () => require('./metrics/loyalty'),
  cac: () => require('./metrics/cac'),
  'companies-suggest': () => companiesSuggest,
};

// The sections that also show the period just before (compare)
const COMPARED = new Set(['repeat', 'value', 'conversion', 'mix', 'cac', 'staff', 'delivery']);

// Candidates to mark as company accounts: the 20 customers with most orders (lifetime)
function companiesSuggest(dataset) {
  const rows = dataset.customers
    .filter((c) => c.orders.length)
    .map((c) => ({ ...who(c), isCompany: !!c.isCompany, orders: c.orders.length, valueCents: c.orders.reduce((s, o) => s + o.valueCents, 0) }))
    .sort((a, b) => b.orders - a.orders || b.valueCents - a.valueCents || a.id.localeCompare(b.id));
  return { rows: rows.slice(0, 20) };
}

// companies=exclude: the dataset without the company accounts, built once per dataset
const withoutCompanies = new WeakMap();
function excludeCompanies(data) {
  if (!withoutCompanies.has(data)) {
    withoutCompanies.set(data, { ...data, customers: data.customers.filter((c) => !c.isCompany) });
  }
  return withoutCompanies.get(data);
}

// The first date there is data for: the first order, or for conversion the first sign-up. Kept on
// the dataset (it is read again only every few minutes).
function firstDate(data, section) {
  const key = section === 'conversion' ? 'firstSignup' : 'firstOrder';
  if (!(key in data)) {
    let firstOrder = null;
    let firstSignup = null;
    for (const c of data.customers) {
      if (c.orders.length && (!firstOrder || c.orders[0].at < firstOrder)) firstOrder = c.orders[0].at;
      if (c.createdAt && (!firstSignup || c.createdAt < firstSignup)) firstSignup = c.createdAt;
    }
    Object.assign(data, { firstOrder, firstSignup });
  }
  return data[key];
}

// Without a `from`, the default 12 months start no earlier than the data does (the orders only start
// in April 2026: the months before were all empty rows)
function withDataStart(data, section, query, now) {
  if (query.from) return query;
  const first = firstDate(data, section);
  if (!first) return query;
  const start = moment(first).tz(TZ).startOf('month');
  if (start.toDate() <= period({ now }).from) return query;
  return { ...query, from: start.format('YYYY-MM-DD') };
}

// Cohorts before the first one with customers say nothing
function trimCohorts(result) {
  if (!Array.isArray(result.cohorts)) return result;
  const first = result.cohorts.findIndex((c) => c.size > 0);
  const cohorts = first > 0 ? result.cohorts.slice(first) : result.cohorts;
  // Nor do the averages of months no cohort shown has reached
  const width = Math.max(0, ...cohorts.map((c) => c.rates.length));
  return { ...result, cohorts, ...(Array.isArray(result.average) && { average: result.average.slice(0, width) }) };
}

const isNumber = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// A section's answer reduced to its numbers: the top level and one level of nested numbers (no
// arrays, no lists)
function numbersOf(result) {
  const out = {};
  for (const [key, v] of Object.entries(result)) {
    if (key === 'period') continue;
    if (isNumber(v)) out[key] = v;
    else if (isPlainObject(v) && !Array.isArray(v.rows)) {
      const nested = Object.fromEntries(Object.entries(v).filter(([, x]) => isNumber(x)));
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

// The period of equal length (in Libya days) just before the one the section used
function previousPeriod(p) {
  const from = moment(p.from).tz(TZ).startOf('day');
  const days = moment(p.to).tz(TZ).startOf('day').diff(from, 'days') + 1;
  const to = from.clone().subtract(1, 'day');
  return { from: to.clone().subtract(days - 1, 'days').format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') };
}

const isOff = (v) => v === '0' || v === 'false' || v === 0 || v === false;

async function run(section, query = {}, { now = new Date(), dataset } = {}) {
  const load = SECTIONS[section];
  if (!load) throw new ErrorHandler(404, 'تحليل غير معروف');
  const loaded = dataset || await loadDataset({ fresh: query.fresh === '1' || query.fresh === 'true' });
  const data = query.companies === 'exclude' ? excludeCompanies(loaded) : loaded;
  const metric = load();
  const result = trimCohorts(metric(data, { ...withDataStart(data, section, query, now), now }));
  const out = { ...result, targets: loaded.targets || {}, builtAt: loaded.builtAt };
  if (COMPARED.has(section) && !isOff(query.compare) && result.period?.from && result.period?.to) {
    const before = previousPeriod(result.period);
    out.previous = { period: before, ...numbersOf(metric(data, { ...query, ...before, now })) };
  }
  // The analyst's reading (owner 2026-11-27): rules and benchmarks, see insights.js
  if (!isOff(query.insights)) {
    const insights = insightsFor(section, out, { targets: out.targets });
    if (insights) out.insights = insights;
  }
  return out;
}

module.exports = { run, SECTIONS: Object.keys(SECTIONS) };
