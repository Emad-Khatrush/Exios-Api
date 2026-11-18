// The client app on customers' devices: installed or not, notifications on or not, last used.
// The client reports each device when the app opens (ping); staff read it per customer and as
// totals on the analytics page.
const AppDevice = require('../models/appDevice');
const PushToken = require('../models/pushToken');
const SiteVisit = require('../models/siteVisit');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');

// An installed app not opened for this long is counted as no longer used (removed, most likely)
const ACTIVE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const platformOf = (ua = '') => {
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua))) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
};

const browserOf = (ua = '') => {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/samsungbrowser/i.test(ua)) return 'Samsung';
  if (/crios|chrome\//i.test(ua)) return 'Chrome';
  if (/fxios|firefox\//i.test(ua)) return 'Firefox';
  if (/safari\//i.test(ua)) return 'Safari';
  return 'Other';
};

// installed: opened as an app in the last ACTIVE_DAYS. stopped: was an app, not opened since.
// browser: only ever used in the browser.
const statusOf = (device, now = Date.now()) => {
  if (!device.firstAppAt) return 'browser';
  return device.lastAppAt && now - new Date(device.lastAppAt).getTime() <= ACTIVE_DAYS * DAY ? 'installed' : 'stopped';
};

// POST /client/app/ping { deviceId, standalone, push }: once each time the app opens
module.exports.ping = async (req, res, next) => {
  try {
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim().slice(0, 100) : '';
    if (!deviceId) throw new ErrorHandler(400, 'deviceId is required');
    const standalone = req.body.standalone === true;
    const ua = String(req.headers['user-agent'] || '');
    const now = new Date();
    await AppDevice.updateOne(
      { deviceId },
      {
        $set: {
          user: req.user._id, platform: ['ios', 'android', 'desktop'].includes(req.body.platform) ? req.body.platform : platformOf(ua), browser: browserOf(ua), standalone,
          push: req.body.push === true, lastSeenAt: now, userAgent: ua.slice(0, 400),
          ...(standalone && { lastAppAt: now }),
        },
        ...(standalone && { $min: { firstAppAt: now } }),
      },
      { upsert: true },
    );
    res.status(200).json({ ok: true });
  } catch (error) {
    return next(error instanceof ErrorHandler ? error : new ErrorHandler(400, error.message));
  }
};

// GET /user/:id/app: the customer's devices for their page in the admin
module.exports.customer = async (req, res, next) => {
  try {
    const [devices, pushDevices] = await Promise.all([
      AppDevice.find({ user: req.params.id }).sort({ lastSeenAt: -1 }).limit(20).lean(),
      PushToken.countDocuments({ user: req.params.id }),
    ]);
    const now = Date.now();
    const list = devices.map((d) => ({
      platform: d.platform, browser: d.browser, status: statusOf(d, now), push: !!d.push,
      firstAppAt: d.firstAppAt || null, lastAppAt: d.lastAppAt || null, lastSeenAt: d.lastSeenAt,
    }));
    const installed = list.filter((d) => d.status === 'installed');
    res.status(200).json({
      status: installed.length ? 'installed' : list.some((d) => d.status === 'stopped') ? 'stopped' : list.length ? 'browser' : 'never',
      installedDevices: installed.length,
      pushDevices,
      lastAppAt: list.reduce((last, d) => (d.lastAppAt && (!last || d.lastAppAt > last) ? d.lastAppAt : last), null),
      activeDays: ACTIVE_DAYS,
      devices: list,
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// GET /analytics/app: the app on the analytics page
module.exports.summary = async (req, res, next) => {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - ACTIVE_DAYS * DAY);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(startOfToday.getTime() - 29 * DAY);

    const [
      clients, installedUsers, everUsers, pushUsers, platforms, newInstalls, visits30, appVisits30, recent,
    ] = await Promise.all([
      User.countDocuments({ 'roles.isClient': true }),
      AppDevice.distinct('user', { lastAppAt: { $gte: since } }),
      AppDevice.distinct('user', { firstAppAt: { $exists: true } }),
      PushToken.distinct('user'),
      AppDevice.aggregate([
        { $match: { lastAppAt: { $gte: since } } },
        { $group: { _id: '$platform', devices: { $sum: 1 } } },
      ]),
      AppDevice.aggregate([
        { $match: { firstAppAt: { $gte: monthStart } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstAppAt' } }, count: { $sum: 1 } } },
        { $project: { _id: 0, date: '$_id', count: 1 } },
        { $sort: { date: 1 } },
      ]),
      SiteVisit.countDocuments({ createdAt: { $gte: monthStart }, user: { $ne: null } }),
      SiteVisit.countDocuments({ createdAt: { $gte: monthStart }, app: true }),
      AppDevice.find({ lastAppAt: { $exists: true } }).sort({ lastAppAt: -1 }).limit(10)
        .populate('user', 'firstName lastName customerId').lean(),
    ]);

    const installed = new Set(installedUsers.map(String));
    res.status(200).json({
      activeDays: ACTIVE_DAYS,
      clients,
      installedCustomers: installed.size,
      stoppedCustomers: everUsers.filter((u) => !installed.has(String(u))).length,
      pushCustomers: pushUsers.length,
      platforms: ['android', 'ios', 'desktop'].map((p) => ({ platform: p, devices: platforms.find((x) => x._id === p)?.devices || 0 })),
      newInstalls,
      // Of the logged-in visits in the last 30 days, how many were in the installed app
      appVisitShare: visits30 ? Math.round((appVisits30 / visits30) * 1000) / 10 : 0,
      recent: recent.map((d) => ({
        customerId: d.user?.customerId || '', name: [d.user?.firstName, d.user?.lastName].filter(Boolean).join(' '),
        userId: d.user?._id || null, platform: d.platform, push: !!d.push, lastAppAt: d.lastAppAt, status: statusOf(d, now.getTime()),
      })),
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports._test = { statusOf, platformOf, ACTIVE_DAYS };
