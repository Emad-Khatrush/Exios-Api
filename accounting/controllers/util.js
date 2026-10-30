const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');

// Passes any error to the app's error handler, keeping 4xx statuses and turning
// Mongoose validation errors into 400s.
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((error) => {
  if (error.statusCode) return next(error);
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    return next(new ErrorHandler(400, error.message));
  }
  if (error.code === 11000) return next(new ErrorHandler(409, 'القيمة موجودة مسبقاً (تكرار)'));
  console.error('[accounting]', error);
  return next(new ErrorHandler(500, error.message));
});

const badRequest = (message) => new ErrorHandler(400, message);
const notFound = (message = 'غير موجود') => new ErrorHandler(404, message);

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || '')) && String(value).length === 24;

const pick = (source, fields) => fields.reduce((out, field) => {
  if (source[field] !== undefined) out[field] = source[field];
  return out;
}, {});

module.exports = { handle, badRequest, notFound, isObjectId, pick };
