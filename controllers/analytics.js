const jwt = require('jsonwebtoken');
const SiteVisit = require('../models/siteVisit');
const ErrorHandler = require('../utils/errorHandler');

const parseDevice = (ua = '') => {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone/i.test(ua)) return 'mobile';
  return 'desktop';
};

const parseBrowser = (ua = '') => {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return 'Chrome';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return 'Safari';
  return 'Other';
};

// Best-effort: attaches the logged-in customer if the request carries a valid
// token, but never rejects the request - most pages this tracks (landing,
// login, signup) are visited by guests with no token at all.
const getUserIdFromRequest = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    return decoded.id || null;
  } catch (error) {
    return null;
  }
};

// Public: called by Exios-Client on every route change. Never blocks the app -
// a tracking failure degrades to a quiet no-op instead of surfacing an error.
module.exports.recordVisit = async (req, res) => {
  try {
    const { sessionId, path, referrer } = req.body;
    if (!sessionId || !path) {
      return res.status(400).json({ message: 'sessionId and path are required' });
    }

    const userAgent = req.headers['user-agent'] || '';
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

    await SiteVisit.create({
      sessionId: String(sessionId).slice(0, 100),
      path: String(path).slice(0, 300),
      referrer: referrer ? String(referrer).slice(0, 300) : '',
      userAgent,
      device: parseDevice(userAgent),
      browser: parseBrowser(userAgent),
      ip,
      user: getUserIdFromRequest(req),
    });

    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(200).json({ ok: false });
  }
};

// Admin: summary numbers + breakdowns for the analytics dashboard.
module.exports.getVisitsSummary = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - 6);
    const startOfMonth = new Date(startOfToday);
    startOfMonth.setDate(startOfMonth.getDate() - 29);

    const [
      totalVisits,
      totalVisitorIds,
      todayVisits,
      todayVisitorIds,
      last7DaysVisits,
      last30DaysVisits,
      topPagesAgg,
      deviceAgg,
      dailySeries,
      loggedInVisits,
    ] = await Promise.all([
      SiteVisit.countDocuments({}),
      SiteVisit.distinct('sessionId'),
      SiteVisit.countDocuments({ createdAt: { $gte: startOfToday } }),
      SiteVisit.distinct('sessionId', { createdAt: { $gte: startOfToday } }),
      SiteVisit.countDocuments({ createdAt: { $gte: startOfWeek } }),
      SiteVisit.countDocuments({ createdAt: { $gte: startOfMonth } }),
      SiteVisit.aggregate([
        { $group: { _id: '$path', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      SiteVisit.aggregate([
        { $group: { _id: '$device', count: { $sum: 1 } } },
      ]),
      SiteVisit.aggregate([
        { $match: { createdAt: { $gte: startOfMonth } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
            visitors: { $addToSet: '$sessionId' },
          },
        },
        { $project: { _id: 0, date: '$_id', count: 1, uniqueVisitors: { $size: '$visitors' } } },
        { $sort: { date: 1 } },
      ]),
      SiteVisit.countDocuments({ user: { $ne: null } }),
    ]);

    res.status(200).json({
      totalVisits,
      totalVisitors: totalVisitorIds.length,
      todayVisits,
      todayVisitors: todayVisitorIds.length,
      last7DaysVisits,
      last30DaysVisits,
      topPages: topPagesAgg.map((p) => ({ path: p._id, count: p.count })),
      deviceBreakdown: deviceAgg.map((d) => ({ device: d._id, count: d.count })),
      dailySeries,
      loggedInVisits,
      guestVisits: totalVisits - loggedInVisits,
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Admin: raw, paginated visit log with the customer attached when known.
module.exports.getRecentVisits = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    const [results, total] = await Promise.all([
      SiteVisit.find({})
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'firstName lastName phone customerId'),
      SiteVisit.countDocuments({}),
    ]);

    res.status(200).json({ results, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};
