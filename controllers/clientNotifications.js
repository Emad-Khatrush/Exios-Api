// The client app's notifications page: the customer's own messages and the office's announcements
// to everyone, newest first, and which of them are new since the page was last opened.
const mongoose = require('mongoose');
const CustomerNotification = require('../models/customerNotification');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');

const PAGE = 30;
// The badge says "99+" past this: no need to count further
const MAX_UNREAD = 99;

const mineFilter = (userId) => ({ $or: [{ user: userId }, { user: null }] });

const seenAtOf = async (userId) => {
  const user = await User.findById(userId).select('notificationsSeenAt createdAt').lean();
  // A new customer starts with nothing unread: announcements from before they joined are not news
  return user?.notificationsSeenAt || user?.createdAt || new Date(0);
};

const unreadOf = (userId, seenAt) => CustomerNotification.countDocuments({ ...mineFilter(userId), createdAt: { $gt: seenAt } }).limit(MAX_UNREAD + 1);

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error instanceof ErrorHandler ? error : new ErrorHandler(500, 'تعذّر تحميل الإشعارات'));
  }
};

// GET /client/notifications?before=<ISO date>: a page of 30, and the next page's `before`
module.exports.list = handle(async (req) => {
  const userId = new mongoose.Types.ObjectId(String(req.user._id));
  const filter = mineFilter(userId);
  if (req.query.before) {
    const before = new Date(String(req.query.before));
    if (Number.isNaN(before.getTime())) throw new ErrorHandler(400, 'تاريخ غير صالح');
    filter.createdAt = { $lt: before };
  }
  const [rows, seenAt] = await Promise.all([
    CustomerNotification.find(filter).select('title body url createdAt').sort({ createdAt: -1, _id: -1 }).limit(PAGE + 1).lean(),
    seenAtOf(userId),
  ]);
  const more = rows.length > PAGE;
  const items = rows.slice(0, PAGE).map((n) => ({
    id: String(n._id), title: n.title, body: n.body, url: n.url, at: n.createdAt, unread: n.createdAt > seenAt,
  }));
  return { items, next: more ? items[items.length - 1].at : null, unread: await unreadOf(userId, seenAt) };
});

// GET /client/notifications/unread: the badge on the bell
module.exports.unread = handle(async (req) => {
  const userId = new mongoose.Types.ObjectId(String(req.user._id));
  return { unread: await unreadOf(userId, await seenAtOf(userId)) };
});

// POST /client/notifications/seen: the customer opened the page, so everything shown is read
module.exports.seen = handle(async (req) => {
  await User.updateOne({ _id: req.user._id }, { $set: { notificationsSeenAt: new Date() } });
  return { unread: 0 };
});
