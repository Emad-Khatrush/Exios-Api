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
  let remainingLYD = +(payment.amountLYD || 0);
  let remainingUSD = +(payment.amountUSD || 0);
  const rate = +(payment.rate || 0);

  // Stop immediately if LYD is needed but rate is 0
  if (remainingLYD > 0 && rate <= 0) {
    throw new ErrorHandler(400, 'Exchange rate is required for LYD payments');
  }

  for (let i = 0; i < selectedPackages.length; i++) {
    const pkg = selectedPackages[i];
    if (!pkg) continue;

    const pkgCost = +(pkg.cost || 0);
    const isLast = i === selectedPackages.length - 1;

    let usdToDeduct = 0;
    let lydToDeduct = 0;

    if (isLast) {
      usdToDeduct = remainingUSD;
      lydToDeduct = remainingLYD;
    } else {
      if (pkgCost <= 0) continue;

      usdToDeduct = Math.min(remainingUSD, pkgCost);
      const stillOwedUSD = +(pkgCost - usdToDeduct).toFixed(2);

      // Only calculate LYD if there is a debt and a valid rate
      if (stillOwedUSD > 0 && rate > 0) {
        const lydNeeded = +(stillOwedUSD * rate).toFixed(2);
        lydToDeduct = Math.min(remainingLYD, lydNeeded);
      }
    }

    if (usdToDeduct > 0) {
      await useWalletBalance(req, res, next, id, pkg, +usdToDeduct.toFixed(2), 'USD', rate, isLast);
      remainingUSD = +(remainingUSD - usdToDeduct).toFixed(2);
    }
    
    if (lydToDeduct > 0) {
      // Safeguard: Ensure rate is not 0 before calling LYD deduction
      const currentRate = rate > 0 ? rate : 1; 
      await useWalletBalance(req, res, next, id, pkg, +lydToDeduct.toFixed(2), 'LYD', currentRate, isLast);
      remainingLYD = +(remainingLYD - lydToDeduct).toFixed(2);
    }
  }
}

async function useWalletBalance(req, res, next, id, pkg, amount, currency, rate, isLast) {
  try {
    const amountToDeduct = truncateToTwo(amount);
    
    let wallet = await Wallet.findOne({ user: id, currency });
    if (!wallet) throw new ErrorHandler(404, `Wallet for ${currency} not found`);

    let newBalance = truncateToTwo(wallet.balance - amountToDeduct);
    if (newBalance < 0) newBalance = 0;

    await Wallet.findOneAndUpdate({ user: id, currency }, { balance: newBalance });

    // FIX: Handle cases where there is no previous statement for this currency
    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1);
    
    // SAFE ACCESS: If no statement exists, previousTotal is 0
    const previousTotal = lastUserStatement.length > 0 ? Number(lastUserStatement[0].total || 0) : 0;
    const statementTotal = truncateToTwo(previousTotal - amountToDeduct);

    const userStatement = await UserStatement.create({
      user: id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt: new Date(),
      description: `تم دفع قيمة الشحن ${pkg?.trackingNumber || ''}`,
      amount: amountToDeduct,
      currency,
      total: statementTotal,
      note: `${pkg?.orderId || ''}`,
    });

    const order = await Orders.findOne({ orderId: pkg.orderId }).populate('user');
    if (order) {
      await OrderPaymentHistory.create({
        createdBy: req.user,
        customer: order.user ? order.user._id : id,
        order: order._id,
        paymentType: 'wallet',
        receivedAmount: amountToDeduct,
        currency,
        createdAt: new Date(),
        rate: Number(rate) || 0,
        category: 'receivedGoods',
        list: [pkg],
        note: `(Prev Balance: ${previousTotal} ${currency})`
      });
    }

    return userStatement;
  } catch (error) {
    console.error(`🔥 Currency Switch Error (${currency}):`, error.message);
    throw error.statusCode ? error : new ErrorHandler(500, error.message);
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
