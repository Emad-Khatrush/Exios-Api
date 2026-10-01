const Balance = require('../models/balance');
const Orders = require('../models/order');
const Users = require('../models/user');
const Wallets = require('../models/wallet');
const UserStatement = require('../models/userStatement');
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const Activities = require('../models/activities');

const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { emitAccountingEvent } = require('../accounting/services/events');

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
          updatedAt: -1,
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0]?.results
    debts = await Balance.populate(debts, [{ path: "order" }, { path: "owner" }, { path: "createdBy" }, { path: "manualClosure.closedBy", select: "firstName lastName" }]);
    
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
          waitingApprovalDebtsCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$status", 'waitingApproval'] }, { $eq: ["$createdOffice", officeType] }] },
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
        lostDebtsCount: 0,
        waitingApprovalDebtsCount: 0
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
    const { balanceType, amount, currency, orderId, customerId, notes, createdOffice, debtType } = req.body;
    // customerId is only needed when the debt is not tied to an order
    if (!balanceType || !amount || !currency || (!customerId && !orderId) || !notes || !createdOffice) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    // A debt on an order belongs to whoever owns the order, so it follows the order
    // if its customer is changed later (see syncOrderDebtsOwner in updateOrder)
    let order;
    let user;
    if (orderId) {
      order = await Orders.findOne({ orderId: String(orderId).trim() }).populate('user');
      if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
      if (!order.user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));
      user = order.user;

      if (customerId && String(user.customerId).toLowerCase() !== String(customerId).trim().toLowerCase()) {
        return next(new ErrorHandler(400, errorMessages.BALANCE_ORDER_CUSTOMER_MISMATCH));
      }
    } else {
      user = await Users.findOne({ customerId });
      if (!user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));
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
      debtType,
      followsOrder: !!order,
    })
    await emitAccountingEvent('balance', balance._id, {}, req.user);
    
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

    const truncateToTwo = (num) => Math.trunc(num * 100) / 100;

    if (!createdAt || !rate || !amount || !currency) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    const existingBalance = await Balance.findOne({ _id: id }).populate(['owner', 'order']);
    if (!existingBalance) {
      return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));
    }

    if (existingBalance.currency === 'LYD' && currency === 'USD') {
      return next(new ErrorHandler(400, errorMessages.BALANCE_CURRENCY_NOT_ACCEPTED));
    }

    if (existingBalance.amount === 0) {
      return next(new ErrorHandler(400, errorMessages.BALANCE_ALREADY_PAID));
    }

    if (Number(rate) === 0 && currency === 'LYD' && existingBalance.currency === 'USD') {
      return next(new ErrorHandler(400, errorMessages.BALANCE_RATE_ZERO));
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

    const wallet = await Wallets.findOne({
      user: existingBalance.owner._id,
      currency,
    });
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    if (wallet.balance < amount) {
      return next(new ErrorHandler(400, 'Insufficient wallet balance'));
    }

    let updatedAmount;

    if (sameCurrency === 'false') {
      const amountToDecrement = truncateToTwo(amount / rate);
      updatedAmount = truncateToTwo(existingBalance.amount - amountToDecrement);
    } else {
      updatedAmount = truncateToTwo(existingBalance.amount - Number(amount));
    }

    // Ensure updatedAmount is never negative
    if (updatedAmount < 0) {
      updatedAmount = 0;
    }

    let updateQuery = {
      $set: { amount: updatedAmount },
      $push: { "paymentHistory": req.body },
    };

    if (updatedAmount === 0) {
      updateQuery.$set.status = 'waitingApproval';
    }

    const balance = await Balance.findByIdAndUpdate({ _id: id }, updateQuery, { safe: true, upsert: true, new: true });
    if (!balance) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));

    // Update the wallet balance (deducting payment amount)
    const newWalletBalance = truncateToTwo(wallet.balance - Number(amount));
    await Wallets.findOneAndUpdate(
      {
        user: existingBalance.owner._id,
        currency,
      },
      {
        balance: newWalletBalance
      },
      {
        new: true,
      }
    );

    const lastUserStatement = await UserStatement.find({ user: existingBalance.owner._id, currency }).sort({ _id: -1 }).limit(1);
    const previousTotal = Number(lastUserStatement[0]?.total || 0);
    const total = truncateToTwo(previousTotal - Number(amount));

    const debtMessage = (req.body?.debtType || existingBalance?.debtType) === 'invoice'
      ? 'فاتورة'
      : (req.body?.debtType || existingBalance?.debtType) === 'receivedGoods'
        ? 'بضاعة مستلمة'
        : 'دين عام';

    const debtStatement = await UserStatement.create({
      user: existingBalance.owner._id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt,
      description: `${existingBalance?.order ? existingBalance?.order.orderId : ''} دفع دين لسداد قيمة (${debtMessage})`,
      amount: truncateToTwo(Number(amount)),
      currency,
      total,
      note: `Payment for ${existingBalance?.debtType || ''} debt ${existingBalance?.order ? existingBalance?.order?.orderId : ''} #${balance.notes}`,
      attachments: files,
      actionType: 'wallet',
      ...(currency === 'LYD' && Number(rate) > 0 && { rate: Number(rate) }),
    });

    if (existingBalance.order && existingBalance.debtType !== 'general') {
      const data = {
        createdBy: req.user,
        customer: existingBalance.owner._id,
        order: existingBalance.order._id,
        paymentType: 'wallet',
        receivedAmount: truncateToTwo(Number(amount)),
        currency,
        createdAt,
        rate: Number(rate) || 0,
        note: `(Wallet was ${truncateToTwo(previousTotal)} ${currency})`,
        category: existingBalance.debtType,
        statementId: debtStatement._id,
      };
      await OrderPaymentHistory.create(data);
    }
    await emitAccountingEvent('statement', debtStatement._id, { target: { balanceId: existingBalance._id } }, req.user);

    res.status(200).json(balance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
};


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

module.exports.searchForDebt = async (req, res, next) => {
  try {
    const { searchValue } = req.query;
    let query = [
      {
        $addFields: {
          'owner.fullName': { $concat: ['$owner.firstName', ' ', '$owner.lastName'] }
        }
      },
      {
        $match: {
          balanceType: 'debt',
          $or: [
            { 'order.orderId': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
            { 'owner.customerId': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
            { 'owner.phone': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
            { 'owner.fullName': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } }
          ]
        }
      }
    ];

    // populate user data
    query.unshift(
    {
      $lookup: {
        from: 'users',
        localField: 'owner',
        foreignField: '_id',
        as: 'owner'
      }
    },
    {
      $lookup: {
        from: 'orders',
        localField: 'order',
        foreignField: '_id',
        as: 'order'
      }
    },
    {
      $unwind: '$owner'
    },
    {
      $unwind: {
        path: '$order',
        preserveNullAndEmptyArrays: true // Preserve documents if order is empty or missing
      }
    })

    query.push(
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
          updatedAt: -1
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    )
    let debts = (await Balance.aggregate(query))[0]?.results;
    debts = await Balance.populate(debts, [{ path: "owner" }, { path: "order" }, { path: "createdBy" }, { path: "manualClosure.closedBy", select: "firstName lastName" }]);

    res.status(200).json(debts);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.checkDebtsByUser = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const debts = await Balance.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'owner',
          foreignField: '_id',
          as: 'owner'
        }
      },
      {
        $unwind: '$owner'
      },
      {
        $match: {
          status: 'open',
          'owner.customerId': customerId
        }
      }
    ])
    if (!debts) return next(new ErrorHandler(400, errorMessages.BALANCE_NOT_FOUND));
    
    res.status(200).json(debts);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.confirmDebt = async (req, res, next) => {
  try {
    const { id } = req.params;
    const balance = await Balance.updateOne({ _id: id }, { $set: { status: 'closed' } });
    if (!balance) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));
    
    res.status(200).json(balance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

// Close a debt by hand when only a small remainder is left (e.g. 0.1$).
// The debt is marked closed and the remainder is written off into a new 'lost' debt with the same note.
// No money moves, so wallets and statements are untouched.
module.exports.closeDebtManually = async (req, res, next) => {
  try {
    const { id } = req.params;
    const note = String(req.body?.note || '').trim();
    if (!note) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    const existingBalance = await Balance.findOne({ _id: id, balanceType: 'debt' });
    if (!existingBalance) {
      return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));
    }

    if (!['open', 'overdue'].includes(existingBalance.status)) {
      return next(new ErrorHandler(400, errorMessages.BALANCE_NOT_CLOSABLE));
    }

    const writtenOffAmount = Math.trunc(Number(existingBalance.amount || 0) * 100) / 100;
    const closedAt = new Date();

    // Only close it if nobody changed it since we read it (a payment or another close in between)
    const closedBalance = await Balance.findOneAndUpdate(
      { _id: id, status: existingBalance.status, amount: existingBalance.amount },
      {
        $set: {
          status: 'closed',
          amount: 0,
          manualClosure: {
            note,
            writtenOffAmount,
            closedAt,
            closedBy: req.user._id,
          },
        },
      },
      { new: true }
    );
    if (!closedBalance) {
      return next(new ErrorHandler(409, errorMessages.BALANCE_NOT_CLOSABLE));
    }

    if (writtenOffAmount > 0) {
      let lostBalance;
      try {
        lostBalance = await Balance.create({
          balanceType: 'debt',
          status: 'lost',
          amount: writtenOffAmount,
          initialAmount: writtenOffAmount,
          currency: existingBalance.currency,
          createdOffice: existingBalance.createdOffice,
          debtType: existingBalance.debtType,
          order: existingBalance.order,
          owner: existingBalance.owner,
          createdBy: req.user,
          notes: note,
          sourceBalance: existingBalance._id,
        });
      } catch (error) {
        // Put the original debt back so the remainder is not silently lost
        await Balance.updateOne(
          { _id: id },
          { $set: { status: existingBalance.status, amount: existingBalance.amount }, $unset: { manualClosure: 1 } }
        );
        throw error;
      }

      closedBalance.manualClosure.lostBalance = lostBalance._id;
      await closedBalance.save();
      await emitAccountingEvent('balanceWriteOff', closedBalance._id, {}, req.user);
    }

    res.status(200).json(closedBalance);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
}

// Admin only: remove a debt that was created by mistake.
// Debts with payments are refused - those payments already changed the wallet and statements.
module.exports.deleteBalance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const balance = await Balance.findOne({ _id: id }).populate('owner', 'customerId');
    if (!balance) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));

    if ((balance.paymentHistory || []).length > 0) {
      return next(new ErrorHandler(400, errorMessages.BALANCE_HAS_PAYMENTS));
    }

    await Balance.deleteOne({ _id: id });
    await emitAccountingEvent('balanceDeleted', balance._id, {}, req.user);

    // A debt closed by hand has a matching 'lost' remainder; it goes with it.
    // Deleting that 'lost' remainder instead leaves the closed debt, but drops its link.
    if (balance.manualClosure?.lostBalance) {
      await Balance.deleteOne({ _id: balance.manualClosure.lostBalance });
    }
    if (balance.sourceBalance) {
      await Balance.updateOne({ _id: balance.sourceBalance }, { $unset: { 'manualClosure.lostBalance': 1 } });
    }

    await Activities.create({
      user: req.user,
      details: {
        path: '/balances',
        status: 'deleted',
        type: 'debt',
        actionId: String(balance._id),
      },
      changedFields: [
        { label: 'Customer', value: balance.owner?.customerId || String(balance.owner?._id || '') },
        { label: 'Amount', value: `${balance.initialAmount} ${balance.currency}` },
        { label: 'Status', value: balance.status },
        { label: 'Notes', value: balance.notes },
      ],
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, errorMessages.SERVER_ERROR));
  }
}

module.exports.getDebtOfUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const debts = await Balance.find({ owner: userId, status: 'open' });
    if (!debts) return next(new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND));
    
    res.status(200).json(debts);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}
