const Offices = require("../models/office");
const ErrorHandler = require('../utils/errorHandler');

module.exports.getOffice = async (req, res, next) => {
  try {
    const office = await Offices.findOne({ office: req.params.officeName });
    // change the error message
    if (!office) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
    res.status(200).json(office);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createOffice = async (req, res, next) => {
  try {
    const office = await Offices.create({
      office: req.body.office
    })
    res.status(200).json(office)
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}
