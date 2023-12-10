const jwt = require('jsonwebtoken');
const ErrorHandler = require('../utils/errorHandler');
const User = require('../models/user');
const { errorMessages } = require('../constants/errorTypes');

exports.protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return next(new ErrorHandler(404, 'token-invalid'));
  }

  try {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decodedToken.id, { password: 0 });

    if (!user) {
      return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
    }

    if (user.isCanceled) {
      return next(new ErrorHandler(400, errorMessages.USER_SUBSCRIPTION_CANCLED));
    }

    req.user = user;
    next();
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, 'authorize-invalid'));
  }
}
exports.isAdmin = async (req, res, next) => {
  if (!req.user) {
    return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
  }
  if (req.user.roles.isAdmin) {
    return next();
  }
  return next(new ErrorHandler(404, 'authorize-invalid'));
}

exports.isClient = async (req, res, next) => {
  if (!req.user) {
    return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
  }
  if (req.user.roles.isClient) {
    return next();
  }
  return next(new ErrorHandler(404, 'authorize-invalid'));
}

exports.isEmployee = async (req, res, next) => {
  if (!req.user) {
    return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
  }
  if (req.user.roles.isEmployee) {
    return next();
  }
  return next(new ErrorHandler(404, 'authorize-invalid'));
}

exports.allowAdminsAndEmployee = async (req, res, next) => {
  if (!req.user) {
    return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
  }

  if (req.user.roles.isEmployee || req.user.roles.isAdmin) {
    return next();
  }
  return next(new ErrorHandler(404, 'authorize-invalid'));
}
