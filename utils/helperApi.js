// === Helper Functions ===
const Orders = require('../models/order');
const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const Inventory = require('../models/inventory');
const Wallet = require('../models/wallet');
const { useBalanceOfWallet } = require('../controllers/wallet');
const Invoices = require('../models/invoice');
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

  const convertedLYDToUSD = payment.amountLYD ? truncateToTwo(payment.amountLYD / payment.rate) : 0;
  const totalAvailableUSD = truncateToTwo(payment.amountUSD + convertedLYDToUSD);

  if (totalAvailableUSD < (totalCost - 2)) {
    throw new ErrorHandler(400, 'Total available balance is not enough for the total cost');
  }
}

async function processPackagesPayment(req, res, next, id, selectedPackages, payment) {
  let lydBalance = payment.amountLYD || 0;
  let usdBalance = payment.amountUSD || 0;

  for (let i = 0; i < selectedPackages.length; i++) {
    const pkg = selectedPackages[i];
    const costPackage = pkg.cost || 0;
    const isLast = i === selectedPackages.length - 1;

    let usdToUse = 0;
    let lydToUse = 0;

    if (isLast) {
      usdToUse = usdBalance;
      lydToUse = lydBalance;
      usdBalance = 0;
      lydBalance = 0;
    } else if (usdBalance >= costPackage) {
      usdToUse = truncateToTwo(costPackage);
      usdBalance -= usdToUse;
    } else {
      usdToUse = truncateToTwo(usdBalance);
      const remainingUSD = costPackage - usdBalance;
      usdBalance = 0;
      lydToUse = truncateToTwo(remainingUSD * payment.rate);
      lydBalance -= lydToUse;
    }

    if (usdToUse > 0) {
      await useWalletBalance(req, res, next, id, pkg, usdToUse, 'USD', 0, payment.rate);
    }
    if (lydToUse > 0) {
      await useWalletBalance(req, res, next, id, pkg, lydToUse, 'LYD', payment.rate, payment.rate);
    }
  }
}

async function useWalletBalance(req, res, next, id, pkg, amount, currency, rate, paymentRate) {
  return await useBalanceOfWallet({
    ...req,
    params: { id },
    body: {
      createdAt: new Date(),
      amount: truncateToTwo(amount),
      currency,
      description: `تم دفع قيمة الشحن ${pkg.trackingNumber} ${pkg.orderId}`,
      note: `${pkg.weight} ${pkg.measureUnit} ${pkg.trackingNumber} ${pkg.orderId}`,
      orderId: pkg.orderId,
      category: 'receivedGoods',
      rate,
      list: JSON.stringify([{
        ...pkg,
        deliveredPackages: {
          trackingNumber: pkg.trackingNumber,
          weight: {
            total: pkg.weight,
            measureUnit: pkg.measureUnit
          }
        }
      }])
    }
  }, res, next);
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
      description: `تم استلام العميل الطرد ${item.deliveredPackages.trackingNumber} بنجاح`,
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
      packageId: pkg.id,
      trackingNumber: pkg.trackingNumber,
      weight: {
        total: pkg.weight,
        measureUnit: pkg.measureUnit
      },
      cost: pkg.cost || 0,
      exiosPrice: pkg.exiosPrice || 0,
      orderId: pkg.orderId,
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

module.exports = { cleanUpInventory, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages };
