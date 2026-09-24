const Orders = require('../models/order');
const ErrorHandler = require('../utils/errorHandler');
const moment = require('moment-timezone');

// Customer value tiers, based on how much they've shipped with us historically.
// Either measure crossing its bar is enough (KG and CBM are different cargo types,
// not both expected on the same customer), so the tier is the higher of the two.
const TIER_RANK = { normal: 0, middle: 1, high: 2 };

const tierFromKG = (kg) => kg > 50 ? 'high' : (kg >= 20 ? 'middle' : 'normal');
const tierFromCBM = (cbm) => cbm > 5 ? 'high' : (cbm >= 2 ? 'middle' : 'normal');

const getValueTier = (totalKG, totalCBM) => {
  const kgTier = tierFromKG(totalKG);
  const cbmTier = tierFromCBM(totalCBM);
  return TIER_RANK[kgTier] >= TIER_RANK[cbmTier] ? kgTier : cbmTier;
};

// Customers who ordered/shipped with us before, but not in the last N months.
// type=invoices  -> last activity is when an invoice was placed (isPayment: true, isShipment: false)
// type=shipments -> last activity is when a package was actually delivered (deliveredPackages.arrivedAt)
module.exports.getInactiveCustomers = async (req, res, next) => {
  try {
    const months = parseInt(req.query.months);
    const type = req.query.type === 'shipments' ? 'shipments' : 'invoices';

    if (!months || months < 1) {
      return next(new ErrorHandler(400, 'Choose how many months of inactivity to look for'));
    }

    const cutoff = moment().subtract(months, 'months').toDate();

    const pipeline = type === 'shipments'
      ? [
        { $unwind: '$paymentList' },
        { $match: {
            unsureOrder: false,
            isCanceled: false,
            'paymentList.deliveredPackages.arrivedAt': { $exists: true, $ne: null },
        } },
        { $group: {
            _id: '$user',
            lastActivityAt: { $max: '$paymentList.deliveredPackages.arrivedAt' },
            activityCount: { $sum: 1 },
        } },
      ]
      : [
        { $match: { unsureOrder: false, isCanceled: false, isPayment: true, isShipment: false } },
        { $group: {
            _id: '$user',
            lastActivityAt: { $max: '$createdAt' },
            activityCount: { $sum: 1 },
        } },
      ];

    const results = await Orders.aggregate([
      ...pipeline,
      { $match: { lastActivityAt: { $lt: cutoff } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $match: { 'user.roles.isClient': true } },
      { $sort: { lastActivityAt: 1 } },
      { $project: {
          _id: '$user._id',
          customerId: '$user.customerId',
          firstName: '$user.firstName',
          lastName: '$user.lastName',
          phone: '$user.phone',
          city: '$user.city',
          lastActivityAt: 1,
          activityCount: 1,
      } },
    ]);

    const userIds = results.map(customer => customer._id);
    let statsByUserId = new Map();

    if (userIds.length > 0) {
      if (type === 'shipments') {
        // Lifetime KG/CBM shipped, so the report shows how much cargo this customer is worth,
        // not just how many times they ordered.
        const lifetimeStats = await Orders.aggregate([
          { $unwind: '$paymentList' },
          { $match: {
              user: { $in: userIds },
              unsureOrder: false,
              isCanceled: false,
              'paymentList.deliveredPackages.arrivedAt': { $exists: true, $ne: null },
          } },
          { $group: {
              _id: { user: '$user', unit: '$paymentList.deliveredPackages.weight.measureUnit' },
              totalWeight: { $sum: '$paymentList.deliveredPackages.weight.total' },
              packagesCount: { $sum: 1 },
              customerSince: { $min: '$paymentList.deliveredPackages.arrivedAt' },
          } },
          { $group: {
              _id: '$_id.user',
              units: { $push: { unit: '$_id.unit', totalWeight: '$totalWeight' } },
              packagesCount: { $sum: '$packagesCount' },
              customerSince: { $min: '$customerSince' },
          } },
        ]);

        statsByUserId = new Map(lifetimeStats.map(stat => {
          const totalKG = stat.units.find(u => u.unit === 'KG')?.totalWeight || 0;
          const totalCBM = stat.units.find(u => u.unit === 'CBM')?.totalWeight || 0;
          return [String(stat._id), {
            totalKG,
            totalCBM,
            packagesCount: stat.packagesCount,
            customerSince: stat.customerSince,
            valueTier: getValueTier(totalKG, totalCBM),
          }];
        }));
      } else {
        // Lifetime invoice total, from invoice-only orders (isPayment true, isShipment false) -
        // the same definition used for "last activity" above.
        const lifetimeStats = await Orders.aggregate([
          { $match: { user: { $in: userIds }, unsureOrder: false, isCanceled: false, isPayment: true, isShipment: false } },
          { $group: {
              _id: '$user',
              totalOrders: { $sum: 1 },
              totalSpent: { $sum: '$totalInvoice' },
              customerSince: { $min: '$createdAt' },
          } },
        ]);

        statsByUserId = new Map(lifetimeStats.map(stat => [String(stat._id), {
          totalOrders: stat.totalOrders,
          totalSpent: stat.totalSpent,
          customerSince: stat.customerSince,
        }]));
      }
    }

    const enrichedResults = results.map(customer => {
      const stats = statsByUserId.get(String(customer._id));

      if (type === 'shipments') {
        return {
          ...customer,
          totalKG: stats?.totalKG || 0,
          totalCBM: stats?.totalCBM || 0,
          packagesCount: stats?.packagesCount || 0,
          customerSince: stats?.customerSince || null,
          valueTier: stats?.valueTier || 'normal',
        };
      }

      return {
        ...customer,
        totalOrders: stats?.totalOrders || 0,
        totalSpent: stats?.totalSpent || 0,
        customerSince: stats?.customerSince || null,
      };
    });

    res.status(200).json({
      type,
      months,
      count: enrichedResults.length,
      results: enrichedResults,
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}
