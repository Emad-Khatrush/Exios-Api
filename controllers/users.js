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
const { TERMS_VERSION, acceptanceRecord, termsStatus } = require('../utils/termsAcceptance');
const passportNumber = require('../utils/passportNumber');

// A passport already on an account: its number, or the number read from an older account's photo
// (utils/passportBackfill.js) that staff have not confirmed yet
const passportTakenBy = async (number) => !!(await User.exists({
  $or: [{ 'passportVerification.number': number }, { 'passportVerification.numberRead': number }],
}));

module.exports.createUser = async (req, res, next) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  // Only what a customer fills in at sign-up. Everything else on the account (prices, roles, access,
  // status...) is set by us, so it is never taken from the request.
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const email = text(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const repeatedPassword = typeof req.body.repeatedPassword === 'string' ? req.body.repeatedPassword : '';
  const firstName = text(req.body.firstName);
  const lastName = text(req.body.lastName);
  const city = text(req.body.city);
  const phone = Number(formatPhoneNumber(text(req.body.phone)));
  const isAgreeToTermsOfCompany = req.body.isAgreeToTermsOfCompany === true || req.body.isAgreeToTermsOfCompany === 'true';
  // The number the customer confirmed, and what was read from the photo (staff compare them)
  const passportNo = passportNumber.normalize(req.body.passportNumber);
  const passportRead = passportNumber.normalize(req.body.passportNumberRead);

  try {
    if (!req.file) return next(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_REQUIRED));
    if (!email || !password || !firstName || !lastName || !phone) return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    if (repeatedPassword !== password) return next(new ErrorHandler(400, errorMessages.PASSWORD_NOT_MATCH));
    if (!isAgreeToTermsOfCompany) return next(new ErrorHandler(400, errorMessages.TERMS_NOT_ACCEPTED));
    if (!passportNumber.isValid(passportNo)) return next(new ErrorHandler(400, errorMessages.PASSPORT_NUMBER_REQUIRED));
    if (await passportTakenBy(passportNo)) return next(new ErrorHandler(400, errorMessages.PASSPORT_EXIST));
    const customerId = generateString(1, characters) + generateString(3, numbers);
    // Login matches the email in any letter case, so the same email in other case counts as taken
    const userFound = await User.findOne({ $or: [ { customerId }, { username: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } } ] });
    if (!!userFound) return next(new ErrorHandler(400, errorMessages.USER_EXIST));

    const phoneExist = await User.findOne({ phone });
    if (!!phoneExist) return next(new ErrorHandler(400, errorMessages.PHONE_EXIST));

    const uploadedPassport = await uploadToGoogleCloud(req.file, 'exios-passports');
    if (!uploadedPassport?.publicUrl) return next(new ErrorHandler(500, errorMessages.PASSPORT_UPLOAD_FAILED));

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({
      firstName,
      lastName,
      phone,
      city,
      isAgreeToTermsOfCompany,
      termsAcceptance: [acceptanceRecord(req.body.termsVersion, 'signup', req)],
      username: email,
      password: hashedPassword,
      customerId,
      passportVerification: {
        status: 'pending',
        imageUrl: uploadedPassport.publicUrl,
        number: passportNo,
        numberSource: passportRead && passportRead === passportNo ? 'read' : 'typed',
        ...(passportRead && { numberRead: passportRead }),
        submittedAt: new Date(),
      },
      roles: {
        isAdmin: false,
        isEmployee: false,
        isClient: true
      }
    });

    // Invite a friend (spec 2026-11-20): a code that cannot be used leaves the account without an inviter
    // Invited: 500 points; otherwise the new account's 100 (never both)
    const gifts = await require('./referrals').attachAtSignup(user._id, text(req.body.referralCode), text(req.body.referralSource));
    const token = await user.getSignedToken();
    res.status(200).json({ success: true, token: token, ...gifts });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

// Sign-up asks this on its first step, so a used email or phone is caught there and not after the passport upload.
// It uses the same tests as createUser (email in any letter case, phone stored without +, 00, 218 or leading 0).
module.exports.checkSignupAvailability = async (req, res, next) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const phoneText = typeof req.body.phone === 'string' && req.body.phone.trim() ? formatPhoneNumber(req.body.phone) : '';

  try {
    const emailTaken = email
      ? !!(await User.exists({ username: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }))
      : false;
    const phoneTaken = /^\d+$/.test(phoneText) ? !!(await User.exists({ phone: Number(phoneText) })) : false;
    const passportNo = passportNumber.normalize(req.body.passportNumber);
    const passportTaken = passportNumber.isValid(passportNo) ? await passportTakenBy(passportNo) : false;
    res.status(200).json({ emailTaken, phoneTaken, passportTaken });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
}

// Sign-up: the number on the passport photo, for the customer to confirm. { number, checked, taken,
// passport } (number null when it could not be read: the customer types it; passport false when the
// photo does not look like a passport, null when it could not be read at all)
module.exports.readPassportNumber = async (req, res, next) => {
  try {
    if (!req.file) return next(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_REQUIRED));
    const read = await passportNumber.readFromImage(req.file.buffer);
    const taken = read?.number ? await passportTakenBy(read.number) : false;
    res.status(200).json({ number: read?.number || null, checked: !!read?.checked, taken, passport: read ? read.passport : null });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
};

// A new passport photo (never uploaded, or after a rejection): like sign-up, it needs the number the
// customer confirmed (and what was read from the photo), unique among the other accounts
module.exports.uploadPassport = async (req, res, next) => {
  const passportNo = passportNumber.normalize(req.body.passportNumber);
  const passportRead = passportNumber.normalize(req.body.passportNumberRead);
  try {
    if (!req.file) return next(new ErrorHandler(400, errorMessages.PASSPORT_IMAGE_REQUIRED));
    if (!passportNumber.isValid(passportNo)) return next(new ErrorHandler(400, errorMessages.PASSPORT_NUMBER_REQUIRED));
    const takenByOther = await User.exists({
      _id: { $ne: req.user._id },
      $or: [{ 'passportVerification.number': passportNo }, { 'passportVerification.numberRead': passportNo }],
    });
    if (takenByOther) return next(new ErrorHandler(400, errorMessages.PASSPORT_EXIST));

    const uploadedPassport = await uploadToGoogleCloud(req.file, 'exios-passports');
    if (!uploadedPassport?.publicUrl) return next(new ErrorHandler(500, errorMessages.PASSPORT_UPLOAD_FAILED));

    const user = await User.findByIdAndUpdate(req.user._id, {
      $set: {
        'passportVerification.status': 'pending',
        'passportVerification.imageUrl': uploadedPassport.publicUrl,
        'passportVerification.submittedAt': new Date(),
        'passportVerification.rejectionReason': null,
        'passportVerification.number': passportNo,
        'passportVerification.numberSource': passportRead && passportRead === passportNo ? 'read' : 'typed',
        ...(passportRead && { 'passportVerification.numberRead': passportRead }),
      },
      $unset: {
        'passportVerification.reviewedAt': '',
        'passportVerification.reviewedBy': '',
        // A read from the old photo no longer describes this one
        ...(!passportRead && { 'passportVerification.numberRead': '' }),
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
    const number = passportNumber.normalize(req.body.passportNumber);

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

    // Approving needs the passport number (read at sign-up, or typed by staff for older accounts), unique
    if (status === 'verified') {
      if (!passportNumber.isValid(number)) return next(new ErrorHandler(400, 'اكتب رقم جواز السفر قبل الموافقة'));
      if (await User.exists({ _id: { $ne: id }, 'passportVerification.number': number })) {
        return next(new ErrorHandler(400, 'رقم الجواز هذا مسجّل بحساب آخر'));
      }
      updateFields['passportVerification.number'] = number;
    }

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

// The account, with where it stands on the terms: the app asks again when the current version was
// not agreed to yet
const withTerms = (user) => ({ ...user.toObject(), terms: termsStatus(user) });

module.exports.getMyAccount = async (req, res, next) => {
  try {
    res.status(200).json(withTerms(req.user));
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

// The customer agrees to the current terms (asked after they changed). The version they were shown must
// be the current one, so an app left open on older terms cannot record agreement to the new ones.
// Agreeing again to the same version records nothing new.
module.exports.acceptTerms = async (req, res, next) => {
  try {
    if (req.body?.version !== TERMS_VERSION) return next(new ErrorHandler(409, errorMessages.TERMS_VERSION_OUTDATED));
    let user = req.user;
    if (termsStatus(user).needsAcceptance) {
      user = await User.findByIdAndUpdate(user._id, {
        $set: { isAgreeToTermsOfCompany: true },
        $push: { termsAcceptance: acceptanceRecord(TERMS_VERSION, 'prompt', req) },
      }, { new: true, projection: { password: 0 } });
    }
    res.status(200).json(withTerms(user));
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
}

// The customer may change their city only. The name is checked against the passport and the phone is
// how they sign in and how invites are told apart, so the office changes those (PUT customer/:id/info).
module.exports.updateUser = async (req, res, next) => {
  const same = (field, value) => value === undefined || value === null || String(value).trim() === String(req.user[field] ?? '');
  const { firstName, lastName, phone } = req.body;
  if (!same('firstName', firstName) || !same('lastName', lastName) || !(phone === undefined || phone === null || Number(formatPhoneNumber(String(phone))) === req.user.phone)) {
    return next(new ErrorHandler(400, 'لتغيير الاسم أو رقم الهاتف تواصل مع المكتب'));
  }
  const city = typeof req.body.city === 'string' ? req.body.city.trim().slice(0, 60) : undefined;

  try {
    const user = await User.findByIdAndUpdate(req.user._id, { ...(city !== undefined && { city }) }, { new: true });
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

// Sign-in protection: 10 wrong passwords within 15 minutes pause sign-in to that account for
// 15 minutes. Resetting the password (forgot password) lifts the pause at once.
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_SECRETS = '+password +failedLoginCount +failedLoginSince +loginLockedUntil';

module.exports.login = async (req, res, next) => {
  const { loginType, loginMethod } = req.body;
  // Text only: an object here ({ "$ne": null }…) must not reach the database query
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
  }

  try {
    let user;
    if (loginMethod === 'phone') {
      user = await User.findOne({ phone: Number(formatPhoneNumber(username)) }).select(LOGIN_SECRETS);
    } else {
      // The email is matched as plain text (any letter case). Escaped, so ".*" or other patterns in
      // it cannot match someone else's account or slow the database down.
      user = await User.findOne({ username: { $regex: `^${escapeRegex(username)}$`, $options: 'i'} }).select(LOGIN_SECRETS);
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
    // Paused after too many wrong passwords: not even checked until the pause ends
    const now = Date.now();
    if (user.loginLockedUntil && user.loginLockedUntil.getTime() > now) {
      return next(new ErrorHandler(429, errorMessages.ACCOUNT_LOCKED));
    }

    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      // Count it; wrong passwords older than the window start a new count
      const fresh = !user.failedLoginSince || now - user.failedLoginSince.getTime() > LOGIN_WINDOW_MS;
      const count = (fresh ? 0 : user.failedLoginCount || 0) + 1;
      if (count >= MAX_FAILED_LOGINS) {
        await User.updateOne({ _id: user._id }, {
          $set: { loginLockedUntil: new Date(now + LOGIN_LOCK_MS), failedLoginCount: 0 },
          $unset: { failedLoginSince: '' },
        });
        return next(new ErrorHandler(429, errorMessages.ACCOUNT_LOCKED));
      }
      await User.updateOne({ _id: user._id }, {
        $set: { failedLoginCount: count, ...(fresh ? { failedLoginSince: new Date(now) } : {}) },
      });
      return next(new ErrorHandler(404, errorMessages.INVALID_CREDENTIALS));
    }

    // Signed in: forget earlier wrong passwords
    if (user.failedLoginCount || user.loginLockedUntil) {
      await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0 }, $unset: { failedLoginSince: '', loginLockedUntil: '' } });
    }
    // The same account again, without the password
    user = await User.findById(user._id, { password: 0 });
    
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

  if (!token || typeof token !== 'string') return next(new ErrorHandler(404, errorMessages.TOKEN_NOT_FOUND));

  try {
    const tokenConfig = await jwt.verify(token, process.env.JWT_SECRET);
    // The apps ask this when they open: a session ended by a password change (or a cancelled account)
    // is refused here, so the app signs out instead of failing on every request
    const user = await User.findById(tokenConfig.id).select('isCanceled +passwordChangedAt').lean();
    if (!user || user.isCanceled) return next(new ErrorHandler(401, errorMessages.INVALID_TOKEN));
    if (user.passwordChangedAt && Number(tokenConfig.iat) < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
      return next(new ErrorHandler(401, errorMessages.INVALID_TOKEN));
    }

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
