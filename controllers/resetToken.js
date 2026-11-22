
const { errorMessages } = require("../constants/errorTypes");
const User = require('../models/user');
const Token = require('../models/token');
const ErrorHandler = require('../utils/errorHandler');
const bcrypt = require('bcryptjs');
const crypto = require("crypto");
const { sendEmail } = require("../utils/sender");

module.exports.sendPasswordToken = async (req, res, next) => {
  try {
    // Text only, and matched in any letter case (as sign-in does): older accounts kept the case they
    // were typed with. Escaped, so characters like . or * in it are not a pattern.
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    if (!email) return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } });

    if (!user) {
      return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));
    }
    let token = await Token.findOne({ userId: user._id });
    if (token) { 
      await token.deleteOne()
    };

    const resetToken = crypto.randomBytes(32).toString("hex");
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(resetToken, salt);
    
    await new Token({
      userId: user._id,
      token: hash,
      createdAt: Date.now(),
    }).save();

    await sendEmail(user.username, 'اعادة كلمة المرور', {
      fullName: `${user.firstName} ${user.lastName}`,
      resetLink: `https://www.exioslibya.com/reset-password?token=${resetToken}&id=${user._id}`,
    }, '../templates/resetPassword.handlebars');
    res.status(200).send({});

  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.resetNewPassword = async (req, res, next) => {
  try {
    const { password, userId, token } = req.body;
    if (typeof password !== 'string' || password.length < 6 || typeof userId !== 'string' || typeof token !== 'string') {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    const passwordResetToken = await Token.findOne({ userId });
    if (!passwordResetToken) {
      return next(new ErrorHandler(404, errorMessages.TOKEN_NOT_FOUND));
    }
    const isValid = await bcrypt.compare(token, passwordResetToken.token);
    if (!isValid) {
      return next(new ErrorHandler(404, errorMessages.INVALID_TOKEN));
    }
    const hash = await bcrypt.hash(password, 12);
    await User.updateOne(
      { _id: userId },
      // a new password also lifts any sign-in pause from wrong passwords
      // and ends every session opened with the old one (check-auth.protect)
      { $set: { password: hash, failedLoginCount: 0, passwordChangedAt: new Date() }, $unset: { failedLoginSince: '', loginLockedUntil: '' } },
      { new: true }
    );

    const user = await User.findOne({ _id: userId });
    await sendEmail(
      user.username,
      "تم تغيير كلمة مرورك بنجاح",
      {
        fullName: `${user.firstName} ${user.lastName}`,
      },
      "../templates/passwordChanged.handlebars"
    );
    await passwordResetToken.deleteOne();
    res.status(200).send({ ok: true });

  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

