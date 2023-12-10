const Incomes = require("../models/income");
const Activities = require("../models/activities");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const Offices = require("../models/office");
const { addChangedField } = require("../middleware/helper");
const { incomeLabels } = require("../constants/incomeLabels");

module.exports.getIncomes = async (req, res, next) => {
  try {
    const incomes = await Incomes.find({}).populate('user');
    res.status(200).json(incomes);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createIncome = async (req, res, next) => {
  const { cost, currency, description, office } = req.body;
  try {
    if (!req.body) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    const images = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-incomes");
        images.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    const income = await Incomes.create({
      user: req.user,
      description,
      office,
      cost: {
        currency,
        total: cost
      },
      images
    });

    await Activities.create({
      user: req.user,
      details: {
        path: '/incomes',
        status: 'added',
        type: 'income',
        actionId: income._id
      }
    })

    if (income.cost.total !== 0 && income.office !== 'turkey') {
      const currentCurrency = income.cost.currency === 'USD' ?
          'usaDollar.value'
        : 'libyanDinar.value'
      await Offices.findOneAndUpdate({ office }, {
        $inc: {
          [currentCurrency]: income.cost.total
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

module.exports.getIncome= async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.INCOME_NOT_FOUND));

  try {
    const income = await Incomes.findById(id);
    if (!income) return next(new ErrorHandler(404, errorMessages.INCOME_NOT_FOUND));
    
    res.status(200).json(income);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateIncome = async (req, res, next) => {
  console.log(req.body);
  const { cost, currency, description, office } = req.body.income;
  try {
    const oldIncome = await Incomes.findOne({ _id: req.params.id });
    const income = await Incomes.findByIdAndUpdate(req.params.id, {
      description,
      office,
      cost: {
        currency,
        total: cost
      }
    }, { new: true });

    // add activity to the income
    const changedFields = [];
    if (Object.keys(req.body.changedFields)?.length > 0) {
      for (const fieldName in req.body.changedFields) {
        changedFields.push(addChangedField(fieldName, income[fieldName], oldIncome[fieldName], incomeLabels));
      }
      await Activities.create({
        user: req.user,
        details: {
          path: '/incomes',
          status: 'updated',
          type: 'income',
          actionId: income._id
        },
        changedFields
      })
    }

    const differenceCost =  oldIncome.cost.total - cost;

    if (differenceCost !== 0 && income.office !== 'turkey') {
      const currentCurrency = currency === 'USD' ?
          'usaDollar.value'
        : 'libyanDinar.value';
      await Offices.findOneAndUpdate({ office }, {
        $inc: {
          [currentCurrency]: -differenceCost
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
      const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-incomes");
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
  
  const income = await Incomes.findByIdAndUpdate(id, {
    $push: { "images": images },
  }, { safe: true, upsert: true });
  
  await Activities.create({
    user: req.user,
    details: {
      path: '/incomes',
      status: 'added',
      type: 'income',
      actionName: 'image',
      actionId: income._id
    },
    changedFields
  })
  res.status(200).json(income)
}

module.exports.deleteFiles= async (req, res, next) => {
  try {
    const income = await Incomes.findByIdAndUpdate(req.body.id, {
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
        path: '/incomes',
        status: 'deleted',
        type: 'income',
        actionName: 'image',
        actionId: income._id
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
