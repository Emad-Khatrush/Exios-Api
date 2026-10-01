const Expenses = require("../models/expenses");
const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require("../constants/errorTypes");

module.exports.getExpenses = async (req, res, next) => {
  try {
    const { office, startDate, endDate } = req.query;

    const mongoQuery = {};

    if (office) {
      mongoQuery.placedAt = office;
    }

    if (startDate || endDate) {
      mongoQuery.createdAt = {};

      if (startDate) {
        mongoQuery.createdAt.$gte = new Date(startDate);
      }

      if (endDate) {
        mongoQuery.createdAt.$lte = new Date(endDate);
      }
    }

    const expenses = await Expenses.find(mongoQuery).sort({ createdAt: 1 }).populate('user');
    res.status(200).json(expenses);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
};

module.exports.getExpense= async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.EXPENSE_NOT_FOUND));

  try {
    const expense = await Expenses.findById(id);
    if (!expense) return next(new ErrorHandler(404, errorMessages.EXPENSE_NOT_FOUND));
    
    res.status(200).json(expense);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}
