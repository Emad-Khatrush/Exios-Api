const moment = require('moment-timezone');
const Orders = require('../models/order');
const Inventory = require('../models/inventory');
const User = require('../models/user');
const SalesGoal = require('../models/salesGoal');
const ErrorHandler = require('../utils/errorHandler');

// Weeks and months are read in Libya time with Sunday-start weeks, the same as the Home dashboard
const TZ = 'Africa/Tripoli';
const METRICS = ['sales', 'air', 'lcl', 'fcl'];
const PERIODS = ['week', 'month'];
const HISTORY_LENGTH = 12;
const DAY = 'YYYY-MM-DD';

// Goals are set and tracked for these sales offices only (owner's request 2026-10-06)
const GOAL_OFFICES = ['tripoli', 'benghazi'];

// Where goods come from: a trip's shippedCountry. Shipping goals count goods from China only (owner's
// request 2026-10-06); sales count every country. Anything not from China is 'other' and only shows in
// the breakdown of China's share.
const COUNTRIES = ['CN'];
const COUNTRY_FILTERS = COUNTRIES;
const DEFAULT_COUNTRY = 'CN';

// The order's "from where" is typed freely, so it is read by the names people use for each country
const COUNTRY_WORDS = {
  // "صين" anywhere also covers the spellings people type: الصين، اصين، لصين
  CN: /china|chaina|\bcn\b|الصين|اصين|لصين|صين|guang|yiwu|shenzhen|shanghai|foshan|ningbo|beijing|hong\s?kong|قوانغ|غوانز|جوانز|ايوو|إيوو|شنزن|شنغهاي/i,
};

const countryFromText = (text) => COUNTRIES.find((code) => COUNTRY_WORDS[code].test(String(text || ''))) || 'other';
const countryOfTrip = (trip) => (COUNTRIES.includes(trip?.shippedCountry) ? trip.shippedCountry : 'other');

const round = (value, digits = 2) => Math.round((Number(value) || 0) * 10 ** digits) / 10 ** digits;
const emptyMetrics = () => ({ ...Object.fromEntries(METRICS.map((metric) => [metric, 0])), orders: 0 });
const addInto = (target, values) => { Object.keys(values).forEach((key) => { target[key] = (target[key] || 0) + values[key]; }); };

const periodLabel = (period, start, end) => (period === 'month'
  ? start.format('MMMM YYYY')
  : start.month() === end.month()
    ? `${start.format('D')} - ${end.format('D MMM YYYY')}`
    : `${start.format('D MMM')} - ${end.format('D MMM YYYY')}`);

const bounds = (period, anchor) => {
  const start = anchor.clone().startOf(period);
  const end = anchor.clone().endOf(period);
  return { start, end, key: start.format(DAY), label: periodLabel(period, start, end) };
};

// Everything the goal offices did between start and end, as flat rows:
// { day, office, country, madeBy, sales, orders, air, lcl, fcl }. One pass serves every view: the
// country breakdown, the leaderboard and an employee's own numbers.
// A package's country is that of the air or sea trip holding it (trips list their packages in
// `orders`); one not on a trip yet is placed by its order's "from where".
// Which air or sea trip holds each package: { packageId: { shippedCountry, seaType } }. Reading every
// trip's package list is the slowest part of the dashboard, so it is kept for two minutes.
const TRIP_MAP_TTL = 2 * 60 * 1000;
let tripMapCache = { at: 0, promise: null };
const tripsByPackage = () => {
  if (tripMapCache.promise && Date.now() - tripMapCache.at < TRIP_MAP_TTL) return tripMapCache.promise;
  const promise = Inventory.aggregate([
    { $match: { shippingType: { $in: ['air', 'sea'] }, inventoryType: { $ne: 'warehouseInventory' } } },
    { $project: { _id: 0, shippedCountry: 1, seaType: 1, packageIds: '$orders.paymentList._id' } },
  ]).then((trips) => {
    const map = new Map();
    trips.forEach(({ packageIds, ...trip }) => (packageIds || []).forEach((id) => { if (id) map.set(String(id), trip); }));
    return map;
  });
  tripMapCache = { at: Date.now(), promise };
  promise.catch(() => { tripMapCache = { at: 0, promise: null }; });
  return promise;
};

const actualRows = async (start, end) => {
  const range = { $gte: start.toDate(), $lte: end.toDate() };
  const tripOfPackage = await tripsByPackage();
  const dayOf = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });

  const [sales, packages, containers] = await Promise.all([
    Orders.aggregate([
      { $match: { unsureOrder: false, isCanceled: false, createdAt: range, placedAt: { $in: GOAL_OFFICES } } },
      { $group: {
        _id: { day: dayOf('$createdAt'), office: '$placedAt', from: '$shipment.fromWhere', madeBy: '$madeBy' },
        total: { $sum: '$totalInvoice' },
        orders: { $sum: 1 },
      } },
    ]),
    Orders.aggregate([
      { $match: { unsureOrder: false, isCanceled: false, placedAt: { $in: GOAL_OFFICES }, 'paymentList.deliveredPackages.arrivedAt': range } },
      { $unwind: '$paymentList' },
      { $match: { 'paymentList.deliveredPackages.arrivedAt': range } },
      { $project: {
        _id: {
          day: dayOf('$paymentList.deliveredPackages.arrivedAt'),
          office: '$placedAt',
          from: '$shipment.fromWhere',
          madeBy: '$madeBy',
          unit: '$paymentList.deliveredPackages.weight.measureUnit',
          packageId: '$paymentList._id',
        },
        total: '$paymentList.deliveredPackages.weight.total',
      } },
    ]),
    Inventory.aggregate([
      { $match: { shippingType: 'sea', seaType: 'fcl', createdAt: range, inventoryPlace: { $in: GOAL_OFFICES } } },
      { $group: { _id: { day: dayOf('$createdAt'), office: '$inventoryPlace', country: '$shippedCountry' }, count: { $sum: 1 } } },
    ]),
  ]);

  // One row per day, office, country and seller, so the sums below stay short
  const merged = new Map();
  const row = (id, country, values) => {
    const madeBy = id.madeBy ? String(id.madeBy) : null;
    const key = `${id.day}|${id.office}|${country}|${madeBy}`;
    if (!merged.has(key)) merged.set(key, { day: id.day, office: id.office, country, madeBy, ...emptyMetrics() });
    addInto(merged.get(key), values);
  };
  sales.forEach(({ _id, total, orders }) => row(_id, countryFromText(_id.from), { sales: total || 0, orders: orders || 0 }));
  packages.forEach(({ _id, total }) => {
    const trip = tripOfPackage.get(String(_id.packageId)) || null;
    const country = trip ? countryOfTrip(trip) : countryFromText(_id.from);
    // A package on a full-container trip is that container, not shared freight
    if (_id.unit === 'KG') row(_id, country, { air: total || 0 });
    else if (_id.unit === 'CBM' && trip?.seaType !== 'fcl') row(_id, country, { lcl: total || 0 });
  });
  containers.forEach(({ _id, count }) => row({ ...(_id), madeBy: null }, COUNTRIES.includes(_id.country) ? _id.country : 'other', { fcl: count || 0 }));
  return [...merged.values()];
};

// The same range asked again within a minute (switching weekly and monthly, going back and forth
// between periods) is answered from memory
const ROWS_TTL = 60 * 1000;
const rowsCache = new Map();
const cachedRows = (start, end) => {
  const key = `${start.format(DAY)}|${end.format(DAY)}`;
  const hit = rowsCache.get(key);
  if (hit && Date.now() - hit.at < ROWS_TTL) return hit.promise;
  rowsCache.forEach((value, k) => { if (Date.now() - value.at >= ROWS_TTL) rowsCache.delete(k); });
  const promise = actualRows(start, end);
  rowsCache.set(key, { at: Date.now(), promise });
  promise.catch(() => rowsCache.delete(key));
  return promise;
};

// Days are YYYY-MM-DD text, so a period is a text range: no date parsing per row
const keyOf = (date) => (typeof date === 'string' ? date : date.format(DAY));
const dayRange = (start, end) => {
  const from = keyOf(start);
  const to = keyOf(end);
  return (row) => row.day >= from && row.day <= to;
};

const matchesUser = (row, madeBy) => !madeBy || row.madeBy === String(madeBy);

// The country only narrows shipping (air, LCL, FCL); sales count every invoice, whatever the country
// (owner's request 2026-10-06)
const SHIPPING_METRICS = ['air', 'lcl', 'fcl'];
const valuesFor = (row, country) => {
  const { day, office, country: rowCountry, madeBy, ...values } = row;
  if (country !== 'all' && rowCountry !== country) SHIPPING_METRICS.forEach((metric) => { values[metric] = 0; });
  return values;
};

// One period summed per office, plus the all-offices total
const sumPeriod = (rows, start, end, { country = 'all', madeBy } = {}) => {
  const offices = {};
  const total = emptyMetrics();
  const inPeriod = dayRange(start, end);
  rows.forEach((row) => {
    if (!inPeriod(row) || !matchesUser(row, madeBy)) return;
    const { office } = row;
    const values = valuesFor(row, country);
    offices[office] = offices[office] || emptyMetrics();
    addInto(offices[office], values);
    addInto(total, values);
  });
  return { offices, total };
};

// Several periods in one pass: { groupKey: { offices, total } }, where groupKey(row.day) names the
// period a day belongs to (or null to leave it out)
const sumGroups = (rows, groupKey, { country = 'all', madeBy } = {}) => {
  const groups = {};
  rows.forEach((row) => {
    const key = groupKey(row.day);
    if (!key || !matchesUser(row, madeBy)) return;
    const values = valuesFor(row, country);
    const group = groups[key] = groups[key] || { offices: {}, total: emptyMetrics() };
    group.offices[row.office] = group.offices[row.office] || emptyMetrics();
    addInto(group.offices[row.office], values);
    addInto(group.total, values);
  });
  return groups;
};

const emptySums = () => ({ offices: {}, total: emptyMetrics() });

// Per office, what each country brought in over one period: { office: { country: metrics } }
const countryBreakdown = (rows, start, end) => {
  const result = Object.fromEntries(GOAL_OFFICES.map((office) => [office, {}]));
  const inPeriod = dayRange(start, end);
  rows.forEach((row) => {
    if (!inPeriod(row)) return;
    const { day, office, country, madeBy, ...values } = row;
    result[office][country] = result[office][country] || emptyMetrics();
    addInto(result[office][country], values);
  });
  Object.values(result).forEach((byCountry) => Object.values(byCountry).forEach((values) => {
    METRICS.forEach((metric) => { values[metric] = round(values[metric]); });
  }));
  return result;
};

const countryOf = (goal) => goal.country || 'all';

// The goal in force for a period: the newest version starting on or before it. Periods before the
// first goal was set are scored against that first goal, so history is readable from day one.
const goalFor = (versions, office, metric, period, periodStart, country = 'all') => {
  const list = versions.filter((goal) => goal.office === office && goal.metric === metric && goal.period === period && countryOf(goal) === country);
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  const inForce = sorted.filter((goal) => goal.effectiveFrom <= periodStart.toDate()).pop() || sorted[0];
  return inForce.target > 0 ? inForce : null;
};

const score = (target, actual, incentiveLYD = 0) => {
  const hit = target > 0 && actual >= target;
  return {
    target: round(target),
    actual: round(actual),
    remaining: round(Math.max(0, target - actual)),
    progress: target > 0 ? round(actual / target, 4) : null,
    incentiveLYD: round(incentiveLYD),
    hit,
  };
};

const scoreOffices = (sums, versions, period, start, country) => {
  const board = {};
  const totals = {};
  METRICS.forEach((metric) => { totals[metric] = { target: 0, actual: 0, incentiveLYD: 0, earnedLYD: 0 }; });
  GOAL_OFFICES.forEach((office) => {
    board[office] = {};
    METRICS.forEach((metric) => {
      const goal = goalFor(versions, office, metric, period, start, country);
      const actual = sums.offices[office]?.[metric] || 0;
      board[office][metric] = score(goal?.target || 0, actual, goal?.incentiveLYD || 0);
      totals[metric].target += goal?.target || 0;
      totals[metric].actual += actual;
      totals[metric].incentiveLYD += goal?.incentiveLYD || 0;
      if (board[office][metric].hit) totals[metric].earnedLYD += goal.incentiveLYD || 0;
    });
  });
  METRICS.forEach((metric) => {
    const { target, actual, incentiveLYD, earnedLYD } = totals[metric];
    totals[metric] = { ...score(target, actual, incentiveLYD), earnedLYD: round(earnedLYD) };
  });
  return { board, totals };
};

// Named by code; the admin shows each office's Arabic name
const officeNames = async () => GOAL_OFFICES.map((code) => ({ code, name: code }));

const parseQuery = (query) => {
  const period = PERIODS.includes(query.period) ? query.period : 'week';
  const anchor = query.date ? moment.tz(query.date, DAY, true, TZ) : moment.tz(TZ);
  if (!anchor.isValid()) throw new ErrorHandler(400, 'تاريخ غير صالح');
  const country = query.country || DEFAULT_COUNTRY;
  if (!COUNTRY_FILTERS.includes(country)) throw new ErrorHandler(400, 'دولة غير معروفة');
  return { period, anchor, country };
};

// GET /goals/dashboard?period=week|month&date=YYYY-MM-DD (shipping from China)
// The selected period scored per office, the last 12 periods for the history, a day-by-day view of the
// selected period, where the goods came from, and (admins) who sold what. Employees also get their own
// numbers. Shipping numbers are China's, sales are everyone's; the breakdown gives China's share of both.
module.exports.getDashboard = async (req, res, next) => {
  try {
    const { period, anchor, country } = parseQuery(req.query);
    const isAdmin = !!req.user.roles?.isAdmin;
    const selected = bounds(period, anchor);
    const previous = bounds(period, selected.start.clone().subtract(1, period));
    const historyStart = selected.start.clone().subtract(HISTORY_LENGTH - 1, period).startOf(period);
    const now = moment.tz(TZ);
    const filter = { country };

    const [offices, allVersions, rows] = await Promise.all([
      officeNames(),
      SalesGoal.find({ period, office: { $in: GOAL_OFFICES } }).lean(),
      cachedRows(historyStart, selected.end),
    ]);
    const versions = allVersions.filter((goal) => countryOf(goal) === country);

    const sums = sumPeriod(rows, selected.start, selected.end, filter);
    const { board, totals } = scoreOffices(sums, versions, period, selected.start, country);

    // Each day's period is worked out once per distinct day, then every row is summed in one pass
    const periodOfDay = new Map();
    const byPeriod = sumGroups(rows, (day) => {
      if (!periodOfDay.has(day)) periodOfDay.set(day, moment.tz(day, DAY, TZ).startOf(period).format(DAY));
      return periodOfDay.get(day);
    }, filter);
    const history = [];
    for (let i = 0; i < HISTORY_LENGTH; i += 1) {
      const item = bounds(period, historyStart.clone().add(i, period));
      const scored = scoreOffices(byPeriod[item.key] || emptySums(), versions, period, item.start, country);
      history.push({ key: item.key, label: item.label, from: item.start.format(DAY), to: item.end.format(DAY), isCurrent: now.isBetween(item.start, item.end, null, '[]'), offices: scored.board, totals: scored.totals });
    }

    const fromKey = selected.start.format(DAY);
    const toKey = selected.end.format(DAY);
    const byDay = sumGroups(rows, (day) => (day >= fromKey && day <= toKey ? day : null), filter);
    const daily = [];
    for (const cursor = selected.start.clone(); cursor.isSameOrBefore(selected.end, 'day'); cursor.add(1, 'day')) {
      const day = byDay[cursor.format(DAY)] || emptySums();
      daily.push({
        day: cursor.format(DAY),
        label: period === 'week' ? cursor.format('ddd D') : cursor.format('D'),
        isFuture: cursor.isAfter(now, 'day'),
        offices: Object.fromEntries(GOAL_OFFICES.map((code) => [code, Object.fromEntries(METRICS.map((m) => [m, round(day.offices[code]?.[m] || 0)]))])),
      });
    }

    // How far into the period we are, for pace and projection (all of it for past periods, none for future ones)
    const totalDays = selected.end.diff(selected.start, 'days') + 1;
    const elapsedDays = now.isBefore(selected.start) ? 0 : now.isAfter(selected.end) ? totalDays : now.diff(selected.start, 'days') + 1;

    const payload = {
      period,
      country,
      countries: COUNTRIES,
      from: selected.start.format(DAY),
      to: selected.end.format(DAY),
      label: selected.label,
      isCurrent: now.isBetween(selected.start, selected.end, null, '[]'),
      canGoNext: selected.end.isBefore(now),
      totalDays,
      elapsedDays,
      offices,
      board,
      totals,
      history,
      daily,
      // Where the goods came from, this period and the one before, whatever the country filter
      breakdown: {
        current: countryBreakdown(rows, selected.start, selected.end),
        previous: countryBreakdown(rows, previous.start, previous.end),
      },
    };

    if (isAdmin) {
      const sellers = {};
      const inSelected = dayRange(selected.start, selected.end);
      rows.forEach((row) => {
        if (!row.madeBy || !row.orders || !inSelected(row)) return;
        sellers[row.madeBy] = sellers[row.madeBy] || { sales: 0, orders: 0, office: row.office };
        sellers[row.madeBy].sales += row.sales;
        sellers[row.madeBy].orders += row.orders;
      });
      const top = Object.entries(sellers).sort((a, b) => b[1].sales - a[1].sales).slice(0, 10);
      const users = await User.find({ _id: { $in: top.map(([id]) => id) } }).select('firstName lastName city').lean();
      payload.leaderboard = top.map(([id, seller]) => {
        const user = users.find((u) => String(u._id) === id);
        return { userId: id, name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Unknown', office: user?.city || seller.office, sales: round(seller.sales), orders: seller.orders };
      });
    } else {
      const me = sumPeriod(rows, selected.start, selected.end, { country, madeBy: req.user._id }).total;
      const office = req.user.city || 'tripoli';
      const officeSales = sums.offices[office]?.sales || 0;
      payload.me = {
        office,
        sales: round(me.sales),
        orders: me.orders,
        air: round(me.air),
        lcl: round(me.lcl),
        shareOfOffice: officeSales > 0 ? round(me.sales / officeSales, 4) : null,
      };
    }

    res.status(200).json(payload);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

// GET /goals - the goals in force now, per office, country, metric and period, for the editor
module.exports.getGoals = async (req, res, next) => {
  try {
    const now = moment.tz(TZ);
    const [offices, versions] = await Promise.all([officeNames(), SalesGoal.find({ office: { $in: GOAL_OFFICES } }).lean()]);
    const latest = {};
    versions
      .filter((goal) => goal.effectiveFrom <= now.toDate() && COUNTRY_FILTERS.includes(countryOf(goal)))
      .sort((a, b) => a.effectiveFrom - b.effectiveFrom)
      .forEach((goal) => { latest[[goal.office, countryOf(goal), goal.metric, goal.period].join('|')] = goal; });
    const goals = Object.values(latest).map((goal) => ({
      office: goal.office, country: countryOf(goal), metric: goal.metric, period: goal.period,
      target: goal.target, incentiveLYD: goal.incentiveLYD || 0, effectiveFrom: goal.effectiveFrom,
    }));
    res.status(200).json({ offices, countries: COUNTRIES, goals });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

// PUT /goals { goals: [{ office, country?, metric, period, target, incentiveLYD }] }
// Each change starts with the current week or month; earlier periods keep their goal.
module.exports.saveGoals = async (req, res, next) => {
  try {
    const list = Array.isArray(req.body?.goals) ? req.body.goals : null;
    if (!list || !list.length) throw new ErrorHandler(400, 'أرسل الأهداف المراد حفظها');
    const now = moment.tz(TZ);

    const clean = list.map((item) => {
      const target = Number(item.target);
      const incentiveLYD = Number(item.incentiveLYD || 0);
      const country = item.country || DEFAULT_COUNTRY;
      if (!GOAL_OFFICES.includes(item.office)) throw new ErrorHandler(400, `مكتب غير معروف "${item.office}"`);
      if (!COUNTRY_FILTERS.includes(country)) throw new ErrorHandler(400, `دولة غير معروفة "${country}"`);
      if (!METRICS.includes(item.metric)) throw new ErrorHandler(400, `هدف غير معروف "${item.metric}"`);
      if (!PERIODS.includes(item.period)) throw new ErrorHandler(400, `فترة غير معروفة "${item.period}"`);
      if (!Number.isFinite(target) || target < 0) throw new ErrorHandler(400, 'يجب أن يكون الهدف صفراً أو أكثر');
      if (!Number.isFinite(incentiveLYD) || incentiveLYD < 0) throw new ErrorHandler(400, 'يجب أن يكون الحافز صفراً أو أكثر');
      return { office: item.office, country, metric: item.metric, period: item.period, target, incentiveLYD };
    });

    for (const item of clean) {
      const effectiveFrom = now.clone().startOf(item.period).toDate();
      const current = await SalesGoal.findOne({ office: item.office, country: item.country, metric: item.metric, period: item.period, effectiveFrom: { $lte: now.toDate() } }).sort({ effectiveFrom: -1 }).lean();
      if (current && current.target === item.target && (current.incentiveLYD || 0) === item.incentiveLYD) continue;
      if (!current && item.target === 0) continue;
      await SalesGoal.updateOne(
        { office: item.office, country: item.country, metric: item.metric, period: item.period, effectiveFrom },
        { $set: { target: item.target, incentiveLYD: item.incentiveLYD, setBy: req.user._id } },
        { upsert: true, runValidators: true },
      );
    }
    return module.exports.getGoals(req, res, next);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

// Run once the database is open. Goals saved before they had a country (or as 'all') become China's
// goals, a duplicate of an existing China goal is dropped, and the indexes follow the schema, which
// removes the first version's unique index on office, metric, period and start date. Without this the
// old index rejects saving a goal for a week that already had one (E11000).
module.exports.prepareGoals = async () => {
  try {
    const legacy = await SalesGoal.find({ country: { $ne: DEFAULT_COUNTRY } }).lean();
    for (const goal of legacy) {
      const twin = await SalesGoal.exists({ office: goal.office, metric: goal.metric, period: goal.period, effectiveFrom: goal.effectiveFrom, country: DEFAULT_COUNTRY });
      if (twin) await SalesGoal.deleteOne({ _id: goal._id });
      else await SalesGoal.updateOne({ _id: goal._id }, { $set: { country: DEFAULT_COUNTRY } });
    }
    await SalesGoal.syncIndexes();
  } catch (error) {
    console.error('Sales goals: could not prepare the collection', error);
  }
};

// Tests change the data between requests; this drops what the dashboard keeps in memory
const clearCaches = () => { tripMapCache = { at: 0, promise: null }; rowsCache.clear(); };

module.exports._internals = { actualRows, goalFor, sumPeriod, countryFromText, clearCaches };
