const Notifications = require("../models/notifications");
const ErrorHandler = require('../utils/errorHandler');

module.exports.getNotifications = async (req, res, next) => {
  const { type } = req.query;
  try {
    const notifications = await Notifications.find({ user: req.user, notificationType: type }).populate('entityId');
    res.status(200).json({ results: notifications });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.deleteNotifications = async (req, res, next) => {
  const { type, entityId } = req.body;
  try {
    const notifications = await Notifications.deleteOne({ user: req.user, entityId, notificationType: type });
    res.status(200).json({ results: notifications });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}
