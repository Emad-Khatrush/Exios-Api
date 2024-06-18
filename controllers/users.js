const User = require('../models/user');
const Orders = require('../models/order');

const ErrorHandler = require('../utils/errorHandler');
const { formatPhoneNumber } = require('../utils/messages');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { errorMessages } = require('../constants/errorTypes');
const moment = require('moment-timezone');
const Office = require('../models/office');
const { generateString } = require('../middleware/helper');
const UserStatement = require('../models/userStatement');

module.exports.createUser = async (req, res, next) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const { repeatedPassword, password, email, phone } = req.body;

  try {
    if (repeatedPassword !== password) return next(new ErrorHandler(400, errorMessages.PASSWORD_NOT_MATCH));
    const customerId = generateString(1, characters) + generateString(3, numbers);
    const userFound = await User.findOne({ $or: [ { customerId }, { username: email } ] });
    if (!!userFound) return next(new ErrorHandler(400, errorMessages.USER_EXIST));

    const phoneExist = await User.findOne({ phone });
    if (!!phoneExist) return next(new ErrorHandler(400, errorMessages.PHONE_EXIST));
    
    const hashedPassword = await bcrypt.hash(req.body.password, 12);
    const user = await User.create({
      ...req.body,
      username: email,
      password: hashedPassword,
      customerId,
      roles: {
        isAdmin: false,
        isEmployee: false,
        isClient: true
      }
    });

    const token = await user.getSignedToken();
    res.status(200).json({ success: true, token: token });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.updateUser = async (req, res, next) => {
  const { firstName, lastName, city, phone } = req.body;

  try {
    const user = await User.findByIdAndUpdate(req.user._id, {
      firstName,
      lastName,
      city,
      phone
    }, { new: true });
    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

// module.exports.createUser = async (req, res) => {
//   try {
//     const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
//     const numbers = '0123456789';

//     const customerId = generateString(1, characters) + generateString(3, numbers);
//     const userFound = await User.findOne({ customerId });
//     if (!!userFound) return next(new ErrorHandler(400, errorMessages.USER_EXIST));
    
//     const hashedPassword = await bcrypt.hash(req.body.password, 12);
//     const user = await User.create({
//       username: req.body.username,
//       firstName: req.body.firstName,
//       lastName: req.body.lastName,
//       imgUrl: req.body.imgUrl,
//       password: hashedPassword,
//       customerId,
//       roles: {
//         isEmployee: true
//       }
//     });

//     const token = await user.getSignedToken();
//     res.status(200).json({ success: true, token: token });
//   } catch (error) {
//     console.log(error);
//     return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
//   }
// }

module.exports.getEmployees = async (req, res, next) => {
  try {
    let query = [{ $match: {
      $or: [{ 'roles.isAdmin': true }, { 'roles.isEmployee': true }]
    }},
    {
      $match: {
        $or: [{ isCanceled: false }, { isCanceled: undefined }]
      }
    }
  ];
    const employees = await User.aggregate(query);
    res.status(200).json({ results: employees });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.getClients = async (req, res, next) => {
  try {
    const { searchValue, limit, skip } = req.query;
    let query = [{ $match: { isCanceled: false, 'roles.isClient': true } }, { $sort: { createdAt: -1 } }, { $skip: Number(skip) || 0 }, { $limit: Number(limit) || 10 }];
    
    if (searchValue) {
      query = [
        {
          $addFields: {
            fullName: {
              $concat: [
                {
                  $reduce: {
                    input: { $split: ["$firstName", " "] },
                    initialValue: " ",
                    in: { $concat: ["$$value", "$$this"] }
                  }
                },
                {
                  $reduce: {
                    input: { $split: ["$lastName", " "] },
                    initialValue: " ",
                    in: { $concat: ["$$value", "$$this"] }
                  }
                }
              ]
            },
            phoneString: { "$toString": { "$toLong": "$phone" } }
          }
        },
        { 
          $match: {
            isCanceled: false, 
            'roles.isClient': true,
            $or: [
              { fullName: { $regex: new RegExp(searchValue.trim(), 'i') } },
              { customerId: { $regex: new RegExp(searchValue.trim(), 'i') } },
              { phoneString: { $regex: new RegExp(searchValue.trim(), 'i') } },
            ]
          }
        },
        {
          $sort: {
            createdAt: -1
          }
        }
      ]
    }
    const clients = await User.aggregate(query);

    const verifyStatementCounts = (await UserStatement.aggregate([
      {
        $match: { review: { $exists: false } }  // Match documents where review does not exist
      },
      {
        $group: {
          _id: "$user",                          // Group by user field
          statements: { $push: "$$ROOT" }        // Push the entire document into an array
        }
      },
      {
        $project: {
          _id: 1                                 // Include the _id field (user field) in the output
        }
      },
      {
        $lookup: {
          from: "users",                        // Specify the 'users' collection to join with
          localField: "_id",                    // Use the _id field (which is user) in the current pipeline
          foreignField: "_id",                  // Match with the _id field in the 'users' collection
          as: "userDetails"                     // Name the new array field to add the user details
        }
      },
      {
        $unwind: "$userDetails"                 // Unwind the array to deconstruct it
      },
      {
        $replaceRoot: {                         // Replace the root with the userDetails document
          newRoot: "$userDetails"
        }
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $eq: [{ $type: "$review" }, "missing"] },
                1,
                0
              ]
            }
          },
        }
      }
    ]))[0];

    const openedWalletCounts = (await UserStatement.aggregate([
      {
        $group: {
          _id: "$user",                          // Group by user field
          statements: { $push: "$$ROOT" }        // Push the entire document into an array
        }
      },
      {
        $project: {
          _id: 1                                 // Include the _id field (user field) in the output
        }
      },
      {
        $lookup: {
          from: "users",                        // Specify the 'users' collection to join with
          localField: "_id",                    // Use the _id field (which is user) in the current pipeline
          foreignField: "_id",                  // Match with the _id field in the 'users' collection
          as: "userDetails"                     // Name the new array field to add the user details
        }
      },
      {
        $unwind: "$userDetails"                 // Unwind the array to deconstruct it
      },
      {
        $replaceRoot: {                         // Replace the root with the userDetails document
          newRoot: "$userDetails"
        }
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                {},
                1,
                0
              ]
            }
          },
        }
      }
    ]))[0];
        
    const userCounts = await User.count({ isCanceled: false, 'roles.isClient': true });
    res.status(200).json({
      results: clients, 
      meta: {
        counts: {
          openedWalletCounts: openedWalletCounts.total,
          verifyStatementCounts: verifyStatementCounts.total,
          userCounts
        }, 
        limit, 
        skip
      }
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.searchForClient = async (req, res, next) => {
  try {
    let query = [{ $match: { isCanceled: false, 'roles.isClient': true } }];
    const clients = await User.aggregate(query);
    const total = await User.count({ isCanceled: false, 'roles.isClient': true });
    res.status(200).json({ results: clients, meta: { total } });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.login = async (req, res, next) => {
  const { username, password, loginType, loginMethod } = req.body;

  if (!username || !password) {
    return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
  }

  try {
    let user;
    if (loginMethod === 'phone') {
      user = await User.findOne({ phone: Number(formatPhoneNumber(username)) }).select('+password');
    } else {
      user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i'} }).select('+password');
    }
    if (!user) {
      return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
    }
    if (user.isCanceled) {
      return next(new ErrorHandler(400, errorMessages.USER_SUBSCRIPTION_CANCLED));
    }
    if (loginType === 'client' && !user.roles.isClient) { 
      return next(new ErrorHandler(400, errorMessages.USER_ROLE_INVALID));
    }
    if (loginType === 'admin' && user.roles.isClient) {
      return next(new ErrorHandler(400, errorMessages.USER_ROLE_INVALID));
    }
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      return next(new ErrorHandler(404, errorMessages.INVALID_CREDENTIALS));
    }
    if (loginMethod === 'phone') {
      user = await User.findOne({ phone: Number(formatPhoneNumber(username)) }, { password: 0 });
    } else {
      user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i'} }, { password: 0 });
    }
    
    const token = await user.getSignedToken();
    res.status(200).json({
      success: true,
      account: user,
      token
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.verifyToken = async (req, res, next) => {
  const { token } = req.body;

  if (!token) next(new ErrorHandler(404, errorMessages.TOKEN_NOT_FOUND));

  try {
    const tokenConfig = await jwt.verify(token, process.env.JWT_SECRET);

    res.status(200).json({
      token,
      tokenConfig
    })
  } catch (error) {
    return next(new ErrorHandler(401, errorMessages.INVALID_TOKEN));
  }
}

module.exports.getCustomerData = async (req, res, next) => {
  try {
    const { id } = req.params;
    let user;
    if (id.length === 4) {
      user = await User.findOne({ customerId: id });
    } else {
      user = await User.findOne({ _id: id });
    }

    if (!user) {
      return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
    }

    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(401, errorMessages.USER_NOT_FOUND));
  }
}

module.exports.getEmpoyeeHomeData = async (req, res, next) => {
  try {
    const { office } = req.query;
    const offices = await Office.find({ office: office || 'tripoli' });
    const debts = await Orders.find({ 'debt.total': { $gt: 0 }, placedAt: office || 'tripoli' });
    const credits = await Orders.find({ 'credit.total': { $gt: 0 }, placedAt: office || 'tripoli' });

    res.status(200).json({
      offices,
      debts,
      credits
    })
  } catch (error) {
    return next(new ErrorHandler(401, errorMessages.INVALID_TOKEN));
  }
}

module.exports.getHomeData = async (req, res, next) => {
  const currentMonthByNumber = moment().month() + 1; // from Jun 0 to Dec 11
  const currentYear = new Date().getFullYear();

  try {
    const offices = await Office.find({ office: ['tripoli', 'benghazi'] });

    const activeOrdersCount = await Orders.count({ isFinished: false, unsureOrder: false, isCanceled: false });

    const debts = await Orders.find({ 'debt.total': { $gt: 0 } }).populate('user');
    const credits = await Orders.find({ 'credit.total': { $gt: 0 } }).populate('user');

    const clientUsersCount = await User.count({ 'roles.isClient': true });

    const totalInvoices = (await Orders.aggregate([
      { $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$createdAt' }, currentMonthByNumber] },
              { $eq: [{ $year: '$createdAt' }, currentYear] }
            ]
          }
      } },
      { $group: { _id: null, totalInvoices: { $sum: '$totalInvoice' } } },
      { $project: { totalInvoices: 1, _id: 0 } },
    ]))[0]?.totalInvoices || 0;

    const thisMonthlyEarning = (await Orders.aggregate([
      { $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$createdAt' }, currentMonthByNumber] },
              { $eq: [{ $year: '$createdAt' }, currentYear] }
            ]
          }
      } },
      { $unwind: '$netIncome' },
      { $group: { _id: null, totalNetOfMonth: { $sum: '$netIncome.total' } } },
      { $project: { _id: 0, totalNetOfMonth: 1 } },
    ]))[0]?.totalNetOfMonth || 0;

    const previousMonthlyEarning = (await Orders.aggregate([
      { 
        $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$createdAt' }, currentMonthByNumber - 1] },
              { $eq: [{ $year: '$createdAt' }, currentYear] }
            ]
          }
      } },
      { $unwind: '$netIncome' },
      { $group: { _id: null, totalNetOfMonth: { $sum: '$netIncome.total' } } },
      { $project: { _id: 0, totalNetOfMonth: 1 } },
    ]))[0]?.totalNetOfMonth || 0;

    const thisShipmentMonthlyEarning = (await Orders.aggregate([
      { $unwind: '$paymentList' },
      { 
        $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$paymentList.deliveredPackages.arrivedAt' }, currentMonthByNumber] },
              { $eq: [{ $year: '$paymentList.deliveredPackages.arrivedAt' }, currentYear] }
            ]
          }
      } },
      {
        $group: {
          _id: null, totalNetOfMonth: {
            $sum: {
              $multiply: ['$paymentList.deliveredPackages.weight.total', { $subtract: ['$paymentList.deliveredPackages.exiosPrice', '$paymentList.deliveredPackages.originPrice'] }]
            }
          }
        }
      },
      { $project: { _id: 0, totalNetOfMonth: 1 } },
    ]))[0]?.totalNetOfMonth || 0;
    
    const previousShipmentMonthlyEarning = (await Orders.aggregate([
      { $unwind: '$paymentList' },
      { 
        $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$paymentList.deliveredPackages.arrivedAt' }, currentMonthByNumber - 1] },
              { $eq: [{ $year: '$paymentList.deliveredPackages.arrivedAt' }, currentYear] }
            ]
          }
      } },      {
        $group: {
          _id: '$month', totalNetOfMonth: {
            $sum: {
              $multiply: ['$paymentList.deliveredPackages.weight.total', { $subtract: ['$paymentList.deliveredPackages.exiosPrice', '$paymentList.deliveredPackages.originPrice'] }]
            }
          }
        }
      },
      { $project: { _id: 0, totalNetOfMonth: 1 } },
    ]))[0]?.totalNetOfMonth || 0;

    const thisMonthlyEarningPercentage = ((thisMonthlyEarning + thisShipmentMonthlyEarning) * 100) / totalInvoices;
    const previousMonthlyEarningPercentage = ((previousMonthlyEarning + previousShipmentMonthlyEarning) * 100) / totalInvoices;

    res.status(200).json({
      monthlyEarning: [
        {
          type: 'payment',
          total: thisMonthlyEarning,
        },
        {
          type: 'shipment',
          total: thisShipmentMonthlyEarning,
        }
      ],
      totalMonthlyEarning: thisMonthlyEarning + thisShipmentMonthlyEarning,
      betterThenPreviousMonth: (thisMonthlyEarning + thisShipmentMonthlyEarning) > (previousMonthlyEarning + previousShipmentMonthlyEarning),
      percentage: Math.floor(Math.abs(thisMonthlyEarningPercentage - previousMonthlyEarningPercentage)),
      activeOrdersCount,
      totalInvoices,
      offices,
      debts,
      credits,
      clientUsersCount
    })
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}
