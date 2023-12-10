const Announcements = require('../models/announcement.js');
const ErrorHandler = require('../utils/errorHandler');

module.exports.getAnnouncements = async (req, res, next) => {
  try {
    const announcements = await Announcements.find({});
    res.status(200).json(announcements);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createAnnouncements = async (req, res, next) => {
  try {
    const { description } = req.body;
    const announcement = await Announcements.create({
      description
    })
    res.status(200).json(announcement);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.deleteAnnouncement = async (req, res, next) => {
  try {
    const { _id } = req.body;
    const announcement = await Announcements.deleteOne({
      _id
    })
    res.status(200).json(announcement);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateAnnouncements = async (req, res, next) => {
  try {
    const announcements = req.body;
    announcements.forEach(async (announcement) => {
      await Announcements.updateOne({ _id: announcement._id }, {
        $set: {
          description: announcement.description
        }
      })
    });
    res.status(200).json({ updatedAt: new Date() });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

