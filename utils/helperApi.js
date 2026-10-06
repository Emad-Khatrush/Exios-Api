const { lockWalletOwner } = require('./walletLock');
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
const { emitAccountingEvent } = require('../accounting/services/events');
const { FEE_FIELDS } = require('./packageMeasures');

// Each fee a package carries is its own claim in accounting, keyed SHP:<order>:<package>:<suffix>
const FEE_KEYS = [{ field: 'domesticFee', suffix: 'DOM', label: 'رسوم النقل الداخلي' }, { field: 'customsFee', suffix: 'CUS', label: 'رسوم التخليص الجمركي' }];

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
// allowZero: the caller checks afterwards that nothing was owed (free packages, owner's offer)
function validatePayment(payment, { allowZero = false } = {}) {
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
  if (amountLYD === 0 && amountUSD === 0 && !allowZero) {
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
// The transport fee to another office is charged in the currency it was set in (spec v8). With
// feeMode 'separate' (the default) a fee in dinars is paid from the dinar wallet on its own, beside
// the shipping; with 'usd' it is converted at today's rate and paid with the shipping. Either way
// its dollar value is refreshed at today's rate first, so the books and the wallet agree.
async function loadDeliverablePackages(customerId, selectedPackages, { feeMode = 'separate', session } = {}) {
  const seen = new Set();
  const packages = [];
  const feesLYD = [];
  let todayRate = null;

  for (const selected of selectedPackages) {
    const packageId = String(selected?.id || '');
    if (!packageId || seen.has(packageId)) continue;
    seen.add(packageId);

    const order = await Orders.findOne({ orderId: selected.orderId, user: customerId, isCanceled: { $ne: true } }).session(session);
    const item = order?.paymentList?.id(packageId);
    if (!item) {
      throw new ErrorHandler(400, `Package ${selected?.trackingNumber || packageId} was not found for this customer`);
    }
    if (item.status?.received) {
      throw new ErrorHandler(400, `Package ${item.deliveredPackages?.trackingNumber || packageId} was already delivered`);
    }

    const weight = Number(item.deliveredPackages?.weight?.total || 0);
    const exiosPrice = Number(item.deliveredPackages?.exiosPrice || 0);
    // The fees beside the shipping: transport to another office and customs clearance (same rules)
    let feeUSD = 0;
    const feesOf = {};
    for (const field of FEE_FIELDS) {
      const fee = item.deliveredPackages?.[field];
      if (!(Number(fee?.amount) > 0)) continue;
      feesOf[field] = fee;
      if (fee.currency === 'LYD') {
        if (todayRate === null) {
          const ExchangeRate = require('../models/exchangeRate');
          todayRate = Number((await ExchangeRate.findOne({ fromCurrency: 'usd' }).session(session).lean())?.rate) || 0;
          if (!todayRate) throw new ErrorHandler(400, 'No dinar rate in the settings to price the package fees');
        }
        const usd = roundToTwo(Number(fee.amount) / todayRate);
        if (usd !== Number(fee.usd)) {
          await Orders.updateOne({ _id: order._id, 'paymentList._id': item._id }, { $set: { [`paymentList.$.deliveredPackages.${field}.usd`]: usd } }, { session });
        }
        if (feeMode === 'usd') feeUSD += usd;
        else feesLYD.push({ packageId, orderId: order.orderId, orderMongoId: order._id, trackingNumber: item.deliveredPackages?.trackingNumber || '', amount: Number(fee.amount), rate: todayRate, field });
      } else {
        feeUSD += Number(fee.amount);
      }
    }
    const feeView = (fee) => (fee ? { amount: Number(fee.amount), currency: fee.currency || 'USD', paidIn: fee.currency === 'LYD' && feeMode !== 'usd' ? 'LYD' : 'USD' } : undefined);

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
      // The fees: in dollars with the shipping, or in dinars each on its own (feesLYD)
      domesticFee: feeView(feesOf.domesticFee),
      customsFee: feeView(feesOf.customsFee),
      // A fee in dinars is paid on its own from the dinar wallet
      separateFee: Object.values(feesOf).some((fee) => fee.currency === 'LYD' && feeMode !== 'usd'),
      // What the shipping payment pays: the shipping, then the fees paid with it in dollars
      payKeys: Object.keys(feesOf).length ? [
        `SHP:${order._id}:${packageId}`,
        ...FEE_KEYS.filter(({ field }) => feesOf[field] && !(feesOf[field].currency === 'LYD' && feeMode !== 'usd')).map(({ suffix }) => `SHP:${order._id}:${packageId}:${suffix}`),
      ] : undefined,
      cost: Number((weight * exiosPrice + feeUSD).toFixed(2)),
    });
  }

  if (packages.length === 0) {
    throw new ErrorHandler(400, 'No packages selected');
  }

  const totalCost = roundToTwo(packages.reduce((sum, pkg) => sum + pkg.cost, 0));
  const totalFeeLYD = roundToTwo(feesLYD.reduce((sum, f) => sum + f.amount, 0));
  return { packages, totalCost, feesLYD, totalFeeLYD };
}

// Claim packages before any wallet movement. A competing transaction conflicts and retries,
// then sees the package already received instead of charging it again.
async function claimPackagesForDelivery(customerId, selectedPackages, session) {
  for (const selected of selectedPackages) {
    const claimed = await Orders.updateOne({
      orderId: selected.orderId,
      user: customerId,
      isCanceled: { $ne: true },
      unsureOrder: { $ne: true },
      paymentList: { $elemMatch: { _id: new ObjectId(selected.id), 'status.received': { $ne: true } } },
    }, { $set: { 'paymentList.$.status.received': true } }, { session });
    if (claimed.modifiedCount !== 1) {
      throw new ErrorHandler(409, `Package ${selected.trackingNumber || selected.id} was already delivered. Refresh and try again.`);
    }
  }
}

async function getUserWalletMap(userId, session) {
  const wallets = await Wallet.find({ user: userId }).session(session);
  const map = {};
  wallets.forEach(w => map[w.currency] = w.balance);
  return map;
}

function truncateToTwo(num) {
  return Math.trunc(num * 100) / 100;
}

function checkSufficientFunds(walletMap, payment, totalCost, totalFeeLYD = 0) {
  const { amountUSD, amountLYD, rate } = payment;
  if (amountLYD + totalFeeLYD > (walletMap['LYD'] || 0) + BALANCE_EPSILON) {
    throw new ErrorHandler(400, totalFeeLYD ? `Not enough LYD for the payment and the transport fees (${totalFeeLYD} LYD)` : 'Balance not enough for LYD payment');
  }

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

async function processPackagesPayment(req, res, next, id, selectedPackages, payment, { session } = {}) {
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
      await useWalletBalance(req, res, next, id, pkg, +usdToDeduct.toFixed(2), 'USD', rate, isLast, session);
      remainingUSD = +(remainingUSD - usdToDeduct).toFixed(2);
    }
    
    if (lydToDeduct > 0) {
      // Safeguard: Ensure rate is not 0 before calling LYD deduction
      const currentRate = rate > 0 ? rate : 1; 
      await useWalletBalance(req, res, next, id, pkg, +lydToDeduct.toFixed(2), 'LYD', currentRate, isLast, session);
      remainingLYD = +(remainingLYD - lydToDeduct).toFixed(2);
    }
  }
}

async function useWalletBalance(req, res, next, id, pkg, amount, currency, rate, isLast, session) {
  try {
    // Rounded, not truncated: Math.trunc(1.13 * 100) / 100 gives 1.12
    const amountToDeduct = roundToTwo(amount);

    // Deduct atomically and only if the balance covers it, so two requests at once
    // cannot both spend the same money (it used to be read, subtracted, then clamped to 0)
    const wallet = await Wallet.findOneAndUpdate(
      { user: id, currency, balance: { $gte: amountToDeduct - BALANCE_EPSILON } },
      { $inc: { balance: -amountToDeduct } },
      { new: true, session }
    );
    if (!wallet) throw new ErrorHandler(400, `Balance not enough for ${currency} payment`);
    await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: Math.max(0, roundToTwo(wallet.balance)) }, { session });

    // FIX: Handle cases where there is no previous statement for this currency
    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1).session(session);
    
    // SAFE ACCESS: If no statement exists, previousTotal is 0
    const previousTotal = lastUserStatement.length > 0 ? Number(lastUserStatement[0].total || 0) : 0;
    const statementTotal = roundToTwo(previousTotal - amountToDeduct);

    const statementData = {
      user: id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt: new Date(),
      description: pkg?.feeOnly ? `${(FEE_KEYS.find((f) => f.field === pkg.feeField) || FEE_KEYS[0]).label} ${pkg?.trackingNumber || ''}` : `تم دفع قيمة الشحن ${pkg?.trackingNumber || ''}`,
      amount: amountToDeduct,
      currency,
      total: statementTotal,
      note: `${pkg?.orderId || ''}`,
      actionType: 'wallet',
      ...(currency === 'LYD' && Number(rate) > 0 && { rate: Number(rate) }),
    };
    const userStatement = session
      ? (await UserStatement.create([statementData], { session }))[0]
      : await UserStatement.create(statementData);

    const order = await Orders.findOne({ orderId: pkg.orderId }).session(session).populate('user');
    if (order) {
      const paymentData = {
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
        note: `(Prev Balance: ${previousTotal} ${currency})`,
        statementId: userStatement._id,
      };
      if (session) await OrderPaymentHistory.create([paymentData], { session });
      else await OrderPaymentHistory.create(paymentData);
    }
    const target = pkg?.feeOnly
      ? { arKeys: [`SHP:${order?._id}:${pkg.id}:${(FEE_KEYS.find((f) => f.field === pkg.feeField) || FEE_KEYS[0]).suffix}`] }
      : pkg?.payKeys ? { arKeys: pkg.payKeys } : { orderId: order?._id, packageIds: [pkg?.id].filter(Boolean) };
    await emitAccountingEvent('statement', userStatement._id, { target }, req.user, { session });

    return userStatement;
  } catch (error) {
    console.error(`🔥 Currency Switch Error (${currency}):`, error.message);
    // Keep MongoDB error labels so withTransaction can retry write conflicts.
    throw error;
  }
}

// The transport fees in dinars, each paid from the dinar wallet on its own (spec v8)
async function payFeesLYD(req, res, next, id, feesLYD, session) {
  for (const fee of feesLYD || []) {
    await useWalletBalance(req, res, next, id, { id: fee.packageId, orderId: fee.orderId, trackingNumber: fee.trackingNumber, feeOnly: true, feeField: fee.field }, fee.amount, 'LYD', fee.rate, false, session);
  }
}

async function updateOrderStatuses(selectedPackages, session) {
  for (const selected of selectedPackages) {
    const order = await Orders.findOne({ orderId: selected.orderId }).session(session);
    const item = order.paymentList.id(selected.id);

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

    await order.save({ session });
  }
}

async function createInvoice(user, customerId, selectedPackages, payment, totalCost, session) {
  const latestInvoice = await Invoices.findOne({})
    .sort({ referenceId: -1 })
    .select('referenceId')
    .session(session)
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
      ...(pkg?.domesticFee && { domesticFee: pkg.domesticFee }),
      ...(pkg?.customsFee && { customsFee: pkg.customsFee }),
    }))
  };

  if (session) await Invoices.create([invoice], { session });
  else await Invoices.create(invoice);
}

async function cleanUpInventory(selectedPackages, session) {
  // Mongoose's query builder (Model.updateMany included) silently no-ops
  // this $pull on real warehouse documents - the raw driver, bypassing it
  // entirely, is the only reliable way to actually remove the array element
  // (see the same fix and comment in controllers/inventory.js).
  await Inventory.collection.updateMany(
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
    }, { session }
  );
}

// The wallet line a wallet payment took its money with. Payments saved before the link existed
// are matched as the historical migration matches them: same customer, currency and amount, a
// deduction within 10 minutes. Cancelling then reverses that line's entry exactly.
async function statementOfPayment(payment, session) {
  if (payment?.statementId) return payment.statementId;
  if (!payment || payment.paymentType !== 'wallet') return undefined;
  const time = new Date(payment.createdAt).getTime();
  const candidates = await UserStatement.find({
    user: payment.customer?._id || payment.customer, currency: payment.currency, calculationType: '-',
    createdAt: { $gte: new Date(time - 10 * 60 * 1000), $lte: new Date(time + 10 * 60 * 1000) },
  }).select('amount createdAt').session(session).lean();
  const match = candidates
    .filter((s) => Math.abs(Number(s.amount) - Number(payment.receivedAmount)) < 0.011)
    .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - time) - Math.abs(new Date(b.createdAt).getTime() - time))[0];
  return match?._id;
}

// Same steps as cancelling a wallet payment on an order: money back to the wallet,
// a "+" cancellation statement, then the payment record is removed
async function refundWalletPayment(user, payment, description, note, session) {
  await lockWalletOwner(payment.customer, session);
  const reverses = await statementOfPayment(payment, session);
  const amount = roundToTwo(Number(payment.receivedAmount || 0));
  const customerId = payment.customer;
  const { currency } = payment;

  const wallet = await Wallet.findOneAndUpdate(
    { user: customerId, currency },
    { $inc: { balance: amount } },
    { new: true, session }
  );
  if (wallet) {
    await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: roundToTwo(wallet.balance) }, { session });
  } else {
    await Wallet.create([{ user: customerId, currency, balance: amount }], { session });
  }

  const lastUserStatement = await UserStatement.find({ user: customerId, currency }).sort({ _id: -1 }).limit(1).session(session);
  const previousTotal = lastUserStatement.length > 0 ? Number(lastUserStatement[0].total || 0) : 0;

  const refundData = {
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
    // The payment's own rate: the amount given back is worth what the payment counted for
    ...(Number(payment.rate) > 0 && currency !== 'USD' && { rate: Number(payment.rate) }),
    actionType: 'cancellation',
  };
  const refundStatement = session
    ? (await UserStatement.create([refundData], { session }))[0]
    : await UserStatement.create(refundData);

  await emitAccountingEvent('statement', refundStatement._id, {
    reverses,
    target: { orderId: payment.order, category: payment.category, packageIds: (payment.list || []).map((p) => p?.id || p?._id).filter(Boolean) },
  }, user, { session });
  await OrderPaymentHistory.deleteOne({ _id: payment._id }, { session });
  return amount;
}

// The delivery creates the payments a moment before the invoice itself
const INVOICE_PAYMENT_WINDOW_MS = 15 * 60 * 1000;

// The delivery invoice a shipping payment belongs to (the same match cancelInvoicePackages makes),
// or null. Such a payment is given back only by cancelling its invoice: deleting it alone would
// leave the invoice saying the package was paid and handed over.
async function deliveryInvoiceOf(payment, orderNumber, session) {
  if (!payment || payment.category !== 'receivedGoods' || payment.paymentType !== 'wallet' || !orderNumber) return null;
  const time = new Date(payment.createdAt).getTime();
  const invoices = await Invoices.find({
    isCanceled: { $ne: true },
    'list.orderId': orderNumber,
    createdAt: { $gte: new Date(time - 60 * 1000), $lte: new Date(time + INVOICE_PAYMENT_WINDOW_MS) },
  }).select('referenceId list createdAt').session(session || null).lean();
  const ids = new Set((payment.list || []).map((p) => String(p?.id || p?._id || '')).filter(Boolean));
  const tracking = new Set((payment.list || []).map((p) => p?.trackingNumber).filter(Boolean));
  return invoices.find((invoice) => (invoice.list || []).some((pkg) => pkg.orderId === orderNumber
    && (ids.has(String(pkg.packageId || '')) || (pkg.trackingNumber && tracking.has(pkg.trackingNumber))))) || null;
}

async function cancelInvoicePackages(user, invoice, session) {
  const refunded = { USD: 0, LYD: 0 };
  const packages = [];
  const invoiceTime = new Date(invoice.createdAt).getTime();

  for (const pkg of invoice.list || []) {
    const summary = { trackingNumber: pkg.trackingNumber, orderId: pkg.orderId, refunds: [], statusUpdated: false };
    const order = await Orders.findOne({ orderId: pkg.orderId }).session(session);

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
      }).session(session);

      for (const payment of payments) {
        const amount = await refundWalletPayment(
          user,
          payment,
          `إلغاء الفاتورة رقم #0${invoice.referenceId} واسترجاع قيمة شحن ${pkg.trackingNumber || ''} إلى المحفظة`,
          `Invoice #0${invoice.referenceId} cancellation ${pkg.orderId || ''}`,
          session
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
      await order.save({ session });
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

module.exports = {
  payFeesLYD, cancelInvoicePackages, deliveryInvoiceOf, refundWalletPayment, statementOfPayment, getPurchaseItemsByDate, getInvoicesQuery, formatDate, cleanUpInventory, isNewCustomer, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages, loadDeliverablePackages, claimPackagesForDelivery, calculateRate, withCalculatedRate };
