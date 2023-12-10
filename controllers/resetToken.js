
const { errorMessages } = require("../constants/errorTypes");
const User = require('../models/user');
const Token = require('../models/token');
const ErrorHandler = require('../utils/errorHandler');
const bcrypt = require('bcryptjs');
const crypto = require("crypto");
const { sendEmail } = require("../utils/sender");

module.exports.sendPasswordToken = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ username: email });

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

    await sendEmail(email, 'اعادة كلمة المرور', {
      fullName: `${user.firstName} ${user.lastName}`,
      resetLink: `http://www.exioslibya.com/reset-password?token=${resetToken}&id=${user._id}`,
    }, '../templates/resetPassword.handlebars');
    res.status(200).send({});

  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.resetNewPassword = async (req, res, next) => {
  try {
    const { password, userId, token } = req.body;

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
      { $set: { password: hash } },
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

