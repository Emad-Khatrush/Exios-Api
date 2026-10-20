const mongoose = require('mongoose');
const Order = require('../models/order');
const Inventory = require('../models/inventory');
const PaymentHistory = require('../models/orderPaymentHistory');
const User = require('../models/user');
const { JournalEntry } = require('../accounting/models');
const { getConfig } = require('../accounting/services/config');
const { CLAIM_EVENTS, packageChargeCents } = require('../accounting/services/claims/keys');
const ErrorHandler = require('../utils/errorHandler');

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACTIVE = { isFinished: { $ne: true } };
const STAGES = {
  all: ACTIVE, purchase: { ...ACTIVE, isPayment: true, isShipment: { $ne: true } },
  shipping: { ...ACTIVE, isPayment: { $ne: true }, isShipment: true },
  combined: { ...ACTIVE, isPayment: true, isShipment: true },
  // The former Unpaid order stage, limited to active orders; this is not an AR balance.
  waitingPurchase: { ...ACTIVE, unsureOrder: false, orderStatus: 0, isPayment: true, isCanceled: false },
  unpaid: { ...ACTIVE, paymentState: 'unpaid' }, partial: { ...ACTIVE, paymentState: 'partial' },
  hasProblem: { ...ACTIVE, hasProblem: true }, finished: { isFinished: true },
};
const PAYMENT_FILTERS = {
  all: {}, paid: { paymentState: 'paid' }, unpaid: { paymentState: 'unpaid' },
  partial: { paymentState: 'partial' }, unknown: { paymentState: 'unknown' },
};

function counterGroup(withPayments) {
  const yes = field => ({ $eq: [{ $ifNull: [`$${field}`, false] }, true] });
  return { $group: { _id: {
    finished: yes('isFinished'), purchase: yes('isPayment'), shipping: yes('isShipment'), problem: yes('hasProblem'),
    waiting: { $and: [{ $eq: ['$unsureOrder', false] }, { $eq: ['$orderStatus', 0] }, { $eq: ['$isPayment', true] }, { $eq: ['$isCanceled', false] }] },
    ...(withPayments ? { payment: '$paymentState' } : {}),
  }, n: { $sum: 1 } } };
}

// One small matrix serves every category/payment combination for the same search.
function counterMatrix(rows) {
  const emptyCategories = () => Object.fromEntries(Object.keys(STAGES).map(key => [key, 0]));
  const emptyPayments = () => Object.fromEntries(Object.keys(PAYMENT_FILTERS).map(key => [key, 0]));
  const countsByPayment = Object.fromEntries(Object.keys(PAYMENT_FILTERS).map(key => [key, emptyCategories()]));
  const paymentCountsByStage = Object.fromEntries(Object.keys(STAGES).map(key => [key, emptyPayments()]));
  for (const { _id: flags, n } of rows) {
    const categories = flags.finished ? ['finished'] : ['all'];
    if (!flags.finished) {
      if (flags.purchase && flags.shipping) categories.push('combined');
      else if (flags.purchase) categories.push('purchase');
      else if (flags.shipping) categories.push('shipping');
      if (flags.waiting) categories.push('waitingPurchase');
      if (flags.problem) categories.push('hasProblem');
      if (flags.payment === 'unpaid' || flags.payment === 'partial') categories.push(flags.payment);
    }
    const payments = ['all', ...(flags.payment !== 'all' && Object.hasOwnProperty.call(PAYMENT_FILTERS, flags.payment) ? [flags.payment] : [])];
    for (const category of categories) for (const payment of payments) {
      countsByPayment[payment][category] += n;
      paymentCountsByStage[category][payment] += n;
    }
  }
  return { countsByPayment, paymentCountsByStage };
}

// Keep the customer receivable consistent with the accounting order report. Include both
// original entries and their mirrors: filtering to "posted" would count reversals twice.
function moneyStages(accountId) {
  const cents = value => ({ $round: [{ $multiply: [{ $ifNull: [value, 0] }, 100] }, 0] });
  const net = { $subtract: ['$lines.debit', '$lines.credit'] };
  const isClaim = { $and: [{ $in: ['$eventType', CLAIM_EVENTS] }, { $ne: ['$status', 'reversed'] }, { $eq: [{ $ifNull: ['$reversalOf', null] }, null] }] };
  const pipeline = [
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': accountId, 'lines.arKey': /^(PUR|SHP):/, $expr: { $eq: ['$lines.orderId', '$$order'] } } },
    { $group: { _id: null, open: { $sum: net }, billed: { $sum: { $cond: [isClaim, net, 0] } },
      purchase: { $sum: { $cond: [{ $and: [isClaim, { $regexMatch: { input: '$lines.arKey', regex: '^PUR:' } }] }, net, 0] } } } },
  ];
  return [
    { $lookup: { from: JournalEntry.collection.name, localField: '_id', foreignField: 'lines.orderId', let: { order: '$_id' }, pipeline, as: '_money' } },
    { $lookup: { from: PaymentHistory.collection.name, localField: '_id', foreignField: 'order', let: { money: '$_money' }, pipeline: [
      { $match: { $expr: { $eq: [{ $size: '$$money' }, 0] } } },
      { $group: { _id: null, paid: { $sum: cents({ $cond: [{ $eq: ['$currency', 'USD'] }, '$receivedAmount',
        { $cond: [{ $gt: ['$rate', 0] }, { $divide: ['$receivedAmount', '$rate'] }, 0] }] }) },
        unknown: { $sum: { $cond: [{ $and: [{ $ne: ['$currency', 'USD'] }, { $not: [{ $gt: ['$rate', 0] }] }] }, 1, 0] } },
      } },
    ], as: '_payments' } },
    { $addFields: {
      _ledger: { $arrayElemAt: ['$_money', 0] },
      _purchase: { $cond: [{ $and: ['$isPayment', { $ne: ['$unsureOrder', true] }] }, cents('$totalInvoice'), 0] },
      _shipping: { $cond: ['$unsureOrder', 0, { $sum: { $map: { input: { $ifNull: ['$paymentList', []] }, as: 'p', in: { $add: [
        cents({ $multiply: [{ $ifNull: ['$$p.deliveredPackages.weight.total', 0] }, { $ifNull: ['$$p.deliveredPackages.exiosPrice', 0] }] }),
        cents('$$p.deliveredPackages.domesticFee.usd'), cents('$$p.deliveredPackages.customsFee.usd'),
      ] } } } }] },
      _legacyPaid: { $add: [cents('$receivedUSD'), cents('$receivedShipmentUSD'), { $sum: { $map: {
        input: { $ifNull: ['$paymentList', []] }, as: 'p', in: cents('$$p.deliveredPackages.receivedShipmentUSD'),
      } } }] },
      _unknownRate: { $gt: [{ $add: [{ $ifNull: ['$receivedLYD', 0] }, { $ifNull: ['$receivedShipmentLYD', 0] }, { $sum: '$paymentList.deliveredPackages.receivedShipmentLYD' }] }, 0] },
    } },
    // Migration treats payment history as authoritative when present; legacy totals are
    // not added to it, otherwise the same customer payment would appear twice.
    { $addFields: {
      _legacyPaid: { $ifNull: [{ $arrayElemAt: ['$_payments.paid', 0] }, '$_legacyPaid'] },
      _unknownRate: { $cond: [{ $gt: [{ $size: '$_payments' }, 0] }, { $gt: [{ $arrayElemAt: ['$_payments.unknown', 0] }, 0] }, '$_unknownRate'] },
    } },
    { $addFields: {
      billedCents: { $ifNull: ['$_ledger.billed', { $add: ['$_purchase', '$_shipping'] }] },
      purchaseCents: { $ifNull: ['$_ledger.purchase', '$_purchase'] },
      openCents: { $ifNull: ['$_ledger.open', { $subtract: [{ $add: ['$_purchase', '$_shipping'] }, '$_legacyPaid'] }] },
      paymentReliable: { $or: [{ $gt: [{ $size: '$_money' }, 0] }, { $not: ['$_unknownRate'] }] },
      moneySource: { $cond: [{ $gt: [{ $size: '$_money' }, 0] }, 'ledger', 'legacy'] },
    } },
    { $addFields: { paymentState: { $switch: { branches: [
      { case: { $not: ['$paymentReliable'] }, then: 'unknown' },
      { case: { $lte: ['$billedCents', 0] }, then: 'pending' },
      { case: { $lte: ['$openCents', 0] }, then: 'paid' },
      { case: { $gte: ['$openCents', '$billedCents'] }, then: 'unpaid' },
    ], default: 'partial' } } } },
  ];
}

async function attachTrips(orders) {
  const packages = orders.flatMap(order => order.packages || []);
  const ids = packages.map(p => p._id);
  const tripIds = packages.map(p => p.tripId).filter(Boolean);
  if (!ids.length) return;
  // Search only the packages on this page, rather than loading every flight and its cargo.
  const trips = await Inventory.aggregate([
    { $match: { inventoryType: 'inventoryGoods', shippingType: { $ne: 'domestic' },
      $or: [{ _id: { $in: tripIds } }, { 'orders.paymentList._id': { $in: ids } }] } },
    { $project: { voyage: 1, shippingType: 1, packageIds: { $map: {
      input: { $filter: { input: { $ifNull: ['$orders', []] }, as: 'o', cond: { $in: ['$$o.paymentList._id', ids] } } },
      as: 'o', in: '$$o.paymentList._id',
    } } } },
  ]);
  const byId = new Map(trips.map(t => [String(t._id), t]));
  const byPackage = new Map();
  trips.forEach(t => (t.packageIds || []).forEach(id => byPackage.set(String(id), t)));
  packages.forEach(p => {
    const t = byId.get(String(p.tripId)) || byPackage.get(String(p._id));
    p.trip = t ? { _id: t._id, name: t.voyage, method: t.shippingType } : null;
  });
}

function packageView(p) {
  const d = p.deliveredPackages || {};
  return { _id: p._id, tripId: p.tripId, trackingNumber: d.trackingNumber, arrivedAt: d.arrivedAt,
    weight: d.weight, chargeCents: packageChargeCents(p), received: !!p.status?.received,
    arrivedLibya: !!p.status?.arrivedLibya, arrived: !!p.status?.arrived, mark: p.mark };
}

exports.list = async (req, res, next) => {
  try {
    const stage = Object.hasOwnProperty.call(STAGES, req.query.stage) ? req.query.stage : 'all';
    const payment = Object.hasOwnProperty.call(PAYMENT_FILTERS, req.query.payment) ? req.query.payment : 'all';
    const selection = { $and: [STAGES[stage], PAYMENT_FILTERS[payment]] };
    const skip = Math.max(0, Math.min(Number.parseInt(req.query.skip, 10) || 0, 1000000));
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 10, 50));
    const filter = { isCanceled: { $ne: true } };
    const search = String(req.query.search || '').trim().slice(0, 120);
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      if (req.query.searchType === 'trackingNumber') {
        // Tracking mode never falls back to customer names, IDs or order numbers.
        filter['paymentList.deliveredPackages.trackingNumber'] = pattern;
      } else {
        // Resolve just matching customer IDs before filtering orders; do not join every
        // customer's complete document into the order list or cap the matching customers.
        const users = await User.find({ $or: [
          { customerId: pattern }, { firstName: pattern }, { lastName: pattern },
          { $expr: { $regexMatch: { input: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] }, regex: pattern } } },
        ] }).select('_id').lean();
        filter.$or = [{ orderId: pattern }, { 'customerInfo.fullName': pattern },
          ...(users.length ? [{ user: { $in: users.map(user => user._id) } }] : [])];
      }
    }
    const countsOnly = req.query.countsOnly === 'true';
    if (countsOnly && req.query.countsPart === 'categories') {
      // Category totals require no accounting joins or package/payment calculations.
      const rows = await Order.aggregate([{ $match: filter }, counterGroup(false)]).allowDiskUse(true);
      return res.json({ counts: counterMatrix(rows).countsByPayment.all });
    }
    const { settings, offices } = await getConfig();
    const role = settings?.accountRoles?.customer_receivable;
    const accountId = role ? new mongoose.Types.ObjectId(String(role)) : null;
    const stages = moneyStages(accountId);
    if (countsOnly && req.query.countsPart === 'matrix') {
      const rows = await Order.aggregate([
        { $match: filter },
        { $project: { isFinished: 1, isPayment: 1, isShipment: 1, hasProblem: 1, unsureOrder: 1, orderStatus: 1, isCanceled: 1,
          totalInvoice: 1, receivedUSD: 1, receivedLYD: 1, receivedShipmentUSD: 1, receivedShipmentLYD: 1,
          'paymentList.deliveredPackages.weight.total': 1, 'paymentList.deliveredPackages.exiosPrice': 1,
          'paymentList.deliveredPackages.domesticFee.usd': 1, 'paymentList.deliveredPackages.customsFee.usd': 1,
          'paymentList.deliveredPackages.receivedShipmentUSD': 1, 'paymentList.deliveredPackages.receivedShipmentLYD': 1 } },
        ...stages, counterGroup(true),
      ]).allowDiskUse(true);
      return res.json(counterMatrix(rows));
    }
    const financialFilter = stage === 'unpaid' || stage === 'partial' || payment !== 'all';
    const financialFirst = countsOnly || financialFilter;
    const quick = req.query.quick === 'true' && !countsOnly;
    const lastActivity = { $addFields: { lastActivityAt: { $ifNull: ['$orderStatusChangedAt', { $ifNull: [{ $max: '$activity.createdAt' }, '$createdAt'] }] }, ageIsEstimated: { $eq: [{ $ifNull: ['$orderStatusChangedAt', null] }, null] } } };
    const sort = { $sort: req.query.sort === 'waiting' ? { lastActivityAt: 1, _id: 1 } : { createdAt: -1, _id: -1 } };
    const projection = { $project: { orderId: 1, customerInfo: 1, user: 1, shipment: 1, placedAt: 1, productName: 1,
      isPayment: 1, isShipment: 1, unsureOrder: 1, hasProblem: 1, orderNote: 1, isFinished: 1, orderStatus: 1,
      createdAt: 1, lastActivityAt: 1, ageIsEstimated: 1, billedCents: 1, purchaseCents: 1, openCents: 1, paymentState: 1, moneySource: 1,
      packageCount: { $size: { $ifNull: ['$paymentList', []] } },
      paymentList: { $map: { input: { $ifNull: ['$paymentList', []] }, as: 'p', in: {
        _id: '$$p._id', tripId: '$$p.tripId', status: '$$p.status', mark: '$$p.mark', deliveredPackages: {
          trackingNumber: '$$p.deliveredPackages.trackingNumber', arrivedAt: '$$p.deliveredPackages.arrivedAt',
          weight: '$$p.deliveredPackages.weight', exiosPrice: '$$p.deliveredPackages.exiosPrice',
        },
      } } },
    } };
    const countRules = {
      all: true, purchase: { $and: ['$isPayment', { $ne: ['$isShipment', true] }] },
      shipping: { $and: [{ $ne: ['$isPayment', true] }, '$isShipment'] },
      combined: { $and: ['$isPayment', '$isShipment'] },
      waitingPurchase: { $and: [{ $eq: ['$unsureOrder', false] }, { $eq: ['$orderStatus', 0] }, { $eq: ['$isPayment', true] }, { $eq: ['$isCanceled', false] }] },
      unpaid: { $eq: ['$paymentState', 'unpaid'] }, partial: { $eq: ['$paymentState', 'partial'] },
      hasProblem: '$hasProblem', finished: '$isFinished',
    };
    const activeRule = { $ne: [{ $ifNull: ['$isFinished', false] }, true] };
    let result;
    if (quick) {
      // Stream matching records in order; stop after one extra row instead of counting the
      // entire ledger first. The separate counts request supplies the exact total later.
      const monetaryStage = stage === 'unpaid' || stage === 'partial';
      const earlyMatch = { $and: [filter, monetaryStage ? ACTIVE : STAGES[stage]] };
      const rows = await Order.aggregate([
        { $match: earlyMatch },
        ...(req.query.sort === 'waiting' ? [lastActivity] : []), sort,
        ...(financialFilter ? [...stages, { $match: selection }] : []),
        { $skip: skip }, { $limit: limit + 1 },
        ...(!financialFilter ? stages : []),
        ...(req.query.sort !== 'waiting' ? [lastActivity] : []), projection,
      ]).allowDiskUse(true);
      result = { orders: rows.slice(0, limit), hasMore: rows.length > limit };
    } else [result] = await Order.aggregate([
      { $match: filter }, ...(financialFirst ? stages : []),
      { $facet: {
        ...(countsOnly ? {
          counts: [{ $match: PAYMENT_FILTERS[payment] }, { $group: { _id: null, ...Object.fromEntries(Object.entries(countRules).map(([key, rule]) => [key, { $sum: { $cond: [key === 'finished' ? rule : { $and: [activeRule, rule] }, 1, 0] } }])) } }],
          paymentCounts: [{ $match: STAGES[stage] }, { $group: { _id: null, all: { $sum: 1 }, ...Object.fromEntries(Object.keys(PAYMENT_FILTERS).filter(key => key !== 'all').map(key => [key, { $sum: { $cond: [{ $eq: ['$paymentState', key] }, 1, 0] } }])) } }],
        } : {}),
        ...(countsOnly ? {} : { total: [{ $match: selection }, { $count: 'n' }],
        orders: [{ $match: selection }, lastActivity, sort,
          { $skip: skip }, { $limit: limit },
          ...(!financialFirst ? stages : []),
          projection,
        ] }),
      } },
    ]).allowDiskUse(true);
    const orders = result?.orders || [];
    await Order.populate(orders, { path: 'user', select: 'firstName lastName customerId' });
    orders.forEach(o => {
      o.officeLabel = offices.get(o.placedAt)?.name || null;
      const all = (o.paymentList || []).sort((a, b) => {
        const time = p => new Date(p.deliveredPackages?.arrivedAt || 0).getTime() || 0;
        return time(b) - time(a) || String(b._id).localeCompare(String(a._id));
      });
      o.packages = all.slice(0, 3).map(packageView);
      // Show a matching tracking even when it is not among the newest three.
      o.matchedTrackings = search && req.query.searchType === 'trackingNumber' ? all.filter(p => String(p.deliveredPackages?.trackingNumber || '').toLowerCase().includes(search.toLowerCase())).map(p => p.deliveredPackages.trackingNumber) : [];
      delete o.paymentList;
    });
    await attachTrips(orders);
    const counts = Object.fromEntries(Object.keys(STAGES).map(key => [key, result?.counts?.[0]?.[key] || 0]));
    const paymentCounts = Object.fromEntries(Object.keys(PAYMENT_FILTERS).map(key => [key, result?.paymentCounts?.[0]?.[key] || 0]));
    res.json({ orders, ...(countsOnly ? { counts, paymentCounts } : {}),
      total: quick ? null : result?.total?.[0]?.n || 0, totalExact: !quick,
      ...(quick ? { hasMore: result.hasMore } : {}), skip, limit });
  } catch (error) { next(new ErrorHandler(500, error.message)); }
};

exports.packages = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ErrorHandler(400, 'رقم الطلبية غير صحيح');
    const order = await Order.findOne({ _id: req.params.id, isCanceled: { $ne: true } })
      .select('paymentList._id paymentList.tripId paymentList.status paymentList.mark paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.arrivedAt paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice').lean();
    if (!order) throw new ErrorHandler(404, 'الطلبية غير موجودة');
    const packages = (order.paymentList || []).sort((a, b) => (new Date(b.deliveredPackages?.arrivedAt || 0).getTime() || 0) - (new Date(a.deliveredPackages?.arrivedAt || 0).getTime() || 0) || String(b._id).localeCompare(String(a._id))).map(packageView);
    await attachTrips([{ packages }]);
    res.json({ packages });
  } catch (error) { next(error); }
};
