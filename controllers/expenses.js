const Expenses = require("../models/expenses");
const Activities = require("../models/activities");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const Offices = require("../models/office");
const { addChangedField } = require("../middleware/helper");
const { expenseLabels } = require("../constants/expenseLabels");

module.exports.getExpenses = async (req, res, next) => {
  try {
    const { office } = req.query;
    const mongoQuery = office ? { placedAt: office } : {}
    const expenses = await Expenses.find(mongoQuery).populate('user');
    res.status(200).json(expenses);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createExpense = async (req, res, next) => {
  const { cost, currency, description, placedAt } = req.body;
  try {
    if (!req.body) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    const images = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-expenses");
        images.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    const expense = await Expenses.create({
      user: req.user,
      description,
      placedAt,
      cost: {
        currency,
        total: cost
      },
      images
    });
    await Activities.create({
      user: req.user,
      details: {
        path: '/expenses',
        status: 'added',
        type: 'expense',
        actionId: expense._id
      }
    })

    if (expense.cost.total !== 0 && expense.placedAt !== 'turkey') {
      const currentCurrency = expense.cost.currency === 'USD' ?
          'usaDollar.value'
        : 'libyanDinar.value'
      await Offices.findOneAndUpdate({ office: placedAt }, {
        $inc: {
          [currentCurrency]: -expense.cost.total
        }
      }, {
        new: true
      });
    }

    res.status(200).json({ isSuccess: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(400, error.message));
  }
}

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

module.exports.updateExpense = async (req, res, next) => {
  const { cost, currency, description, placedAt } = req.body.expense;
  try {
    const oldExpense = await Expenses.findOne({ _id: req.params.id });
    const expense = await Expenses.findByIdAndUpdate(req.params.id, {
      description,
      placedAt,
      cost: {
        currency,
        total: cost
      }
    }, { new: true });

    // add activity to the expense
    const changedFields = [];
    if (Object.keys(req.body.changedFields)?.length > 0) {
      for (const fieldName in req.body.changedFields) {
        changedFields.push(addChangedField(fieldName, expense[fieldName], oldExpense[fieldName], expenseLabels));
      }
      await Activities.create({
        user: req.user,
        details: {
          path: '/expenses',
          status: 'updated',
          type: 'expense',
          actionId: expense._id
        },
        changedFields
      })
    }

    const differenceCost =  oldExpense.cost.total - cost;

    if (differenceCost !== 0 && expense.placedAt !== 'turkey') {
      const currentCurrency = currency === 'USD' ?
          'usaDollar.value'
        : 'libyanDinar.value';
      await Offices.findOneAndUpdate({ office: placedAt }, {
        $inc: {
          [currentCurrency]: differenceCost
        }
      }, {
        new: true
      });
    }

    res.status(200).json({ok : true});
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.uploadFiles= async (req, res, next) => {
  const { id } = req.body;

  const images = [];
  const changedFields = [];

  if (req.files) {
    for (let i = 0; i < req.files.length; i++) {
      const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-expenses");
      images.push({
        path: uploadedImg.publicUrl,
        filename: uploadedImg.filename,
        folder: uploadedImg.folder,
        bytes: uploadedImg.bytes,
        fileType: req.files[i].mimetype
      });
      changedFields.push({
        label: 'image',
        value: 'image',
        changedFrom: '',
        changedTo: uploadedImg.publicUrl
      })
    }
  }
  
  const expense = await Expenses.findByIdAndUpdate(id, {
    $push: { "images": images },
  }, { safe: true, upsert: true });
  
  await Activities.create({
    user: req.user,
    details: {
      path: '/expenses',
      status: 'added',
      type: 'expense',
      actionName: 'image',
      actionId: expense._id
    },
    changedFields
  })
  res.status(200).json(expense)
}

module.exports.deleteFiles= async (req, res, next) => {
  try {
    const expense = await Expenses.findByIdAndUpdate(req.body.id, {
      $pull: {
        images: {
          filename: req.body.image.filename
        }
      }
    }, { new: true });

    // const response = await cloudinary.uploader.destroy(req.body.image.filename);
    // if (response.result !== 'ok') {
    //   return next(new ErrorHandler(404, errorMessages.IMAGE_NOT_FOUND));
    // }

    await Activities.create({
      user: req.user,
      details: {
        path: '/expenses',
        status: 'deleted',
        type: 'expense',
        actionName: 'image',
        actionId: expense._id
      },
      changedFields: [{
        label: 'image',
        value: 'image',
        changedFrom: req.body.image.path,
        changedTo: ''
      }]
    })

    res.status(200).json({ isSuccess: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}
