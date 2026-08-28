const { errorMessages } = require("../constants/errorTypes");
const Order = require("../models/order");
const OrderPaymentHistory = require("../models/orderPaymentHistory");
const UserStatement = require("../models/userStatement");
const Wallet = require("../models/wallet");
const Inventory = require('../models/inventory');
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

module.exports.getLatestStatements = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit === '0' ? 0 : (parseInt(req.query.limit) || 15);
    const skip = (page - 1) * limit;

    // 1. Build dynamic query object based on optional filters
    const query = {};
    
    // Filter by calculationType (+ or -) if provided
    if (req.query.calculationType) {
      query.calculationType = req.query.calculationType === 'plus' ? '+' : req.query.calculationType === 'minus' ? '-' : undefined;
    }

    // Filter by Date Range (createdAt) if provided
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      
      if (req.query.startDate) {
        query.createdAt.$gte = new Date(req.query.startDate);
      }
      
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999); 
        query.createdAt.$lte = end;
      }
    }

    // 2. Fetch paginated records using the constructed query filter
    const statements = await UserStatement.find(query)
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(limit)
      .populate('user', 'firstName lastName customerId')
      .populate('createdBy', 'firstName lastName')
      .lean()
      .exec();

// 3. مطابقة الرحلات باستعلام واحد فقط لدعم أرقام التتبع المكررة
    if (req.query.includeOdoCode === 'true' && statements.length > 0) {
      
      // أ) تخزين جميع الـ statements المرتبطة بنفس رقم التتبع في مصفوفة
      const trackingMap = new Map();

      statements.forEach(statement => {
        const match = statement.description?.match(/تم دفع قيمة الشحن\s+([A-Za-z0-9]+)/);
        if (match && match[1]) {
          const trackingNumber = match[1];
          
          // إذا كان رقم التتبع موجوداً مسبقاً نضيف إليه، وإلا ننشئ مصفوفة جديدة
          if (!trackingMap.has(trackingNumber)) {
            trackingMap.set(trackingNumber, []);
          }
          trackingMap.get(trackingNumber).push(statement);
        }
      });

      const trackingNumbers = Array.from(trackingMap.keys());

      // ب) تنفيذ استعلام واحد فقط لجلب الرحلات المرتبطة
      if (trackingNumbers.length > 0) {
        const matchedInventories = await Inventory.find({
          inventoryType: 'inventoryGoods',
          'orders.paymentList.deliveredPackages.trackingNumber': { $in: trackingNumbers }
        })
        .sort({ createdAt: 1 }) // الأقدم أولاً
        .select('odoReferenceCode orders.paymentList.deliveredPackages.trackingNumber')
        .lean();

        // ج) تحديث جميع المعاملات التي تحمل هذا الرقم
        matchedInventories.forEach(inv => {
          if (inv.odoReferenceCode && Array.isArray(inv.orders)) {
            inv.orders.forEach(order => {
              const trackingNumber = order?.paymentList?.deliveredPackages?.trackingNumber;
              
              if (trackingNumber && trackingMap.has(trackingNumber)) {
                // جلب كل المعاملات المربوطة بهذا الرقم (سواء LYD أو USD)
                const targetStatements = trackingMap.get(trackingNumber);
                
                targetStatements.forEach(targetStatement => {
                  if (!targetStatement.odoReferenceCode) {
                    targetStatement.odoReferenceCode = inv.odoReferenceCode;
                  }
                });
              }
            });
          }
        });
      }
    }

    // 4. Check if there are more records beyond this page
    const totalCount = await UserStatement.countDocuments(query);
    const hasMore = limit === 0 ? false : (skip + statements.length < totalCount);

    // 5. Send response
    res.status(200).json({
      statements,
      hasMore
    });

  } catch (error) {
    console.error("Error fetching statements:", error);
    res.status(500).json({ error: 'Internal Server Error fetching statements' });
  }
};

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

module.exports.getAllActiveWallets = async (req, res, next) => {
  try {
    const wallets = await Wallet.aggregate([
      {
        $group: {
          _id: "$user",
          // Sum up LYD specifically
          lydBalance: {
            $sum: { $cond: [{ $eq: ["$currency", "LYD"] }, "$balance", 0] }
          },
          // Sum up USD specifically
          usdBalance: {
            $sum: { $cond: [{ $eq: ["$currency", "USD"] }, "$balance", 0] }
          }
        }
      },
      // THIS IS THE FILTER YOU ASKED ABOUT:
      {
        $match: {
          $or: [
            { lydBalance: { $ne: 0 } },
            { usdBalance: { $ne: 0 } }
          ]
        }
      },
      {
        $lookup: {
          from: "users", 
          localField: "_id",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: "$user" }
    ]);

    res.status(200).json({ results: wallets });
  } catch (error) {
    next(error);
  }
};

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


