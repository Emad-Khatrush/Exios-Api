// Customer and sales analyses for staff (owner 2026-11-27): GET /analytics/customers/:section and
// the settings (targets, company accounts): GET/PUT /analytics/customers-settings
const analytics = require('../accounting/services/customerAnalytics');
const settings = require('../accounting/services/customerAnalytics/settings');

module.exports.section = async (req, res, next) => {
  try {
    res.status(200).json(await analytics.run(req.params.section, req.query || {}));
  } catch (error) {
    next(error);
  }
};

module.exports.getSettings = async (req, res, next) => {
  try {
    res.status(200).json(await settings.getSettings());
  } catch (error) {
    next(error);
  }
};

module.exports.putSettings = async (req, res, next) => {
  try {
    res.status(200).json(await settings.putSettings(req.body || {}, { userId: req.user?._id }));
  } catch (error) {
    next(error);
  }
};
