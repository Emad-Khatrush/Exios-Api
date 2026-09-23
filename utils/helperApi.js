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

// Paying up to this many USD short of (or over) the total is accepted to absorb rounding
const PAYMENT_TOLERANCE_USD = 2;
const BALANCE_EPSILON = 0.001;

const roundToTwo = (num) => Math.round(num * 100) / 100;

const toAmount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

// Returns the payment as clean numbers so later steps never work with strings or NaN
function validatePayment(payment) {
  if (!payment || typeof payment !== 'object') {
    throw new ErrorHandler(400, 'Payment details are missing');
  }

  const amountUSD = toAmount(payment.amountUSD || 0);
  const amountLYD = toAmount(payment.amountLYD || 0);

  if ([amountUSD, amountLYD].some(Number.isNaN)) {
    throw new ErrorHandler(400, 'Payment amounts must be numbers');
  }
  if (amountUSD < 0 || amountLYD < 0) {
    throw new ErrorHandler(400, 'Payment amounts cannot be negative');
  }
  if (amountLYD === 0 && amountUSD === 0) {
    throw new ErrorHandler(400, 'Payment amount cannot be zero');
  }

  return { amountUSD: roundToTwo(amountUSD), amountLYD: roundToTwo(amountLYD) };
}

// The rate is never taken from the client. USD only: 0. LYD only: LYD / total.
// Both: USD is taken first and the LYD pays the rest, so rate = LYD / (total - USD).
function calculateRate(amountUSD, amountLYD, totalCost) {
  if (amountLYD <= 0) return 0;
  const remainingUSD = roundToTwo(totalCost - amountUSD);
  if (remainingUSD <= 0) return 0;
  return Math.round((amountLYD / remainingUSD) * 10000) / 10000;
}

function withCalculatedRate(payment, totalCost) {
  const rate = calculateRate(payment.amountUSD, payment.amountLYD, totalCost);
  if (payment.amountLYD > 0 && rate <= 0) {
    throw new ErrorHandler(400, 'The USD payment already covers the total, remove the LYD amount');
  }
  return { ...payment, rate };
}

// Reads every selected package from the database instead of trusting the cost sent by the
// client, and refuses packages that are already received, cancelled, or belong to someone else.
async function loadDeliverablePackages(customerId, selectedPackages) {
  const seen = new Set();
  const packages = [];

  for (const selected of selectedPackages) {
    const packageId = String(selected?.id || '');
    if (!packageId || seen.has(packageId)) continue;
    seen.add(packageId);

    const order = await Orders.findOne({ orderId: selected.orderId, user: customerId, isCanceled: { $ne: true } });
    const item = order?.paymentList?.id(packageId);
    if (!item) {
      throw new ErrorHandler(400, `Package ${selected?.trackingNumber || packageId} was not found for this customer`);
    }
    if (item.status?.received) {
      throw new ErrorHandler(400, `Package ${item.deliveredPackages?.trackingNumber || packageId} was already delivered`);
    }

    const weight = Number(item.deliveredPackages?.weight?.total || 0);
    const exiosPrice = Number(item.deliveredPackages?.exiosPrice || 0);

    packages.push({
      ...selected,
      id: packageId,
      orderId: order.orderId,
      trackingNumber: item.deliveredPackages?.trackingNumber || '',
      weight,
      measureUnit: item.deliveredPackages?.weight?.measureUnit || '',
      exiosPrice,
      boxesCount: item.deliveredPackages?.boxesCount || '',
      locationPlace: item.deliveredPackages?.locationPlace || '',
      cost: Number((weight * exiosPrice).toFixed(2)),
    });
  }

  if (packages.length === 0) {
    throw new ErrorHandler(400, 'No packages selected');
  }

  const totalCost = roundToTwo(packages.reduce((sum, pkg) => sum + pkg.cost, 0));
  return { packages, totalCost };
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
  const { amountUSD, amountLYD, rate } = payment;

  if (amountUSD > (walletMap['USD'] || 0) + BALANCE_EPSILON) {
    throw new ErrorHandler(400, 'Balance not enough for USD payment');
  }
  if (amountLYD > (walletMap['LYD'] || 0) + BALANCE_EPSILON) {
    throw new ErrorHandler(400, 'Balance not enough for LYD payment');
  }

  // Convert the LYD being paid, not the whole LYD wallet
  const convertedLYDToUSD = amountLYD > 0 ? roundToTwo(amountLYD / rate) : 0;
  const coveredUSD = roundToTwo(amountUSD + convertedLYDToUSD);

  if (coveredUSD < totalCost - PAYMENT_TOLERANCE_USD) {
    throw new ErrorHandler(400, `Payment covers $${coveredUSD} but the packages cost $${totalCost}`);
  }
  if (coveredUSD > totalCost + PAYMENT_TOLERANCE_USD) {
    throw new ErrorHandler(400, `Payment of $${coveredUSD} is more than the packages cost ($${totalCost})`);
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
    // Rounded, not truncated: Math.trunc(1.13 * 100) / 100 gives 1.12
    const amountToDeduct = roundToTwo(amount);

    // Deduct atomically and only if the balance covers it, so two requests at once
    // cannot both spend the same money (it used to be read, subtracted, then clamped to 0)
    const wallet = await Wallet.findOneAndUpdate(
      { user: id, currency, balance: { $gte: amountToDeduct - BALANCE_EPSILON } },
      { $inc: { balance: -amountToDeduct } },
      { new: true }
    );
    if (!wallet) throw new ErrorHandler(400, `Balance not enough for ${currency} payment`);
    await Wallet.updateOne({ _id: wallet._id }, { balance: Math.max(0, roundToTwo(wallet.balance)) });

    // FIX: Handle cases where there is no previous statement for this currency
    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1);
    
    // SAFE ACCESS: If no statement exists, previousTotal is 0
    const previousTotal = lastUserStatement.length > 0 ? Number(lastUserStatement[0].total || 0) : 0;
    const statementTotal = roundToTwo(previousTotal - amountToDeduct);

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
      actionType: 'wallet',
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

    const notReceived = order.paymentList.filter(pkg => !pkg.status.received);

    if (notReceived.length === 0) {
      order.orderStatus = order.isPayment ? 5 : 4;
      order.isFinished = true;
    } else if (notReceived.some(pkg => pkg.status.arrivedLibya)) {
      order.orderStatus = order.isPayment ? 4 : 3;
    } else if (notReceived.some(pkg => pkg.status.arrived)) {
      order.orderStatus = order.isPayment ? 3 : 2;
    }
    // Otherwise some packages have not even reached the warehouse yet: the order is not
    // finished (it used to be marked finished here) and its status stays as it is.

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
      boxesCount: pkg?.boxesCount || '-',
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

// Same steps as cancelling a wallet payment on an order: money back to the wallet,
// a "+" cancellation statement, then the payment record is removed
async function refundWalletPayment(user, payment, description, note) {
  const amount = roundToTwo(Number(payment.receivedAmount || 0));
  const customerId = payment.customer;
  const { currency } = payment;

  const wallet = await Wallet.findOneAndUpdate(
    { user: customerId, currency },
    { $inc: { balance: amount } },
    { new: true }
  );
  if (wallet) {
    await Wallet.updateOne({ _id: wallet._id }, { balance: roundToTwo(wallet.balance) });
  } else {
    await Wallet.create({ user: customerId, currency, balance: amount });
  }

  const lastUserStatement = await UserStatement.find({ user: customerId, currency }).sort({ _id: -1 }).limit(1);
  const previousTotal = lastUserStatement.length > 0 ? Number(lastUserStatement[0].total || 0) : 0;

  await UserStatement.create({
    user: customerId,
    createdBy: user,
    calculationType: '+',
    paymentType: 'wallet',
    createdAt: new Date(),
    description,
    amount,
    currency,
    total: roundToTwo(previousTotal + amount),
    note,
    actionType: 'cancellation',
  });

  await OrderPaymentHistory.deleteOne({ _id: payment._id });
  return amount;
}

// The delivery creates the payments a moment before the invoice itself
const INVOICE_PAYMENT_WINDOW_MS = 15 * 60 * 1000;

async function cancelInvoicePackages(user, invoice) {
  const refunded = { USD: 0, LYD: 0 };
  const packages = [];
  const invoiceTime = new Date(invoice.createdAt).getTime();

  for (const pkg of invoice.list || []) {
    const summary = { trackingNumber: pkg.trackingNumber, orderId: pkg.orderId, refunds: [], statusUpdated: false };
    const order = await Orders.findOne({ orderId: pkg.orderId });

    if (order) {
      const packageId = String(pkg.packageId || '');
      const payments = await OrderPaymentHistory.find({
        order: order._id,
        category: 'receivedGoods',
        paymentType: 'wallet',
        createdAt: { $gte: new Date(invoiceTime - INVOICE_PAYMENT_WINDOW_MS), $lte: new Date(invoiceTime + 60 * 1000) },
        $or: [
          { 'list.id': packageId },
          ...(ObjectId.isValid(packageId) ? [{ 'list.id': new ObjectId(packageId) }] : []),
          ...(pkg.trackingNumber ? [{ 'list.trackingNumber': pkg.trackingNumber }] : []),
        ],
      });

      for (const payment of payments) {
        const amount = await refundWalletPayment(
          user,
          payment,
          `إلغاء الفاتورة رقم #0${invoice.referenceId} واسترجاع قيمة شحن ${pkg.trackingNumber || ''} إلى المحفظة`,
          `Invoice #0${invoice.referenceId} cancellation ${pkg.orderId || ''}`
        );
        refunded[payment.currency] = roundToTwo((refunded[payment.currency] || 0) + amount);
        summary.refunds.push({ currency: payment.currency, amount });
      }

      // Back to "arrived in Libya, not received" so it shows again in ready for pickup
      const item = packageId ? order.paymentList.id(packageId) : null;
      if (item) {
        item.status.arrivedLibya = true;
        item.status.received = false;
        summary.statusUpdated = true;
      }

      order.activity = [
        ...(order.activity || []),
        {
          country: order.placedAt === 'tripoli' ? 'مكتب طرابلس' : 'مكتب بنغازي',
          createdAt: new Date(),
          description: `تم إلغاء استلام الطرد ${pkg.trackingNumber || ''} (إلغاء الفاتورة رقم #0${invoice.referenceId})`,
        },
      ];
      // "وصلت البضائع" step
      order.orderStatus = order.isPayment ? 4 : 3;
      order.isFinished = false;
      await order.save();
    }

    packages.push(summary);
  }

  return { refundedUSD: refunded.USD, refundedLYD: refunded.LYD, packages };
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

// --- Helper to format dates to DD/MM/YYYY ---
const formatDate = (dateStr, createdAt) => {
  const rawDate = dateStr ? new Date(dateStr) : new Date(createdAt);
  if (!isNaN(rawDate.getTime())) {
    return rawDate.toISOString().split('T')[0].split('-').reverse().join('/');
  }
  return dateStr || '';
};

// 1. Invoices Fetcher
const getInvoicesQuery = async (dateFilter) => {
  try {
    const query = { isCanceled: { $ne: true }, unsureOrder: { $ne: true }, isShipment: false, isPayment: true, ...dateFilter };
    const orders = await Orders.find(query).populate('user').lean();
    const rows = [];
  
    for (const order of orders) {
      const invoiceDate = formatDate(order.createdAt, order.createdAt);
  
      rows.push({
        'id': order.orderId,
        'partner_id/id': order.user?.customerId || 'A000',
        'invoice_date': invoiceDate,
        'invoice_date_due': invoiceDate,
        'invoice_line_ids/product_id': 'شراء من المواقع',
        'invoice_line_ids/price_unit': order.totalInvoice || 0,
        'currency_id': 'USD',
        'currency_rate': 1,
        'invoice_line_ids/tax_ids': '0% EX',
        'invoice_line_ids/quantity': 1,
        'ref': order.orderId,
      });
    }
    return rows;

  } catch (error) {
    console.error('Error fetching invoices:', error);
    throw new ErrorHandler(500, 'Error fetching invoices');
  }
};

async function getPurchaseItemsByDate(startDate, endDate) {
try {
    let start, end;

    if (endDate) {
      start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);

      end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
    } else {
      start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);

      end = new Date(startDate);
      end.setUTCHours(23, 59, 59, 999);
    }

    const purchaseItems = await Orders.aggregate([
      // 1. Deconstruct the purchaseItems array
      { $unwind: '$purchaseItems' },

      // 2. Filter by date boundary
      {
        $match: {
          'purchaseItems.date': {
            $gte: start,
            $lte: end
          }
        }
      },

      // 3. Reshape and promote purchaseItems to the top level
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              '$purchaseItems',
              { orderId: '$orderId', orderDbId: '$_id' } // Attach parent order ref
            ]
          }
        }
      }
    ]);

    return purchaseItems;
  } catch (error) {
    console.error('Error fetching purchase items by date:', error);
    throw error;
  }
}

module.exports = { cancelInvoicePackages, getPurchaseItemsByDate, getInvoicesQuery, formatDate, cleanUpInventory, isNewCustomer, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages, loadDeliverablePackages, calculateRate, withCalculatedRate };
