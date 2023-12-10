const ErrorHandler = require('../utils/errorHandler');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  console.log(error);
  error.message = err.message;
  console.log(error.message );

  if (err.code === 11000) {
    const message = 'duplicate-field-value';
    error = new ErrorHandler(400 , message);
  }
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'server-error'
  })
}

module.exports = errorHandler;
