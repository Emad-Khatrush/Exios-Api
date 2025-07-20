const { errorMessages } = require("../constants/errorTypes");
const Order = require("../models/order");
const OrderPaymentHistory = require("../models/orderPaymentHistory");
const UserStatement = require("../models/userStatement");
const Wallet = require("../models/wallet");
const ErrorHandler = require('../utils/errorHandler');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types; // Import new ObjectId from mongoose
const { uploadToGoogleCloud } = require('../utils/googleClould');

module.exports.getUserWallet = async (req, res, next) => {
  try {
    const { id } = req.params;

    const wallet = await Wallet.find({ user: new ObjectId(id) }).populate('user');
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

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-wallets");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

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
      note,
      attachments: files
    });

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.cancelPayment = async (req, res, next) => {
  const { id } = req.params;
  const { payment } = req.body;

  try {
    if (payment.paymentType !== 'wallet') {
      await OrderPaymentHistory.findOneAndDelete({ _id: payment._id });
      return res.status(200).json({
        createdAt: new Date()
      });
    }
    await Wallet.findOneAndUpdate(
      {
        user: id,
        currency: payment.currency,
      },
      {
        $inc: { balance: payment.receivedAmount }
      },
      {
        new: true, // Return the updated document
      }
    );
    const lastUserStatement = await UserStatement.find({ user: id, currency: payment.currency }).sort({ _id: -1 }).limit(1);
    const total = (lastUserStatement[0]?.total || 0) + Number(payment.receivedAmount);
    const userStatement = await UserStatement.create({
      user: id,
      createdBy: req.user,
      calculationType: '+',
      paymentType: 'wallet',
      createdAt: new Date(),
      description: `${payment.createdBy.firstName} ${payment.createdBy.lastName} الغاء عملية الدفع كود ${payment.order.orderId} واسترجاع القيمة الى المحفظة من طرف `,
      amount: payment.receivedAmount,
      currency: payment.currency,
      total,
      note: `${payment.category} Cancellation Refund`,
      attachments: payment.attachments
    });
    await OrderPaymentHistory.findOneAndDelete({ _id: payment._id });
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

    const userStatement = await UserStatement.find({ user: new ObjectId(id), currency }).sort({ _id: -1 }).populate('user');
    if (!userStatement) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatement
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.verifyStatement = async (req, res, next) => {
  try {
    const { statementId, id } = req.params;
    const { receivedDate } = req.body;

    const review = { receivedDate, isAdminConfirmed: true }
    const userStatement = await UserStatement.updateMany({ _id: statementId, user: id }, { $set: { review } });
    if (!userStatement) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatement
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getUnverifiedUsersStatement = async (req, res, next) => {
  try {
    const { tab } = req.query;

    let userStatements;
    let query = [
      {
        $match: { review: { $exists: false } }  // Match documents where review does not exist
      },
      {
        $group: {
          _id: "$user",                          // Group by user field
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
      }
    ]

    if (tab === 'openedWallet') {
      query = [
        {
          $group: {
            _id: "$user",                          // Group by user field
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
        }
      ]
    }

    userStatements = await UserStatement.aggregate(query);

    if (!userStatements) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatements
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
    const { createdAt, amount, currency, description, note, orderId, category, rate } = req.body;

    const truncateToTwo = (num) => Math.trunc(num * 100) / 100;

    const wallet = await Wallet.findOne({
      user: id,
      currency,
    });
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    if (wallet.balance < amount) {
      throw next(new ErrorHandler(400, 'Insufficient wallet balance'));
    }

    let list = [];
    if (req.body.list && typeof req.body.list === 'string') {
      list = JSON.parse(req.body.list);
    }

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-wallets");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    // Calculate new wallet balance with truncation to 2 decimals
    const newBalance = truncateToTwo(wallet.balance - Number(amount));

    // Update wallet with new balance
    await Wallet.findOneAndUpdate(
      {
        user: id,
        currency,
      },
      {
        balance: newBalance
      },
      {
        new: true,
      }
    );

    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1);
    const previousTotal = Number(lastUserStatement[0]?.total || 0);

    // Calculate total with truncation to two decimals
    const total = truncateToTwo(previousTotal - Number(amount));

    const userStatement = await UserStatement.create({
      user: id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt,
      description,
      amount: truncateToTwo(Number(amount)),
      currency,
      total,
      note,
      attachments: files,
    });

    const order = await Order.findOne({ orderId }).populate('user');
    if (order) {
      const data = {
        createdBy: req.user,
        customer: order.user._id,
        order: order._id,
        paymentType: 'wallet',
        receivedAmount: truncateToTwo(Number(amount)),
        currency,
        createdAt,
        rate: Number(rate) || 0,
        note: `(Wallet was ${truncateToTwo(previousTotal)} ${currency})`
      };

      if (category) {
        data.category = category;
        if (category === 'receivedGoods') {
          data.list = list || [];
        }
      }

      await OrderPaymentHistory.create(data);
    }

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};


