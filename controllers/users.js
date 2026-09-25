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
const { uploadToGoogleCloud } = require('../utils/googleClould');

module.exports.createUser = async (req, res, next) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const { repeatedPassword, password, email, phone } = req.body;

  try {
    if (!req.file) return next(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_REQUIRED));
    if (repeatedPassword !== password) return next(new ErrorHandler(400, errorMessages.PASSWORD_NOT_MATCH));
    const customerId = generateString(1, characters) + generateString(3, numbers);
    const userFound = await User.findOne({ $or: [ { customerId }, { username: email } ] });
    if (!!userFound) return next(new ErrorHandler(400, errorMessages.USER_EXIST));

    const phoneExist = await User.findOne({ phone });
    if (!!phoneExist) return next(new ErrorHandler(400, errorMessages.PHONE_EXIST));

    const uploadedPassport = await uploadToGoogleCloud(req.file, 'exios-passports');
    if (!uploadedPassport?.publicUrl) return next(new ErrorHandler(500, errorMessages.PASSPORT_UPLOAD_FAILED));

    const hashedPassword = await bcrypt.hash(req.body.password, 12);
    const user = await User.create({
      ...req.body,
      username: email,
      password: hashedPassword,
      customerId,
      passportVerification: {
        status: 'pending',
        imageUrl: uploadedPassport.publicUrl,
        submittedAt: new Date(),
      },
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

module.exports.uploadPassport = async (req, res, next) => {
  try {
    if (!req.file) return next(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_REQUIRED));

    const uploadedPassport = await uploadToGoogleCloud(req.file, 'exios-passports');
    if (!uploadedPassport?.publicUrl) return next(new ErrorHandler(500, errorMessages.PASSPORT_UPLOAD_FAILED));

    const user = await User.findByIdAndUpdate(req.user._id, {
      $set: {
        'passportVerification.status': 'pending',
        'passportVerification.imageUrl': uploadedPassport.publicUrl,
        'passportVerification.submittedAt': new Date(),
        'passportVerification.rejectionReason': null,
      },
      $unset: {
        'passportVerification.reviewedAt': '',
        'passportVerification.reviewedBy': '',
      }
    }, { new: true });

    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.updatePassportVerification = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, firstName, lastName } = req.body;

    if (!['verified', 'rejected'].includes(status)) {
      return next(new ErrorHandler(400, 'Status must be verified or rejected'));
    }
    if (status === 'rejected' && !String(rejectionReason || '').trim()) {
      return next(new ErrorHandler(400, 'Rejection reason is required'));
    }

    const updateFields = {
      'passportVerification.status': status,
      'passportVerification.rejectionReason': status === 'rejected' ? String(rejectionReason).trim() : null,
      'passportVerification.wasRejected': status === 'rejected',
      'passportVerification.reviewedAt': new Date(),
      'passportVerification.reviewedBy': req.user._id,
    };

    // Let the reviewer fix the customer's name (as spelled on the passport) at the moment of approval
    if (status === 'verified') {
      if (String(firstName || '').trim()) updateFields.firstName = String(firstName).trim();
      if (String(lastName || '').trim()) updateFields.lastName = String(lastName).trim();
    }

    const user = await User.findByIdAndUpdate(id, { $set: updateFields }, { new: true })
      .select('firstName lastName customerId passportVerification');

    if (!user) return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));

    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getPendingPassportVerifications = async (req, res, next) => {
  try {
    const customers = await User.find({ 'passportVerification.status': 'pending' })
      .select('firstName lastName username customerId phone city createdAt passportVerification')
      .sort({ 'passportVerification.submittedAt': 1 })
      .lean();

    res.status(200).json({ results: customers });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, error.message));
  }
}

// Admin only (see routes/users.js) - customers whose passport was uploaded and approved.
module.exports.getApprovedPassportVerifications = async (req, res, next) => {
  try {
    const customers = await User.find({ 'passportVerification.status': 'verified' })
      .select('firstName lastName username customerId phone city createdAt passportVerification')
      .populate('passportVerification.reviewedBy', 'firstName lastName')
      .sort({ 'passportVerification.reviewedAt': -1 })
      .lean();

    res.status(200).json({ results: customers });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, error.message));
  }
}

module.exports.getMyAccount = async (req, res, next) => {
  try {
    res.status(200).json(req.user);
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

module.exports.updateCustomerId = async (req, res, next) => {
  const { id } = req.params;
  const { customerId } = req.body;

  try {
    const user = await User.findById(id);
    
    const customerIdExist = await User.findOne({ customerId });
    if (customerIdExist) return next(new ErrorHandler(400, 'Customer ID already exists'));

    const validCode = validateFormat(customerId);
    if (!validCode) return next(new ErrorHandler(400, 'Customer ID format is invalid. It should start with a letter followed by three digits (e.g., A123)'));

    user.customerId = customerId;
    await user.save();
    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

const MAX_SPECIAL_PRICE_CATEGORIES = 20;
const MAX_CATEGORY_NAME_LENGTH = 40;

// Empty stays empty (no special price for that category); anything else must be a positive number
const parseSpecialPrice = (value) => {
  if (value === '' || value === null || value === undefined) return undefined;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw new ErrorHandler(400, 'Prices must be positive numbers');
  return Math.round(price * 100) / 100;
};

const parseSpecialPriceCategories = (categories) => {
  if (!Array.isArray(categories)) throw new ErrorHandler(400, 'Categories are missing');
  if (categories.length > MAX_SPECIAL_PRICE_CATEGORIES) {
    throw new ErrorHandler(400, `No more than ${MAX_SPECIAL_PRICE_CATEGORIES} categories`);
  }

  const names = new Set();
  return categories.map(category => {
    const name = String(category?.name || '').trim();
    if (!name) throw new ErrorHandler(400, 'Every category needs a name');
    if (name.length > MAX_CATEGORY_NAME_LENGTH) {
      throw new ErrorHandler(400, `Category names can be at most ${MAX_CATEGORY_NAME_LENGTH} characters`);
    }
    if (names.has(name.toLowerCase())) throw new ErrorHandler(400, `The category "${name}" is listed twice`);
    names.add(name.toLowerCase());

    return { name, air: parseSpecialPrice(category.air), sea: parseSpecialPrice(category.sea) };
  });
};

module.exports.updateSpecialPrices = async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const specialPrices = {
      enabled: !!body.enabled,
      categories: parseSpecialPriceCategories(body.categories),
      note: String(body.note || '').trim(),
      updatedAt: new Date(),
      updatedBy: req.user._id,
    };

    const hasAnyPrice = specialPrices.categories.some(category => category.air || category.sea);
    if (specialPrices.enabled && !hasAnyPrice) {
      return next(new ErrorHandler(400, 'Add at least one price before turning special prices on'));
    }

    const user = await User.findByIdAndUpdate(id, { $set: { specialPrices } }, { new: true })
      .select('firstName lastName customerId specialPrices');
    if (!user) return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));

    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getSpecialPriceCustomers = async (req, res, next) => {
  try {
    const customers = await User.find({ 'specialPrices.enabled': true })
      .select('firstName lastName customerId phone city imgUrl specialPrices')
      .populate('specialPrices.updatedBy', 'firstName lastName')
      .sort({ 'specialPrices.updatedAt': -1 })
      .lean();

    res.status(200).json({ results: customers });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, error.message));
  }
}

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
    let query = [{ $match: { isCanceled: false } }, { $sort: { createdAt: -1 } }, { $skip: Number(skip) || 0 }, { $limit: Number(limit) || 10 }];
    
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
    const clients = await User.aggregate(query).allowDiskUse(true);

    const verifyStatementCounts = [];
    const openedWalletCounts = [];
        
    const userCounts = await User.countDocuments({ isCanceled: false });
    res.status(200).json({
      results: clients, 
      meta: {
        counts: {
          openedWalletCounts: openedWalletCounts?.total || 0,
          verifyStatementCounts: verifyStatementCounts?.total || 0,
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
    const total = await User.countDocuments({ isCanceled: false, 'roles.isClient': true });
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

// Last `monthsBack` months (oldest first, this month last) of shipped KG/CBM, for the trend chart
const getShipmentTrend = async (monthsBack) => {
  const from = moment().subtract(monthsBack - 1, 'months').startOf('month').toDate();

  const rows = await Orders.aggregate([
    { $unwind: '$paymentList' },
    { $match: {
        unsureOrder: false,
        isCanceled: false,
        'paymentList.deliveredPackages.arrivedAt': { $gte: from },
    } },
    { $group: {
        _id: {
          year: { $year: '$paymentList.deliveredPackages.arrivedAt' },
          month: { $month: '$paymentList.deliveredPackages.arrivedAt' },
          unit: '$paymentList.deliveredPackages.weight.measureUnit',
        },
        totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
        packagesCount: { $sum: 1 },
    } },
  ]);

  const months = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const date = moment().subtract(i, 'months');
    months.push({ year: date.year(), month: date.month() + 1, label: date.format('MMM') });
  }

  return months.map(({ year, month, label }) => {
    const groups = rows.filter(row => row._id.year === year && row._id.month === month);
    return {
      label,
      totalKG: groups.find(g => g._id.unit === 'KG')?.totalWeight || 0,
      totalCBM: groups.find(g => g._id.unit === 'CBM')?.totalWeight || 0,
      packagesCount: groups.reduce((sum, g) => sum + (g.packagesCount || 0), 0),
    };
  });
};

// This month's shipped KG/CBM/packages and open orders, split by office (Order.placedAt)
const getOfficeBreakdown = async (currentMonthByNumber, currentYear) => {
  const OFFICE_KEYS = ['tripoli', 'benghazi'];

  const activeOrdersByOffice = await Orders.aggregate([
    { $match: { isFinished: false, unsureOrder: false, isCanceled: false, placedAt: { $in: OFFICE_KEYS } } },
    { $group: { _id: '$placedAt', count: { $sum: 1 } } },
  ]);

  const shipmentsByOffice = await Orders.aggregate([
    { $unwind: '$paymentList' },
    { $match: {
        unsureOrder: false,
        isCanceled: false,
        placedAt: { $in: OFFICE_KEYS },
        $expr: {
          $and: [
            { $eq: [{ $month: '$paymentList.deliveredPackages.arrivedAt' }, currentMonthByNumber] },
            { $eq: [{ $year: '$paymentList.deliveredPackages.arrivedAt' }, currentYear] },
          ],
        },
    } },
    { $group: {
        _id: { office: '$placedAt', unit: '$paymentList.deliveredPackages.weight.measureUnit' },
        totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
        packagesCount: { $sum: 1 },
    } },
  ]);

  return OFFICE_KEYS.map(office => {
    const groups = shipmentsByOffice.filter(g => g._id.office === office);
    return {
      office,
      activeOrders: activeOrdersByOffice.find(g => g._id === office)?.count || 0,
      totalKG: groups.find(g => g._id.unit === 'KG')?.totalWeight || 0,
      totalCBM: groups.find(g => g._id.unit === 'CBM')?.totalWeight || 0,
      packagesCount: groups.reduce((sum, g) => sum + (g.packagesCount || 0), 0),
    };
  });
};

// Latest orders and wallet payments merged into one feed, newest first
const getRecentActivity = async (limit) => {
  const [recentOrders, recentStatements] = await Promise.all([
    Orders.find({ unsureOrder: false })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('orderId customerInfo.fullName totalInvoice placedAt createdAt isCanceled')
      .lean(),
    UserStatement.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('user', 'firstName lastName customerId')
      .select('description amount currency calculationType createdAt user')
      .lean(),
  ]);

  const feed = [
    ...recentOrders.map(order => ({
      type: 'order',
      id: String(order._id),
      title: order.customerInfo?.fullName || order.orderId,
      subtitle: `Order #${order.orderId}${order.isCanceled ? ' (cancelled)' : ''}`,
      amount: order.totalInvoice || 0,
      currency: 'USD',
      isPositive: !order.isCanceled,
      office: order.placedAt,
      createdAt: order.createdAt,
    })),
    ...recentStatements.map(statement => ({
      type: 'payment',
      id: String(statement._id),
      title: statement.user ? `${statement.user.firstName} ${statement.user.lastName}` : 'Wallet',
      subtitle: statement.description || (statement.calculationType === '+' ? 'Wallet deposit' : 'Wallet payment'),
      amount: statement.amount || 0,
      currency: statement.currency || 'USD',
      isPositive: statement.calculationType === '+',
      office: null,
      createdAt: statement.createdAt,
    })),
  ];

  feed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return feed.slice(0, limit);
};

module.exports.getHomeData = async (req, res, next) => {
  const currentMonthByNumber = moment().month() + 1; // from Jun 0 to Dec 11
  const currentYear = new Date().getFullYear();

  try {
    const offices = await Office.find({ office: ['tripoli', 'benghazi'] });

    const activeOrdersCount = await Orders.countDocuments({ isFinished: false, unsureOrder: false, isCanceled: false });

    const debts = await Orders.find({ 'debt.total': { $gt: 0 } }).populate('user');
    const credits = await Orders.find({ 'credit.total': { $gt: 0 } }).populate('user');

    const clientUsersCount = await User.countDocuments({ 'roles.isClient': true });

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

    // Shipment volume (KG/CBM) delivered this month vs previous month, for the dashboard stat tiles
    const currentMonthWeightAgg = await Orders.aggregate([
      { $unwind: '$paymentList' },
      { $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$paymentList.deliveredPackages.arrivedAt' }, currentMonthByNumber] },
              { $eq: [{ $year: '$paymentList.deliveredPackages.arrivedAt' }, currentYear] }
            ]
          }
      } },
      { $group: {
          _id: '$paymentList.deliveredPackages.weight.measureUnit',
          totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
          packagesCount: { $sum: 1 }
      } },
    ]);

    const previousMonthWeightAgg = await Orders.aggregate([
      { $unwind: '$paymentList' },
      { $match: {
          unsureOrder: false,
          isCanceled: false,
          $expr: {
            $and: [
              { $eq: [{ $month: '$paymentList.deliveredPackages.arrivedAt' }, currentMonthByNumber - 1] },
              { $eq: [{ $year: '$paymentList.deliveredPackages.arrivedAt' }, currentYear] }
            ]
          }
      } },
      { $group: {
          _id: '$paymentList.deliveredPackages.weight.measureUnit',
          totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
          packagesCount: { $sum: 1 }
      } },
    ]);

    const sumMeasure = (agg, unit) => agg.find(group => group._id === unit)?.totalWeight || 0;
    const sumPackages = (agg) => agg.reduce((sum, group) => sum + (group.packagesCount || 0), 0);

    const shipmentStats = {
      totalKG: sumMeasure(currentMonthWeightAgg, 'KG'),
      totalCBM: sumMeasure(currentMonthWeightAgg, 'CBM'),
      packagesCount: sumPackages(currentMonthWeightAgg),
      previousTotalKG: sumMeasure(previousMonthWeightAgg, 'KG'),
      previousTotalCBM: sumMeasure(previousMonthWeightAgg, 'CBM'),
      previousPackagesCount: sumPackages(previousMonthWeightAgg),
    };

    const [shipmentTrend, officeBreakdown, recentActivity] = await Promise.all([
      getShipmentTrend(6),
      getOfficeBreakdown(currentMonthByNumber, currentYear),
      getRecentActivity(8),
    ]);

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
      clientUsersCount,
      shipmentStats,
      shipmentTrend,
      officeBreakdown,
      recentActivity
    })
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

const validateFormat = (str) => {
  // ^      : Start of string
  // [a-zA-Z] : Exactly one letter (upper or lowercase)
  // \d{3}  : Exactly three digits
  // $      : End of string
  const regex = /^[a-zA-Z]\d{3}$/;
  return regex.test(str);
};
