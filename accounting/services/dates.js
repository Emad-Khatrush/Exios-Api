const moment = require('moment-timezone');

// The accounting day is the day in Libya, not on the UTC server, so late-night
// operations do not slip into the next day or month.
const TZ = 'Africa/Tripoli';
const DAY_FORMAT = 'YYYY-MM-DD';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (value) => typeof value === 'string' && DAY_PATTERN.test(value) && moment.tz(value, DAY_FORMAT, true, TZ).isValid();

// A plain YYYY-MM-DD is already a Libya day; anything else is an instant converted to Libya time
function toDay(value = new Date()) {
  if (isDay(value)) return value;
  const date = moment(value);
  if (!date.isValid()) throw new Error(`Invalid date: ${value}`);
  return date.tz(TZ).format(DAY_FORMAT);
}

const dayStart = (day) => moment.tz(day, DAY_FORMAT, TZ).startOf('day').toDate();
const dayEnd = (day) => moment.tz(day, DAY_FORMAT, TZ).endOf('day').toDate();
const addDays = (day, count) => moment.tz(day, DAY_FORMAT, TZ).add(count, 'days').format(DAY_FORMAT);
const today = () => toDay(new Date());
const yearOf = (day) => day.slice(0, 4);
const monthOf = (day) => day.slice(0, 7);

module.exports = { TZ, isDay, toDay, dayStart, dayEnd, addDays, today, yearOf, monthOf };
