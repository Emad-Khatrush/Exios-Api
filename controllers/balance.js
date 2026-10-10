const Balance = require('../models/balance');
const mongoose = require('mongoose');
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
const { runInTransaction } = require('../accounting/services/transaction');
const { debtSource } = require('../accounting/services/moneyAccounts');
const { assertOpenPeriod } = require('../accounting/services/periodGuard');

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
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || !['USD', 'LYD'].includes(currency)) {
      return next(new ErrorHandler(400, 'Debt amount must be positive and currency must be USD or LYD'));
    }
    if (!balanceType || !amount || !currency || (!customerId && !orderId) || !notes || !createdOffice) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }

    // A debt on an order belongs to whoever owns the order, so it follows the order
    // if its customer is changed later (see syncOrderDebtsOwner in updateOrder)
    const result = await runInTransaction(async (session) => {
      await assertOpenPeriod(req.user, new Date(), { session });
      let order;
      let user;
      if (orderId) {
        order = await Orders.findOne({ orderId: String(orderId).trim() }).session(session).populate('user');
        if (!order || order.isDeleted || order.isCanceled) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);
        await Orders.updateOne({ _id: order._id }, { $inc: { accountingMutationVersion: 1 } }, { session });
        if (!order.user) throw new ErrorHandler(400, errorMessages.USER_NOT_FOUND);
        user = order.user;

        if (customerId && String(user.customerId).toLowerCase() !== String(customerId).trim().toLowerCase()) {
          throw new ErrorHandler(400, errorMessages.BALANCE_ORDER_CUSTOMER_MISMATCH);
        }
      } else {
        user = await Users.findOne({ customerId }).session(session);
        if (!user) throw new ErrorHandler(400, errorMessages.USER_NOT_FOUND);
      }

      // General service sales need no funding source; their supplier cost is independent.
      // Linked debts remain reminders of their original invoice/shipping claim.
      let source;
      const serviceSale = balanceType === 'debt' && debtType === 'general';
      if (serviceSale) {
        // Customer selling price is independent of the supplier cost and funding account.
        await require('../accounting/services/roles').resolveAccount('deferred_service_revenue');
        await require('../accounting/services/roles').resolveAccount('revenue_services');
      } else if (balanceType === 'debt') {
        try {
          source = await debtSource({ accountId: req.body.sourceAccountId, currency, orderLinked: !!order && debtType !== 'general' });
        } catch (error) {
          throw new ErrorHandler(400, error.message);
        }
      }

      const [balance] = await Balance.create([{
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
        accountingKind: serviceSale ? 'service_sale' : undefined,
        followsOrder: !!order,
        source,
      }], { session });
      await emitAccountingEvent('balance', balance._id, {}, req.user, { session });

      return balance;
    });
    res.status(200).json(result);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.createPaymentHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, rate, amount, currency } = req.body;

    const roundToTwo = (num) => Math.round(num * 100) / 100;

    const rateValue = rate === undefined || rate === null || rate === '' ? 0 : Number(rate);
    if (!createdAt || !amount || !currency) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    if (!Number.isFinite(Number(amount)) || roundToTwo(Number(amount)) <= 0) {
      return next(new ErrorHandler(400, 'Payment amount must be a positive number'));
    }
    if (typeof rate === 'boolean' || !Number.isFinite(rateValue) || rateValue < 0) {
      return next(new ErrorHandler(400, 'Exchange rate must be a non-negative number'));
    }
    try {
      await assertOpenPeriod(req.user, createdAt);
    } catch (error) {
      return next(error);
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

    const result = await runInTransaction(async (session) => {
      await assertOpenPeriod(req.user, createdAt, { session });
      const existingBalance = await Balance.findOne({ _id: id }).session(session).populate(['owner', 'order']);
      if (!existingBalance) {
        throw new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND);
      }

      if (existingBalance.currency === 'LYD' && currency === 'USD') {
        throw new ErrorHandler(400, errorMessages.BALANCE_CURRENCY_NOT_ACCEPTED);
      }

      if (existingBalance.amount === 0) {
        throw new ErrorHandler(400, errorMessages.BALANCE_ALREADY_PAID);
      }

      if (currency !== existingBalance.currency && rateValue <= 0) {
        throw new ErrorHandler(400, errorMessages.BALANCE_RATE_ZERO);
      }

      const wallet = await Wallets.findOne({
        user: existingBalance.owner._id,
        currency,
      }).session(session);
      if (!wallet) throw new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND);

      if (wallet.balance < amount) {
        throw new ErrorHandler(400, 'Insufficient wallet balance');
      }

      let updatedAmount;

      // Worked out here, not taken from the screen: a payment in another currency is converted at its rate
      if (currency !== existingBalance.currency) {
        const amountToDecrement = roundToTwo(amount / rateValue);
        updatedAmount = roundToTwo(existingBalance.amount - amountToDecrement);
      } else {
        updatedAmount = roundToTwo(existingBalance.amount - roundToTwo(Number(amount)));
      }

      const amountInDebtCurrency = currency !== existingBalance.currency ? roundToTwo(Number(amount) / rateValue) : roundToTwo(Number(amount));
      if (amountInDebtCurrency > Number(existingBalance.amount) + 0.000001) {
        throw new ErrorHandler(400, 'Payment exceeds the remaining debt balance');
      }

      // Ensure updatedAmount is never negative
      if (updatedAmount < 0) {
        updatedAmount = 0;
      }

      let updateQuery = {
        $set: { amount: updatedAmount },
        $push: { "paymentHistory": { ...req.body, amount: roundToTwo(Number(amount)), rate: rateValue, currency } },
      };

      if (updatedAmount === 0) {
        updateQuery.$set.status = 'waitingApproval';
      }

      // The wallet first, atomically and only if it still covers the payment; then the debt, only if
      // nobody paid it in between (two payments at the same moment cannot both go through)
      const deduct = roundToTwo(Number(amount));
      const deducted = await Wallets.findOneAndUpdate(
        { user: existingBalance.owner._id, currency, balance: { $gte: deduct } },
        { $inc: { balance: -deduct } },
        { new: true, session },
      );
      if (!deducted) throw new ErrorHandler(400, 'Insufficient wallet balance');
      await Wallets.updateOne({ _id: deducted._id, balance: deducted.balance }, { balance: roundToTwo(deducted.balance) }, { session });

      const balance = await Balance.findOneAndUpdate({ _id: id, amount: existingBalance.amount }, updateQuery, { new: true, session });
      if (!balance) {
        throw new ErrorHandler(409, 'This debt was just changed by someone else. Refresh and try again.');
      }

      const lastUserStatement = await UserStatement.find({ user: existingBalance.owner._id, currency }).sort({ _id: -1 }).limit(1).session(session);
      const previousTotal = Number(lastUserStatement[0]?.total || 0);
      const total = roundToTwo(previousTotal - deduct);

      const debtMessage = (req.body?.debtType || existingBalance?.debtType) === 'invoice'
        ? 'فاتورة'
        : (req.body?.debtType || existingBalance?.debtType) === 'receivedGoods'
          ? 'بضاعة مستلمة'
          : 'دين عام';

      const [debtStatement] = await UserStatement.create([{
        user: existingBalance.owner._id,
        createdBy: req.user,
        calculationType: '-',
        paymentType: 'wallet',
        createdAt,
        description: `${existingBalance?.order ? existingBalance?.order.orderId : ''} دفع دين لسداد قيمة (${debtMessage})`,
        amount: roundToTwo(Number(amount)),
        currency,
        total,
        ...(existingBalance.accountingKind === 'service_sale' && { serviceDebtSettlement: {
          debtCurrency: existingBalance.currency, paymentCurrency: currency,
          paymentPerDebtUnit: currency === existingBalance.currency ? 1 : rateValue,
        } }),
        note: `Payment for ${existingBalance?.debtType || ''} debt ${existingBalance?.order ? existingBalance?.order?.orderId : ''} #${balance.notes}`,
        attachments: files,
        actionType: 'wallet',
        ...(currency === 'LYD' && rateValue > 0 && { rate: rateValue }),
      }], { session });

      if (existingBalance.order && existingBalance.debtType !== 'general') {
        const data = {
          createdBy: req.user,
          customer: existingBalance.owner._id,
          order: existingBalance.order._id,
          paymentType: 'wallet',
          receivedAmount: roundToTwo(Number(amount)),
          currency,
          createdAt,
          rate: rateValue || 0,
          note: `(Wallet was ${roundToTwo(previousTotal)} ${currency})`,
          category: existingBalance.debtType,
          statementId: debtStatement._id,
        };
        await OrderPaymentHistory.create([data], { session });
      }
      await emitAccountingEvent('statement', debtStatement._id, { target: { balanceId: existingBalance._id } }, req.user, { session });

      return balance;
    });
    res.status(200).json(result);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    if (!mongoose.isValidObjectId(req.params.id)) throw new ErrorHandler(400, 'Invalid debt id');
    const result = await runInTransaction(async (session) => {
      const debt = await Balance.findById(req.params.id).session(session);
      if (!debt) throw new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND);
      if (debt.balanceType !== 'debt' || debt.status !== 'waitingApproval' || Number(debt.amount) !== 0) {
        throw new ErrorHandler(400, 'Only a fully paid debt awaiting approval can be confirmed');
      }
      // Approval concerns the final settlement, which can be newer than the debt itself.
      const settlementDate = (debt.paymentHistory || []).reduce((latest, payment) => {
        return payment.createdAt && new Date(payment.createdAt) > new Date(latest) ? payment.createdAt : latest;
      }, debt.createdAt);
      await assertOpenPeriod(req.user, settlementDate, { session });
      debt.status = 'closed';
      await debt.save({ session });
      await Activities.create([{
        user: req.user,
        details: { path: '/balances', status: 'updated', type: 'debt', actionId: String(debt._id) },
        changedFields: [{ label: 'Settlement approval', changedFrom: 'waitingApproval', changedTo: 'closed' }],
      }], { session });
      return debt;
    });
    res.status(200).json(result);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

// Close a debt by hand when only a small remainder is left (e.g. 0.1$).
// The debt is marked closed and the remainder is written off into a new 'lost' debt with the same note.
// No money moves, so wallets and statements are untouched.
module.exports.closeDebtManually = async (req, res, next) => {
  try {
    const { id } = req.params;
    const note = String(req.body?.note || '').trim();
    if (!note) throw new ErrorHandler(400, errorMessages.FIELDS_EMPTY);
    const result = await runInTransaction(async (session) => {
      const existing = await Balance.findOne({ _id: id, balanceType: 'debt' }).session(session);
      if (!existing) throw new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND);
      if (existing.order && existing.debtType !== 'general') {
        throw new ErrorHandler(400, 'Order-linked debt is a reminder of its invoice claim; write it off from the customer invoice instead');
      }
      if (!['open', 'overdue'].includes(existing.status)) throw new ErrorHandler(400, errorMessages.BALANCE_NOT_CLOSABLE);
      const closedAt = new Date();
      await assertOpenPeriod(req.user, closedAt, { session });
      const writtenOffAmount = Math.round(Number(existing.amount || 0) * 100) / 100;
      if (!Number.isFinite(writtenOffAmount) || writtenOffAmount < 0) throw new ErrorHandler(400, 'Invalid remaining debt balance');
      existing.status = 'closed';
      existing.amount = 0;
      existing.manualClosure = { note, writtenOffAmount, closedAt, closedBy: req.user._id };
      // Save the original first to serialize payment, deletion and competing closures.
      await existing.save({ session });
      if (writtenOffAmount > 0) {
        const [lost] = await Balance.create([{
          balanceType: 'debt', status: 'lost', amount: writtenOffAmount, initialAmount: writtenOffAmount,
          currency: existing.currency, createdOffice: existing.createdOffice, debtType: existing.debtType,
          order: existing.order, owner: existing.owner, createdBy: req.user, notes: note, sourceBalance: existing._id,
        }], { session });
        existing.manualClosure.lostBalance = lost._id;
        await existing.save({ session });
        await emitAccountingEvent('balanceWriteOff', existing._id, {}, req.user, { session });
      }
      return existing;
    });
    res.status(200).json(result);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

// Only debts without payments can be removed, including any linked written-off remainder.
module.exports.deleteBalance = async (req, res, next) => {
  try {
    const { id } = req.params;
    await runInTransaction(async (session) => {
      const balance = await Balance.findById(id).session(session).populate('owner', 'customerId');
      if (!balance) throw new ErrorHandler(404, errorMessages.BALANCE_NOT_FOUND);
      if (balance.paymentHistory?.length) throw new ErrorHandler(400, errorMessages.BALANCE_HAS_PAYMENTS);
      await assertOpenPeriod(req.user, balance.createdAt, { session });
      const lost = balance.manualClosure?.lostBalance
        ? await Balance.findById(balance.manualClosure.lostBalance).session(session) : null;
      if (lost?.paymentHistory?.length) throw new ErrorHandler(400, errorMessages.BALANCE_HAS_PAYMENTS);
      if (lost) await assertOpenPeriod(req.user, lost.createdAt, { session });
      await Balance.deleteOne({ _id: balance._id }, { session });
      await emitAccountingEvent('balanceDeleted', balance._id, {}, req.user, { session });
      if (lost) await Balance.deleteOne({ _id: lost._id }, { session });
      if (balance.sourceBalance) {
        await Balance.updateOne({ _id: balance.sourceBalance }, { $unset: { 'manualClosure.lostBalance': 1 } }, { session });
      }
      await Activities.create([{
        user: req.user,
        details: { path: '/balances', status: 'deleted', type: 'debt', actionId: String(balance._id) },
        changedFields: [
          { label: 'Customer', value: balance.owner?.customerId || String(balance.owner?._id || '') },
          { label: 'Amount', value: `${balance.initialAmount} ${balance.currency}` },
          { label: 'Status', value: balance.status }, { label: 'Notes', value: balance.notes },
        ],
      }], { session });
    });
    res.status(200).json({ success: true });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

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
