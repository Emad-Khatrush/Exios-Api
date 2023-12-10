const Balance = require('../models/balance');
const Orders = require('../models/order');
const Users = require('../models/user');

const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const { uploadToGoogleCloud } = require('../utils/googleClould');

module.exports.getBalances = async (req, res, next) => {
  try {
    const { tabType, officeType } = req.query;

    const matchQuery = { $match: { balanceType: 'debt', status: tabType, createdOffice: officeType || 'tripoli' } }

    let debts = (await Balance.aggregate([
      { ...matchQuery },
      {
        $group: {
          _id: '$owner',
          debts: { $push: '$$ROOT' } // Push each document into the debts array
        }
      },
      {
        $group: {
          _id: null,
          results: {
            $push: {
              $cond: {
                if: { $gt: [{ $size: '$debts' }, 1] },
                then: '$debts',
                else: { $arrayElemAt: ['$debts', 0] } // If only one debt, return it as an object
              }
            }
          }
        }
      },
      {
        $sort: {
          createdAt: -1,
          'paymentHistory.createdAt': -1
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0]?.results
    debts = await Balance.populate(debts, [{ path: "order" }, { path: "owner" }, { path: "createdBy" }]);
    
    const credits = await Balance.find({ balanceType: 'credit' }).populate(['owner', 'order', 'createdBy']);
    let countList = (await Balance.aggregate([
      {
        $group: {
          _id: null,
          openedDebtsCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", 'open'] }, { $eq: ["$createdOffice", officeType] }] },
                1,
                0
              ]
            }
          },
          closedDebtsCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", 'closed'] }, { $eq: ["$createdOffice", officeType] }] },
                1,
                0
              ]
            }
          },
          overdueDebtsCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", 'overdue'] }, { $eq: ["$createdOffice", officeType] }] },
                1,
                0
              ]
            }
          },
          lostDebtsCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", 'lost'] }, { $eq: ["$createdOffice", officeType] }] },
                1,
                0
              ]
            }
          },
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0];

    if (!countList) {
      countList = {
        openedDebtsCount: 0,
        closedDebtsCount: 0,
        overdueDebtsCount: 0,
        lostDebtsCount: 0
      }
    }

    res.status(200).json({ debts, credits, countList });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.createBalance = async (req, res, next) => {
  try {
    const { balanceType, amount, currency, orderId, customerId, notes, createdOffice } = req.body;
    if (!balanceType || !amount || !currency || !customerId || !notes || !createdOffice) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    const user = await Users.findOne({ customerId });
    if (!user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));

    let order;
    if (orderId) {
      order = await Orders.findOne({ orderId });
    }

    const balance = await Balance.create({
      balanceType,
      amount,
      currency,
      notes,
      createdOffice,
      order: order ? order : undefined,
      owner: user,
      createdBy: req.user,
      initialAmount: amount,
    })
    
    res.status(200).json(balance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.createPaymentHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, rate, amount, currency, sameCurrency } = req.body;
    if (!createdAt || !rate || !amount || !currency) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    // Get the existing balance document from the database
    const existingBalance = await Balance.findOne({ _id: id });
    if (existingBalance.currency === 'LYD' && currency === 'USD') {
      return next(new ErrorHandler(400, errorMessages.BALANCE_CURRENCY_NOT_ACCEPTED));
    }
    if (existingBalance.amount === 0) {
      return next(new ErrorHandler(400, errorMessages.BALANCE_ALREADY_PAID));
    }

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-debts-history");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    req.body.attachments = files;
    let updatedAmount = amount;

    if (sameCurrency === 'false') {
      const amountToDecrement = amount / rate;
  
      const existingAmount = existingBalance.amount;
  
      // Deduct finalAmount from the existing amount
      updatedAmount = existingAmount - amountToDecrement;
  
      // Round the updatedAmount to two decimal places
      updatedAmount = updatedAmount.toFixed(2);
      if (updatedAmount < 0) {
        updatedAmount = 0;
      }
    } else {
      // Get the existing balance document from the database
      const existingAmount = existingBalance.amount;
  
      // Deduct finalAmount from the existing amount
      updatedAmount = existingAmount - amount;

      // Round the updatedAmount to two decimal places
      updatedAmount = updatedAmount.toFixed(2);
      if (updatedAmount < 0) {
        updatedAmount = 0;
      }
    }

    let updateQuery = {
      $set: { amount: updatedAmount },
      $push: { "paymentHistory": req.body },
    }

    if (updatedAmount == 0 || updatedAmount == 0.00) {
      updateQuery.$set.status = 'closed';
    }

    const balance = await Balance.findByIdAndUpdate({ _id: id }, updateQuery, { safe: true, upsert: true, new: true });
    if (!balance) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));

    res.status(200).json(balance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.updateCompanyBalance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { historyPaymentId } = req.query;
    const { reference, isExist } = req.body;
    if (!isExist || !reference) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    // Construct the update query
    const filter = { _id: id };
    const update = {
      $set: {
        'paymentHistory.$[element].companyBalance.isExist': isExist,
        'paymentHistory.$[element].companyBalance.reference': reference,
      },
    };
    const options = {
      arrayFilters: [{ 'element._id': historyPaymentId }],
    };

    const balance = await Balance.updateOne(filter, update, options);
    if (!balance) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));
    
    res.status(200).json(balance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}
