const Activities = require("../models/activities");
const ErrorHandler = require('../utils/errorHandler');

module.exports.getActivities = async (req, res, next) => {
  try {
    const { limit, skip } = req.query;

    const activities = await Activities.find({}).populate('user').sort({ createdAt: -1 }).skip(skip).limit(limit);
    const total = await Activities.count();
    res.status(200).json({
      activities,
      limit,
      skip,
      total
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}
