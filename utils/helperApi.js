// === Helper Functions ===
const Orders = require('../models/order');
const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const Inventory = require('../models/inventory');
const Wallet = require('../models/wallet');
const Invoices = require('../models/invoice');
const UserStatement = require('../models/userStatement');
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const mongodb = require('mongodb');

const { ObjectId } = mongodb;

function validatePackages(selectedPackages) {
  if (!selectedPackages || !Array.isArray(selectedPackages) || selectedPackages.length === 0) {
    throw new ErrorHandler(400, 'No packages selected');
  }
}

function validatePayment(payment) {
  if ((payment.amountLYD || 0) === 0 && (payment.amountUSD || 0) === 0) {
    throw new ErrorHandler(400, 'Payment amount cannot be zero');
  }
}

async function getUserWalletMap(userId) {
  const wallets = await Wallet.find({ user: userId });
  const map = {};
  wallets.forEach(w => map[w.currency] = w.balance);
  return map;
}

function truncateToTwo(num) {
  return Math.trunc(num * 100) / 100;
}

function checkSufficientFunds(walletMap, payment, totalCost) {
  const hasUSD = walletMap['USD'] >= (payment.amountUSD || 0);
  const hasLYD = walletMap['LYD'] >= (payment.amountLYD || 0);

  if (!hasUSD && payment.amountUSD > 0) {
    throw new ErrorHandler(400, 'Balance not enough for USD payment');
  }
  if (!hasLYD && payment.amountLYD > 0) {
    throw new ErrorHandler(400, 'Balance not enough for LYD payment');
  }

  const convertedLYDToUSD = payment.amountLYD ? truncateToTwo(walletMap['LYD'] / payment.rate) : 0;
  const totalAvailableUSD = truncateToTwo(payment.amountUSD + convertedLYDToUSD);

  if (totalAvailableUSD < (totalCost - 2)) {
    throw new ErrorHandler(400, 'Total available balance is not enough for the total cost');
  }
}

async function processPackagesPayment(req, res, next, id, selectedPackages, payment) {
  let lydBalance = +(payment.amountLYD || 0);
  let usdBalance = +(payment.amountUSD || 0);
  const rate = +(payment.rate || 0);

  if (lydBalance > 0 && rate <= 0) {
    throw new ErrorHandler(400, 'Invalid exchange rate for LYD payments');
  }

  let paidSoFarUSD = 0;

  for (let i = 0; i < selectedPackages.length; i++) {
    const pkg = selectedPackages[i];
    const pkgCost = +(pkg.cost || 0);
    const isLast = i === selectedPackages.length - 1;

    let usdFromUSD = 0;
    let lydFromLYD = 0;
    let usdPaidForThisPkg = 0;

    if (isLast) {
      // 👉 Last package: use EXACTLY what's left
      usdFromUSD = usdBalance;
      lydFromLYD = lydBalance;

      const usdCoveredByLYD = rate > 0 ? lydFromLYD / rate : 0;
      usdPaidForThisPkg = usdFromUSD + usdCoveredByLYD;

      // Force balances to zero
      usdBalance = 0;
      lydBalance = 0;
    } else {
      // Normal flow for earlier packages
      const targetCost = pkgCost;

      if (targetCost <= 0) continue;

      // Use USD first
      usdFromUSD = Math.min(usdBalance, targetCost);
      const remainingAfterUSD = targetCost - usdFromUSD;

      // Then LYD if needed
      if (remainingAfterUSD > 0 && rate > 0) {
        const lydNeeded = remainingAfterUSD * rate;
        lydFromLYD = Math.min(lydBalance, lydNeeded);
      }

      const usdCoveredByLYD = rate > 0 ? lydFromLYD / rate : 0;
      usdPaidForThisPkg = usdFromUSD + usdCoveredByLYD;

      // Deduct balances
      usdBalance = +(usdBalance - usdFromUSD).toFixed(2);
      lydBalance = +(lydBalance - lydFromLYD).toFixed(2);
    }

    // Wallet deduction
    if (usdFromUSD > 0) {
      await useWalletBalance(req, res, next, id, pkg, +usdFromUSD.toFixed(2), 'USD', 0, rate, isLast);
    }
    if (lydFromLYD > 0) {
      await useWalletBalance(req, res, next, id, pkg, +lydFromLYD.toFixed(2), 'LYD', rate, rate, isLast);
    }

    paidSoFarUSD = +(paidSoFarUSD + usdPaidForThisPkg).toFixed(2);
  }
}

async function useWalletBalance(req, res, next, id, pkg, amount, currency, rate, paymentRate, isLast) {
  try {
      const body = {
      createdAt: new Date(),
      amount: truncateToTwo(amount),
      currency,
      description: `تم دفع قيمة الشحن ${pkg?.trackingNumber} ${pkg?.orderId}`,
      note: `${pkg?.weight} ${pkg?.measureUnit} ${pkg?.trackingNumber} ${pkg?.orderId}`,
      orderId: pkg.orderId,
      category: 'receivedGoods',
      list: [{
        ...pkg,
        deliveredPackages: {
          trackingNumber: pkg?.trackingNumber,
          weight: {
            total: pkg?.weight,
            measureUnit: pkg?.measureUnit
          }
        }
      }]
    }
      const { createdAt, description, note, orderId, category } = body;
  
      let wallet = await Wallet.findOne({
        user: id,
        currency,
      });
      if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));
      if (isLast) {
        // For the last package, allow using the remaining balance even if it's less than the amount
        amount = Math.min(wallet.balance, amount);
      } else if (wallet.balance < amount) {
        throw next(new ErrorHandler(400, 'Insufficient wallet balance'));
      }

      // // Calculate new wallet balance with truncation to 2 decimals
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
      });

      let list = body.list;
      
      const order = await Orders.findOne({ orderId }).populate('user');

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
}

async function updateOrderStatuses(selectedPackages) {
  for (const package of selectedPackages) {
    const order = await Orders.findOne({ orderId: package.orderId });
    const item = order.paymentList.id(package.id);

    let hasPackageNotReceivedYet = false;
    let hasPackageOnTheWay = false;

    if (item) {
      item.status.received = true;
    }

    const activities = order.activity || [];
    activities.push({
      country: order.placedAt === 'tripoli' ? 'مكتب طرابلس' : 'مكتب بنغازي',
      createdAt: new Date(),
      description: `تم استلام العميل الطرد ${item?.deliveredPackages?.trackingNumber} بنجاح`,
    });
    order.activity = activities;

    for (const pkg of order.paymentList) {
      if (!pkg.status.received && pkg.status.arrivedLibya) {
        hasPackageNotReceivedYet = true;
        break;
      } else if (!pkg.status.arrivedLibya && !pkg.status.received && pkg.status.arrived) {
        hasPackageOnTheWay = true;
        break;
      }
    }

    if (hasPackageNotReceivedYet) {
      order.orderStatus = order.isPayment ? 4 : 3;
    } else if (hasPackageOnTheWay) {
      order.orderStatus = order.isPayment ? 3 : 2;
    } else {
      order.orderStatus = order.isPayment ? 5 : 4;
      order.isFinished = true;
    }

    await order.save();
  }
}

async function createInvoice(user, customerId, selectedPackages, payment, totalCost) {
  const latestInvoice = await Invoices.findOne({})
    .sort({ referenceId: -1 })
    .select('referenceId')
    .lean();

  const nextReferenceId = latestInvoice?.referenceId ? latestInvoice.referenceId + 1 : 1;

  const invoice = {
    referenceId: nextReferenceId,
    createdBy: user,
    customer: customerId,
    attachments: [],
    paymentType: 'shipment',
    total: totalCost,
    currency: 'USD',
    amountUSD: payment.amountUSD || 0,
    amountLYD: payment.amountLYD || 0,
    rate: payment.rate || 0,
    list: selectedPackages.map(pkg => ({
      packageId: pkg?.id,
      trackingNumber: pkg?.trackingNumber,
      weight: {
        total: pkg?.weight,
        measureUnit: pkg?.measureUnit
      },
      cost: pkg?.cost || 0,
      exiosPrice: pkg?.exiosPrice || 0,
      orderId: pkg?.orderId,
    }))
  };

  await Invoices.create(invoice);
}

async function cleanUpInventory(selectedPackages) {
  await Inventory.updateMany(
    { inventoryType: 'warehouseInventory' },
    {
      $pull: {
        orders: {
          $or: [
            { "paymentList._id": { $in: selectedPackages.map(p => p.id) } },
            { "paymentList._id": { $in: selectedPackages.map(p => new ObjectId(p.id)) } }
          ]
        }
      }
    },
    { safe: true, upsert: true, new: true }
  );
}

async function isNewCustomer(userId) {
  try {
    // Count orders that match your condition
    const count = await Orders.countDocuments({
      user: userId,
      isShipment: true,
      isPayment: false,
      unsureOrder: false
    });

    // No orders at all OR only one matching order => new customer
    if (count <= 1) {
      return true;
    }

    // More than one matching order => not a new customer
    return false;

  } catch (error) {
    console.error("Error checking customer:", error);
    throw error;
  }
}

module.exports = { cleanUpInventory, isNewCustomer, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages };
