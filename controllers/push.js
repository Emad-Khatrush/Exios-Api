const PushToken = require('../models/pushToken');
const ErrorHandler = require('../utils/errorHandler');

const tokenOf = (req) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || token.length > 4096) throw new ErrorHandler(400, 'A push token is required');
  return token;
};

// The client app calls this when notifications are turned on, and again on each visit (tokens can
// change). A device used by another customer before moves to whoever is logged in now.
module.exports.saveToken = async (req, res, next) => {
  try {
    const token = tokenOf(req);
    await PushToken.updateOne(
      { token },
      { $set: { user: req.user._id, userAgent: String(req.headers['user-agent'] || '').slice(0, 400), lastSeenAt: new Date() } },
      { upsert: true },
    );
    res.status(200).json({ ok: true });
  } catch (error) {
    return next(error instanceof ErrorHandler ? error : new ErrorHandler(400, error.message));
  }
};

// On logout: this device stops getting this customer's notifications
module.exports.removeToken = async (req, res, next) => {
  try {
    await PushToken.deleteOne({ token: tokenOf(req), user: req.user._id });
    res.status(200).json({ ok: true });
  } catch (error) {
    return next(error instanceof ErrorHandler ? error : new ErrorHandler(400, error.message));
  }
};
