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

// Admin only: edit a customer's basic info from the admin panel (Customer > Settings)
module.exports.updateCustomerInfo = async (req, res, next) => {
  const { id } = req.params;
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  const username = String(req.body.username || '').trim();
  const city = String(req.body.city || '').trim();
  // Stored the same way login reads it (no +, 00, 218 or leading 0)
  const phoneText = formatPhoneNumber(String(req.body.phone || ''));
  const phone = Number(phoneText);

  if (!firstName || !lastName || !username || !phoneText) {
    return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
  }
  if (!/^\d+$/.test(phoneText) || !Number.isFinite(phone)) {
    return next(new ErrorHandler(400, 'Phone number can only contain digits'));
  }

  try {
    const user = await User.findById(id);
    if (!user) return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));

    // Login looks users up by username (any letter case) or by phone, so both must stay unique
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usernameTaken = await User.findOne({ _id: { $ne: id }, username: { $regex: `^${escapedUsername}$`, $options: 'i' } });
    if (usernameTaken) return next(new ErrorHandler(400, errorMessages.USER_EXIST));

    const phoneTaken = await User.findOne({ _id: { $ne: id }, phone });
    if (phoneTaken) return next(new ErrorHandler(400, errorMessages.PHONE_EXIST));

    user.firstName = firstName;
    user.lastName = lastName;
    user.username = username;
    user.phone = phone;
    user.city = city || undefined;
    await user.save();

    res.status(200).json(user);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
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

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Never send login secrets to the browser.
const CLIENT_PROJECTION = { password: 0 };

// Query: limit (max 1000), skip, searchValue (name, customer ID or phone),
// from/to (YYYY-MM-DD, sign-up date, Libya time). Newest clients first.
module.exports.getClients = async (req, res, next) => {
  try {
    const { searchValue, from, to } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 1000);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const baseMatch = { isCanceled: { $ne: true }, 'roles.isClient': true };

    const match = { ...baseMatch };
    const fromDate = from && moment.tz(from, 'YYYY-MM-DD', true, 'Africa/Tripoli');
    const toDate = to && moment.tz(to, 'YYYY-MM-DD', true, 'Africa/Tripoli');
    if ((fromDate && fromDate.isValid()) || (toDate && toDate.isValid())) {
      match.createdAt = {};
      if (fromDate && fromDate.isValid()) match.createdAt.$gte = fromDate.startOf('day').toDate();
      if (toDate && toDate.isValid()) match.createdAt.$lte = toDate.endOf('day').toDate();
    }

    const pipeline = [{ $match: match }];
    const search = String(searchValue || '').trim();
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      // Names are also matched with their spaces removed, so "abdulrahman" finds "Abdul Rahman".
      const compact = new RegExp(escapeRegex(search.replace(/\s+/g, '')), 'i');
      pipeline.push(
        {
          $addFields: {
            _fullName: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] },
            _phoneString: { $convert: { input: { $convert: { input: '$phone', to: 'long', onError: null, onNull: null } }, to: 'string', onError: '', onNull: '' } },
          }
        },
        {
          $addFields: {
            _compactName: { $replaceAll: { input: '$_fullName', find: ' ', replacement: '' } },
          }
        },
        {
          $match: {
            $or: [
              { _fullName: pattern },
              { _compactName: compact },
              { customerId: pattern },
              { _phoneString: pattern },
            ]
          }
        },
      );
    }

    const startOfWeek = moment.tz('Africa/Tripoli').startOf('week').toDate();
    const startOfMonth = moment.tz('Africa/Tripoli').startOf('month').toDate();

    const [clients, totalRows, userCounts, newThisWeek, newThisMonth] = await Promise.all([
      User.aggregate([
        ...pipeline,
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { ...CLIENT_PROJECTION, _fullName: 0, _compactName: 0, _phoneString: 0 } },
      ]).allowDiskUse(true),
      User.aggregate([...pipeline, { $count: 'total' }]).allowDiskUse(true),
      User.countDocuments(baseMatch),
      User.countDocuments({ ...baseMatch, createdAt: { $gte: startOfWeek } }),
      User.countDocuments({ ...baseMatch, createdAt: { $gte: startOfMonth } }),
    ]);

    res.status(200).json({
      results: clients,
      meta: {
        // `total` is how many match the current search/dates; `counts` are for the whole client base.
        total: totalRows[0]?.total || 0,
        counts: { userCounts, newThisWeek, newThisMonth },
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

// Dashboard periods are read in Libya time, so "today" and month edges match the office day.
const HOME_TZ = 'Africa/Tripoli';
const OFFICE_KEYS = ['tripoli', 'benghazi'];

// `from`/`to` are inclusive YYYY-MM-DD dates; defaults to this month so far.
// The comparison period is the one right before: the previous N whole months when the
// range covers whole months, otherwise the same number of days just before `from`.
const getHomeRange = (query) => {
  const start = query.from
    ? moment.tz(query.from, 'YYYY-MM-DD', true, HOME_TZ).startOf('day')
    : moment.tz(HOME_TZ).startOf('month');
  const end = query.to
    ? moment.tz(query.to, 'YYYY-MM-DD', true, HOME_TZ).endOf('day')
    : moment.tz(HOME_TZ).endOf('day');

  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return null;

  const isWholeMonths = start.date() === 1 && end.isSame(end.clone().endOf('month'), 'day');
  const isMonthToDate = start.date() === 1 && end.isSame(start, 'month');
  let previousStart;
  let previousEnd = start.clone().subtract(1, 'day').endOf('day');
  if (isWholeMonths) {
    const months = end.diff(start, 'months') + 1;
    previousStart = start.clone().subtract(months, 'months');
  } else if (isMonthToDate) {
    // e.g. 1-28 Sep compares with 1-28 Aug
    previousStart = start.clone().subtract(1, 'month');
    previousEnd = moment.min(end.clone().subtract(1, 'month'), previousEnd);
  } else {
    const days = end.clone().startOf('day').diff(start, 'days') + 1;
    previousStart = start.clone().subtract(days, 'days');
  }

  // The page can pick the comparison itself (e.g. the same weekdays of last week)
  if (query.prevFrom && query.prevTo) {
    const customStart = moment.tz(query.prevFrom, 'YYYY-MM-DD', true, HOME_TZ).startOf('day');
    const customEnd = moment.tz(query.prevTo, 'YYYY-MM-DD', true, HOME_TZ).endOf('day');
    if (customStart.isValid() && customEnd.isValid() && !customEnd.isBefore(customStart)) {
      previousStart = customStart;
      previousEnd = customEnd;
    }
  }

  const days = end.clone().startOf('day').diff(start, 'days') + 1;
  const granularity = days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';

  return { start, end, previousStart, previousEnd, granularity };
};

const inRange = (start, end) => ({ $gte: start.toDate(), $lte: end.toDate() });

const deliveredInRange = (start, end, extra = {}) => ({
  unsureOrder: false,
  isCanceled: false,
  'paymentList.deliveredPackages.arrivedAt': inRange(start, end),
  ...extra,
});

// Groups are keyed either by the unit itself or by { office, unit }. Packages saved without a
// measure unit come back with a null key, so read it defensively (they count as packages only).
const unitOf = (group) => (group._id && typeof group._id === 'object' ? group._id.unit : group._id);
const sumMeasure = (groups, unit) => groups.filter(g => unitOf(g) === unit).reduce((sum, g) => sum + (g.totalWeight || 0), 0);
const sumPackages = (groups) => groups.reduce((sum, g) => sum + (g.packagesCount || 0), 0);

// Delivered KG/CBM/packages between start and end
const getShipmentTotals = async (start, end) => {
  const groups = await Orders.aggregate([
    { $unwind: '$paymentList' },
    { $match: deliveredInRange(start, end) },
    { $group: {
        _id: '$paymentList.deliveredPackages.weight.measureUnit',
        totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
        packagesCount: { $sum: 1 },
    } },
  ]);
  return {
    totalKG: sumMeasure(groups, 'KG'),
    totalCBM: sumMeasure(groups, 'CBM'),
    packagesCount: sumPackages(groups),
  };
};

// Margin on delivered shipments: weight x (selling price - origin price)
const getShipmentEarning = async (start, end) => (await Orders.aggregate([
  { $unwind: '$paymentList' },
  { $match: deliveredInRange(start, end) },
  { $group: {
      _id: null,
      total: { $sum: { $multiply: ['$paymentList.deliveredPackages.weight.total', { $subtract: ['$paymentList.deliveredPackages.exiosPrice', '$paymentList.deliveredPackages.originPrice'] }] } },
  } },
]))[0]?.total || 0;

// Net income recorded on orders created between start and end
const getOrdersNetIncome = async (start, end) => (await Orders.aggregate([
  { $match: { unsureOrder: false, isCanceled: false, createdAt: inRange(start, end) } },
  { $unwind: '$netIncome' },
  { $group: { _id: null, total: { $sum: '$netIncome.total' } } },
]))[0]?.total || 0;

const getTotalInvoices = async (start, end) => (await Orders.aggregate([
  { $match: { unsureOrder: false, isCanceled: false, createdAt: inRange(start, end) } },
  { $group: { _id: null, total: { $sum: '$totalInvoice' } } },
]))[0]?.total || 0;

// Shipped KG/CBM over the range, one bar per day, week (Sunday start) or month
const getShipmentTrend = async (start, end, granularity) => {
  const rows = await Orders.aggregate([
    { $unwind: '$paymentList' },
    { $match: deliveredInRange(start, end) },
    { $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$paymentList.deliveredPackages.arrivedAt', timezone: HOME_TZ } },
          unit: '$paymentList.deliveredPackages.weight.measureUnit',
        },
        totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
        packagesCount: { $sum: 1 },
    } },
  ]);

  const spansYears = start.year() !== end.year();
  const buckets = [];
  const cursor = start.clone().startOf(granularity);
  while (cursor.isSameOrBefore(end)) {
    const bucketStart = moment.max(cursor.clone(), start.clone());
    const bucketEnd = moment.min(cursor.clone().endOf(granularity), end.clone());
    let label;
    let title;
    if (granularity === 'day') {
      label = cursor.format('D MMM');
      title = cursor.format('ddd, D MMM YYYY');
    } else if (granularity === 'week') {
      label = bucketStart.format('D MMM');
      title = `${bucketStart.format('D MMM')} – ${bucketEnd.format('D MMM YYYY')}`;
    } else {
      label = cursor.format(spansYears ? 'MMM YY' : 'MMM');
      title = cursor.format('MMMM YYYY');
    }
    buckets.push({ key: cursor.format('YYYY-MM-DD'), label, title, totalKG: 0, totalCBM: 0, packagesCount: 0 });
    cursor.add(1, granularity);
  }

  rows.forEach(row => {
    const key = moment.tz(row._id.day, 'YYYY-MM-DD', HOME_TZ).startOf(granularity).format('YYYY-MM-DD');
    const bucket = buckets.find(b => b.key === key);
    if (!bucket) return;
    if (row._id.unit === 'KG') bucket.totalKG += row.totalWeight || 0;
    if (row._id.unit === 'CBM') bucket.totalCBM += row.totalWeight || 0;
    bucket.packagesCount += row.packagesCount || 0;
  });

  return buckets.map(({ key, ...point }) => point);
};

// Open orders right now, plus KG/CBM/packages shipped in the range, split by office (Order.placedAt)
const getOfficeBreakdown = async (start, end) => {
  const [activeOrdersByOffice, shipmentsByOffice] = await Promise.all([
    Orders.aggregate([
      { $match: { isFinished: false, unsureOrder: false, isCanceled: false, placedAt: { $in: OFFICE_KEYS } } },
      { $group: { _id: '$placedAt', count: { $sum: 1 } } },
    ]),
    Orders.aggregate([
      { $unwind: '$paymentList' },
      { $match: deliveredInRange(start, end, { placedAt: { $in: OFFICE_KEYS } }) },
      { $group: {
          _id: { office: '$placedAt', unit: '$paymentList.deliveredPackages.weight.measureUnit' },
          totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
          packagesCount: { $sum: 1 },
      } },
    ]),
  ]);

  return OFFICE_KEYS.map(office => {
    const groups = shipmentsByOffice.filter(g => g._id.office === office);
    return {
      office,
      activeOrders: activeOrdersByOffice.find(g => g._id === office)?.count || 0,
      totalKG: sumMeasure(groups, 'KG'),
      totalCBM: sumMeasure(groups, 'CBM'),
      packagesCount: sumPackages(groups),
    };
  });
};

// Latest orders and wallet payments in the range merged into one feed, newest first
const getRecentActivity = async (limit, start, end) => {
  const createdAt = inRange(start, end);
  const [recentOrders, recentStatements] = await Promise.all([
    Orders.find({ unsureOrder: false, createdAt })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('orderId customerInfo.fullName totalInvoice placedAt createdAt isCanceled')
      .lean(),
    UserStatement.find({ createdAt })
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

// Query: from, to (YYYY-MM-DD, inclusive), optional prevFrom/prevTo for the comparison.
// Every figure except active orders and total clients is limited to that range.
module.exports.getHomeData = async (req, res, next) => {
  const range = getHomeRange(req.query);
  if (!range) {
    return next(new ErrorHandler(400, 'Invalid date range'));
  }
  const { start, end, previousStart, previousEnd, granularity } = range;

  try {
    const [
      offices,
      activeOrdersCount,
      debts,
      credits,
      clientUsersCount,
      newClientsCount,
      previousNewClientsCount,
      totalInvoices,
      previousTotalInvoices,
      ordersNetIncome,
      previousOrdersNetIncome,
      shipmentEarning,
      previousShipmentEarning,
      currentShipments,
      previousShipments,
      shipmentTrend,
      officeBreakdown,
      recentActivity,
    ] = await Promise.all([
      Office.find({ office: OFFICE_KEYS }),
      Orders.countDocuments({ isFinished: false, unsureOrder: false, isCanceled: false }),
      Orders.find({ 'debt.total': { $gt: 0 } }).populate('user'),
      Orders.find({ 'credit.total': { $gt: 0 } }).populate('user'),
      User.countDocuments({ 'roles.isClient': true }),
      User.countDocuments({ 'roles.isClient': true, createdAt: inRange(start, end) }),
      User.countDocuments({ 'roles.isClient': true, createdAt: inRange(previousStart, previousEnd) }),
      getTotalInvoices(start, end),
      getTotalInvoices(previousStart, previousEnd),
      getOrdersNetIncome(start, end),
      getOrdersNetIncome(previousStart, previousEnd),
      getShipmentEarning(start, end),
      getShipmentEarning(previousStart, previousEnd),
      getShipmentTotals(start, end),
      getShipmentTotals(previousStart, previousEnd),
      getShipmentTrend(start, end, granularity),
      getOfficeBreakdown(start, end),
      getRecentActivity(8, start, end),
    ]);

    const totalEarning = ordersNetIncome + shipmentEarning;
    const previousTotalEarning = previousOrdersNetIncome + previousShipmentEarning;

    res.status(200).json({
      range: {
        from: start.format('YYYY-MM-DD'),
        to: end.format('YYYY-MM-DD'),
        previousFrom: previousStart.format('YYYY-MM-DD'),
        previousTo: previousEnd.format('YYYY-MM-DD'),
        granularity,
      },
      monthlyEarning: [
        { type: 'payment', total: ordersNetIncome },
        { type: 'shipment', total: shipmentEarning },
      ],
      totalMonthlyEarning: totalEarning,
      previousTotalEarning,
      betterThenPreviousMonth: totalEarning > previousTotalEarning,
      percentage: previousTotalEarning ? Math.floor(Math.abs(((totalEarning - previousTotalEarning) / previousTotalEarning) * 100)) : 0,
      activeOrdersCount,
      totalInvoices,
      previousTotalInvoices,
      offices,
      debts,
      credits,
      clientUsersCount,
      newClientsCount,
      previousNewClientsCount,
      shipmentStats: {
        ...currentShipments,
        previousTotalKG: previousShipments.totalKG,
        previousTotalCBM: previousShipments.totalCBM,
        previousPackagesCount: previousShipments.packagesCount,
      },
      shipmentTrend,
      officeBreakdown,
      recentActivity,
    });
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
