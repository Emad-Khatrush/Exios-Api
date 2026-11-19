// Rating rewards over HTTP (spec 2026-11-19-rating-rewards-design.md): what awaits the customer's
// rating, one rating for many orders, and the order page's single rating, all through the service.
const loyalty = require('../accounting/services/loyalty');
const ratings = require('../accounting/services/loyalty/ratings');
const { runInTransaction } = require('../accounting/services/transaction');

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error);
  }
};

module.exports.pending = handle(async (req) => ({
  orders: await ratings.pendingFor(req.user._id),
  pointsEach: ratings.POINTS_EACH,
  days: ratings.DAYS,
  off: await loyalty.isOff(req.user._id),
}));

module.exports.rate = handle((req) => runInTransaction((session) => ratings.rate({
  userId: req.user._id, orderIds: req.body?.orderIds, questions: req.body?.questions,
}, { session })));

// The order page: the same, for its one order (only the customer's own)
module.exports.rateOne = handle((req) => runInTransaction((session) => ratings.rate({
  userId: req.user._id, orderIds: [req.params.id], questions: req.body?.questions,
}, { session })));
