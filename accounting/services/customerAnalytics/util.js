// Shared helpers for the customer analyses. Months and days are Libya time.
const moment = require('moment-timezone');

const TZ = 'Africa/Tripoli';
const DAY_MS = 24 * 3600 * 1000;

const monthKey = (date) => moment(date).tz(TZ).format('YYYY-MM');
// 'YYYY-MM' + n months
const addMonths = (key, n) => moment.tz(`${key}-01`, TZ).add(n, 'months').format('YYYY-MM');
// Whole months from key a to key b (b after a: positive)
const monthsBetween = (a, b) => moment.tz(`${b}-01`, TZ).diff(moment.tz(`${a}-01`, TZ), 'months');
// Every month key from a to b, both included
function monthRange(a, b) {
  const out = [];
  for (let key = a; key <= b; key = addMonths(key, 1)) out.push(key);
  return out;
}
const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);

// The period asked for: from/to as Date ('YYYY-MM-DD' strings are whole Libya days, `to` included).
// Without them: the last 12 whole months and the current one.
function period({ from, to, now = new Date() } = {}) {
  const end = to ? moment.tz(String(to), TZ).endOf('day') : moment(now).tz(TZ).endOf('day');
  const start = from ? moment.tz(String(from), TZ).startOf('day') : moment(now).tz(TZ).subtract(12, 'months').startOf('month');
  return { from: start.toDate(), to: end.toDate() };
}
const inPeriod = (date, p) => date >= p.from && date <= p.to;

// A customer's orders, kept to one office when asked (office null/'' = all)
const ordersOf = (customer, office) => (office ? customer.orders.filter((o) => o.office === office) : customer.orders);

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const ratio = (part, whole) => (whole > 0 ? part / whole : null);

// A page of rows: { total, page, limit, rows }. limit=all: every row (at most ALL_CAP), for the full export
const ALL_CAP = 20000;
function paginate(rows, { page = 1, limit = 50 } = {}) {
  if (String(limit).toLowerCase() === 'all') return { total: rows.length, page: 1, limit: ALL_CAP, rows: rows.slice(0, ALL_CAP) };
  const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const current = Math.max(Number(page) || 1, 1);
  return { total: rows.length, page: current, limit: size, rows: rows.slice((current - 1) * size, current * size) };
}

// What a list row says about a customer
const who = (c) => ({ id: c.id, name: c.name, customerId: c.customerId, phone: c.phone, city: c.city });

module.exports = { TZ, DAY_MS, monthKey, addMonths, monthsBetween, monthRange, daysBetween, period, inPeriod, ordersOf, median, ratio, paginate, who };
