const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Activities = require("../models/activities");
const Orders = require('../models/order');
const Expenses = require('../models/expenses');
const Incomes = require('../models/income');
const Inventory = require('../models/inventory');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');

// Activity days are read in Libya time, same as the dashboard.
const ACTIVITY_TZ = 'Africa/Tripoli';
const ACTIVITY_TYPES = ['order', 'expense', 'income', 'inventory', 'debt', 'activity'];
const ACTIVITY_STATUSES = ['added', 'updated', 'deleted'];
const USER_FIELDS = 'firstName lastName imgUrl';
const MAX_LIMIT = 100;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === String(value);

// Filters shared by the list and the counts. `type`/`status` are left out of the
// counts so every chip can show how many it would match.
const buildFilter = (query, { withType = true, withStatus = true } = {}) => {
  const filter = {};
  if (withType && ACTIVITY_TYPES.includes(query.type)) filter['details.type'] = query.type;
  if (withStatus && ACTIVITY_STATUSES.includes(query.status)) filter['details.status'] = query.status;
  if (query.user && isObjectId(query.user)) filter.user = new mongoose.Types.ObjectId(query.user);

  const from = query.from && moment.tz(query.from, 'YYYY-MM-DD', true, ACTIVITY_TZ);
  const to = query.to && moment.tz(query.to, 'YYYY-MM-DD', true, ACTIVITY_TZ);
  if ((from && from.isValid()) || (to && to.isValid())) {
    filter.createdAt = {};
    if (from && from.isValid()) filter.createdAt.$gte = from.startOf('day').toDate();
    if (to && to.isValid()) filter.createdAt.$lte = to.endOf('day').toDate();
  }
  return filter;
};

// A short human name for the record each activity points at, looked up in one query per type.
const attachSubjects = async (activities) => {
  const idsByType = {};
  activities.forEach((activity) => {
    const { type, actionId } = activity.details || {};
    if (!type || !actionId || !isObjectId(actionId)) return;
    (idsByType[type] = idsByType[type] || new Set()).add(String(actionId));
  });

  const lookups = {
    order: async (ids) => (await Orders.find({ _id: { $in: ids } }).select('orderId customerInfo.fullName').lean())
      .map((o) => [o._id, [o.orderId && `#${o.orderId}`, o.customerInfo?.fullName].filter(Boolean).join(' · ')]),
    expense: async (ids) => (await Expenses.find({ _id: { $in: ids } }).select('description').lean())
      .map((e) => [e._id, e.description]),
    income: async (ids) => (await Incomes.find({ _id: { $in: ids } }).select('description').lean())
      .map((i) => [i._id, i.description]),
    inventory: async (ids) => (await Inventory.find({ _id: { $in: ids } }).select('voyage').lean())
      .map((i) => [i._id, i.voyage]),
  };

  const subjects = {};
  await Promise.all(Object.entries(idsByType).map(async ([type, ids]) => {
    if (!lookups[type]) return;
    const rows = await lookups[type]([...ids]);
    rows.forEach(([id, subject]) => { subjects[`${type}:${id}`] = subject || ''; });
  }));

  return activities.map((activity) => {
    const { type, actionId } = activity.details || {};
    const key = `${type}:${actionId}`;
    let subject = subjects[key] || null;
    // Deleted debts no longer exist, but the activity keeps the customer on it.
    if (!subject && type === 'debt') {
      const customer = activity.changedFields?.find((field) => field.label === 'Customer')?.value;
      if (customer) subject = `Customer ${customer}`;
    }
    return { ...activity, subject, recordExists: key in subjects };
  });
};

// Query: limit, skip, type, status, user, from, to (YYYY-MM-DD, inclusive)
module.exports.getActivities = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), MAX_LIMIT);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const filter = buildFilter(req.query);
    const countsFilter = buildFilter(req.query, { withType: false, withStatus: false });

    const [activities, total, counts] = await Promise.all([
      Activities.find(filter)
        .populate('user', USER_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Activities.countDocuments(filter),
      Activities.aggregate([
        { $match: countsFilter },
        { $group: { _id: { type: '$details.type', status: '$details.status' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Chip counts: by type (respecting the chosen action) and by action (respecting the chosen type).
    const byType = {};
    const byStatus = {};
    counts.forEach(({ _id, count }) => {
      if (!req.query.status || _id.status === req.query.status) byType[_id.type] = (byType[_id.type] || 0) + count;
      if (!req.query.type || _id.type === req.query.type) byStatus[_id.status] = (byStatus[_id.status] || 0) + count;
    });

    res.status(200).json({
      activities: await attachSubjects(activities),
      limit,
      skip,
      total,
      counts: { byType, byStatus },
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

// Staff who have at least one activity, for the "who" filter
module.exports.getActivityUsers = async (req, res, next) => {
  try {
    const rows = await Activities.aggregate([
      { $match: { user: { $ne: null } } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]);
    const counts = new Map(rows.map((row) => [String(row._id), row.count]));
    const users = await User.find({ _id: { $in: rows.map((row) => row._id) } }).select(USER_FIELDS).lean();
    const result = users
      .map((user) => ({ ...user, count: counts.get(String(user._id)) || 0 }))
      .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
    res.status(200).json(result);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}
