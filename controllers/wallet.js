const { errorMessages } = require("../constants/errorTypes");
const UserStatement = require("../models/userStatement");
const Wallet = require("../models/wallet");
const ErrorHandler = require('../utils/errorHandler');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types; // Import ObjectId from mongoose

module.exports.getUserWallet = async (req, res, next) => {
  try {
    const { id } = req.params;

    const wallet = await Wallet.find({ user: ObjectId(id) }).populate('user');
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: wallet
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.addBalanceToWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, amount, currency, description, note } = req.body;

    const existWallet = await Wallet.findOne({ user: id, currency });
    if (existWallet) {
      await Wallet.findOneAndUpdate(
        {
          user: id,
          currency,
        },
        {
          $inc: { balance: amount }
        },
        {
          new: true, // Return the updated document
        }
      );
    } else {
      await Wallet.create({
        user: id,
        balance: amount,
        currency,
        createdAt
      });
    }
    
    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1);
    const total = (lastUserStatement[0]?.total || 0) + Number(amount);
    const userStatement = await UserStatement.create({
      user: id,
      createdBy: req.user,
      calculationType: '+',
      paymentType: 'wallet',
      createdAt,
      description,
      amount,
      currency,
      total,
      note
    });

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getUserStatement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { currency } = req.query;

    const userStatement = await UserStatement.find({ user: ObjectId(id), currency }).sort({ _id: -1 }).populate('user');
    if (!userStatement) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatement
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getAllWallets = async (req, res, next) => {
  try {
    const wallets = await Wallet.find({ balance: { $ne: 0 } }).sort({ user: -1 }).populate('user');
    if (!wallets) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: wallets
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.useBalanceOfWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, amount, currency, description, note } = req.body;

    const wallet = await Wallet.findOne({
      user: id,
      currency,
    });
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    if (wallet.balance < amount) {
      throw next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));
    }

    await Wallet.findOneAndUpdate(
      {
        user: id,
        currency,
      },
      {
        $inc: { balance: -amount }
      },
      {
        new: true, // Return the updated document
      }
    );

    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1);
    const total = (lastUserStatement[0]?.total || 0) - Number(amount);
    const userStatement = await UserStatement.create({
      user: id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt,
      description,
      amount,
      currency,
      total,
      note
    });

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

