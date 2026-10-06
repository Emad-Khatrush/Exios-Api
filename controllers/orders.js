const { guardOrderUpdate } = require('../utils/orderUpdateGuard');
const { runInTransaction } = require('../accounting/services/transaction');
const { assertOpenPeriod } = require('../accounting/services/periodGuard');
const Orders = require('../models/order');
const Activities = require('../models/activities');
const orderid = require('order-id')('key');
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require('../constants/errorTypes');
const Offices = require('../models/office');
const { addChangedField, getTapTypeQuery, convertObjDataFromStringToNumberType } = require('../middleware/helper');
const { orderLabels } = require('../constants/orderLabels');
const { ORDER_THEME_IDS } = require('../constants/orderThemes');
const mongoose = require('mongoose');
const mongodb = require('mongodb');
const Users = require('../models/user');
const OrderRating = require('../models/orderRating');
const Inventory = require('../models/inventory');
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const Balances = require('../models/balance');
const Invoices = require('../models/invoice');
const { emitAccountingEvent, emitOrdersByNumber } = require('../accounting/services/events');
const { refreshPackageTrips } = require('../accounting/services/tripLinks');
const { deleteOrder: deleteOrderWithLedger } = require('../accounting/services/orderDeletion');
const { syncOrderDebtsOwner } = require('../utils/debts');
const { returnOrderPayments } = require('../utils/orderCancellation');
const { normalizePackages, guardMeasures, keepDeliveryState } = require('../utils/packageMeasures');
const roundFee = (n) => Math.round(n * 100) / 100;
const { payFeesLYD } = require('../utils/helperApi');
const { cancelInvoicePackages, deliveryInvoiceOf, getPurchaseItemsByDate, getInvoicesQuery, cleanUpInventory, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages, loadDeliverablePackages, claimPackagesForDelivery, withCalculatedRate } = require('../utils/helperApi');

const { ObjectId } = mongodb;

module.exports.getInvoices = async (req, res, next) => {
  try {
    const { limit, skip, tabType } = req.query;

    let query = [
      {
        $match: { unsureOrder: false }
      },
      {
        $sort: {
          createdAt: -1
        }
      },
      {
        $skip: Number(skip) || 0
      },
      {
        $limit: Number(limit)
      }
    ]

    if (tabType === 'requestedEditInvoices') {
      query = [
        {
          $match: {
            $and: [
              { unsureOrder: false, isCanceled: false },
              {
                $or: [
                  { requestedEditDetails: { $ne: null } },
                ]
              }
            ]
          }
        },
        {
          $sort: {
            createdAt: -1
          }
        }
      ]
    }

    let orders = await Orders.aggregate(query);
    orders = await Orders.populate(orders, [{ path: "madeBy", select: "-password" }, { path: "user", select: "-password" }]);

    let ordersCountList = (await Orders.aggregate([
      { $match: { isCanceled: false } },
      {
        $group: {
          _id: null,
          all: {
            $sum: {
              $cond: [
                { $eq: ["$unsureOrder", false] },
                1,
                0
              ]
            }
          },
          requestedEditInvoices: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$unsureOrder", false] },
                    {
                      $and: [
                        { $ne: [{ $ifNull: ["$requestedEditDetails", null] }, null] }, // Handles missing or null
                        { $ne: [{ $ifNull: ["$requestedEditDetails", {}] }, {}] }       // Handles missing or empty object
                      ]
                    }
                  ]
                },
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

    res.status(200).json({
      orders,
      countList: ordersCountList,
      limit,
      skip
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getUserPackagesOfOrdersAdmin = async (req, res, next) => {
  try {
    const { tabType } = req.query; // Removed skip and limit
    const { id } = req.params;

    const tabTypeQuery = getTapTypeQuery(tabType);
    tabTypeQuery.isCanceled = false;
    let orders;

    // --- 1. FETCH ALL ORDERS EFFICIENTLY ---
    if (tabType === 'readyForPickup') {
      orders = await Orders.aggregate([
        // This customer view is per package. The order's manually selected status can be
        // stale, or describe other packages that have not arrived yet.
        { $match: { user: new ObjectId(id), isShipment: true, unsureOrder: false, isCanceled: false,
          paymentList: { $elemMatch: { 'status.arrivedLibya': true, 'status.received': false } } } },
        {
          $addFields: {
            paymentList: {
              $filter: {
                input: "$paymentList",
                as: "payment",
                cond: {
                  $and: [
                    { $eq: ["$$payment.status.arrivedLibya", true] },
                    { $eq: ["$$payment.status.received", false] }
                  ]
                }
              }
            }
          }
        },
        { $sort: { createdAt: -1 } },
        // Lookup user to match the populate('user') behavior
        {
          $lookup: {
            from: 'users', // Replace with your exact users collection name if different
            localField: 'user',
            foreignField: '_id',
            as: 'user'
          }
        },
        {
          $unwind: {
            path: '$user',
            preserveNullAndEmptyArrays: true
          }
        }
      ]);
    } else {
      // This view is per package, not per order: a delivered package belongs in "finished"
      // even while other packages of the same order are still on the way.
      const query = tabType === 'finished'
        ? { user: id, isCanceled: false, unsureOrder: false, 'paymentList.status.received': true }
        : { ...tabTypeQuery, user: id };

      orders = await Orders.find(query)
        .populate('user')
        .sort({ createdAt: -1 })
        .lean(); // .lean() is CRITICAL here for memory performance on large datasets

      if (tabType === 'finished' || tabType === 'active') {
        const wantReceived = tabType === 'finished';
        orders = orders
          .map(order => ({
            ...order,
            paymentList: (order.paymentList || []).filter(pkg => !!pkg?.status?.received === wantReceived),
          }))
          .filter(order => order.paymentList.length > 0);
      }
    }

    // --- 2. GATHER ALL PACKAGE IDS ---
    const packageIds = [];
    for (const order of (orders || [])) {
      if (order.paymentList && order.paymentList.length > 0) {
        for (const pkg of order.paymentList) {
          packageIds.push(pkg._id);
        }
      }
    }

    // --- 3. BULK FETCH INVENTORY ONCE ---
    if (packageIds.length > 0) {
      // Using .lean() here saves massive amounts of RAM when fetching all inventory
      const inventories = await Inventory.find({
        'orders.paymentList._id': { $in: packageIds },
        inventoryType: 'inventoryGoods',
        shippingType: { $ne: 'domestic' }
      }).lean();

      // --- 4. MAP INVENTORY IN MEMORY (CRASH-PROOF) ---
      const inventoryMap = {};
      for (const inv of inventories) {
        if (Array.isArray(inv.orders)) {
          for (const invOrder of inv.orders) {

            // Safely handle paymentList if it's not an array in the DB
            const pList = Array.isArray(invOrder.paymentList)
              ? invOrder.paymentList
              : (invOrder.paymentList ? [invOrder.paymentList] : []);

            for (const invPkg of pList) {
              if (invPkg && invPkg._id) {
                inventoryMap[invPkg._id.toString()] = inv;
              }
            }
          }
        }
      }

      // --- 5. ATTACH FLIGHT DATA O(1) SPEED ---
      for (const order of orders) {
        if (order.paymentList) {
          for (const pkg of order.paymentList) {
            if (pkg && pkg._id) {
              const matchedFlight = inventoryMap[pkg._id.toString()];
              if (matchedFlight) {
                pkg.flight = matchedFlight;
              }
            }
          }
        }
      }
    }

    res.status(200).json({
      results: orders,
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getOrders = async (req, res, next) => {
  try {
    const { limit, skip, tabType } = req.query;

    const tabTypeQuery = getTapTypeQuery(tabType);
    tabTypeQuery.isCanceled = false;
    const orders = await Orders.find(tabTypeQuery).populate('user', TRACKING_USER_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit);

    let ordersCountList = (await Orders.aggregate([
      { $match: { isCanceled: false } },
      {
        $group: {
          _id: null,
          finishedOrders: {
            $sum: {
              $cond: [
                { $eq: ["$isFinished", true] },
                1,
                0
              ]
            }
          },
          activeOrders: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$isFinished", false] }, { $eq: ["$unsureOrder", false] }] },
                1,
                0
              ]
            }
          },
          unsureOrders: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$unsureOrder", true] }] },
                1,
                0
              ]
            }
          },
          arrivingOrders: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$isPayment", true] }, { $eq: ["$orderStatus", 1] }] },
                1,
                0
              ]
            }
          },
          shipmentOrders: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$isPayment", false] },
                  { $eq: ["$unsureOrder", false] },
                  { $eq: ["$isShipment", true] },
                  { $eq: ["$isFinished", false] },
                ] },
                1,
                0
              ]
            }
          },
          hasRemainingPayment: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$hasRemainingPayment", true] },
                ] },
                1,
                0
              ]
            }
          },
          hasProblem: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$hasProblem", true] },
                ] },
                1,
                0
              ]
            }
          },
          unpaidOrders: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$orderStatus", 0] },
                  { $eq: ["$unsureOrder", false] },
                  { $eq: ["$isPayment", true] },
                  { $eq: ["$isFinished", false] },
                ] },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0];

    if (!ordersCountList) {
      ordersCountList = {
        finishedOrders: 0,
        activeOrders: 0,
        unsureOrders: 0,
        arrivingOrders: 0,
        shipmentOrders: 0,
        unpaidOrders: 0,
        hasProblem: 0,
        hasRemainingPayment: 0
      }
    }

    res.status(200).json({
      orders,
      activeOrdersCount: ordersCountList.activeOrders,
      shipmentOrdersCount: ordersCountList.shipmentOrders,
      finishedOrdersCount: ordersCountList.finishedOrders,
      unpaidOrdersCount: ordersCountList.unpaidOrders,
      unsureOrdersCount: ordersCountList.unsureOrders,
      arrivingOrdersCount: ordersCountList.arrivingOrders,
      hasProblemOrdersCount: ordersCountList.hasProblem,
      hasRemainingPaymentOrdersCount: ordersCountList.hasRemainingPayment,
      tabType: tabType ? tabType : 'active',
      total: 0,
      query: {
        limit: Number(limit),
        skip: Number(skip)
      }
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

// ---------- X-Tracking ----------

// Only what the admin needs to recognise the customer - never the whole user document.
const TRACKING_USER_FIELDS = 'firstName lastName customerId phone imgUrl';

// Stages shown as chips on X-Tracking, in pipeline order. Each reuses the same rule as the
// old tabs (getTapTypeQuery) so counts and lists always agree.
const TRACKING_STAGES = ['all', 'active', 'unpaid', 'arriving', 'arrivedWarehouse', 'readyForPickup', 'finished', 'hasProblem', 'hasRemainingPayment', 'unsure'];

const trackingStageQuery = (stage) => (stage === 'all' ? {} : getTapTypeQuery(stage));

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Filters shared by the list and the stage counts: office, shipping method, service type and search.
const buildTrackingFilter = async (query) => {
  const filter = { isCanceled: false };
  if (query.office) filter.placedAt = String(query.office);
  if (['air', 'sea'].includes(query.method)) filter['shipment.method'] = query.method;
  if (query.service === 'purchase') filter.isPayment = true;
  if (query.service === 'shipping') filter.isPayment = false;

  // One box searches everything: order ID, customer name/ID, phone, tracking, receipt and container numbers.
  const search = String(query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await Users.find({ customerId: pattern }).select('_id').limit(500).lean();
    filter.$or = [
      { orderId: pattern },
      { 'customerInfo.fullName': pattern },
      { 'customerInfo.phone': pattern },
      { 'paymentList.deliveredPackages.trackingNumber': pattern },
      { 'paymentList.deliveredPackages.receiptNo': pattern },
      { 'paymentList.deliveredPackages.containerInfo.billOfLading': pattern },
      ...(users.length ? [{ user: { $in: users.map((u) => u._id) } }] : []),
    ];
  }
  return filter;
};

// Query: stage, search, office, method (air|sea), service (purchase|shipping),
// sort (recent|waiting), skip, limit. Returns the page, its total and a count per stage
// for the same filters, so every chip shows how many orders it would show.
module.exports.getTrackingOrders = async (req, res, next) => {
  try {
    const stage = TRACKING_STAGES.includes(req.query.stage) ? req.query.stage : 'active';
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const sortByWaiting = req.query.sort === 'waiting';

    const baseFilter = await buildTrackingFilter(req.query);
    // Stage rules carry their own $or/$and, so combine with $and instead of spreading keys
    const listFilter = { $and: [baseFilter, trackingStageQuery(stage)] };

    const [orders, total, countRows] = await Promise.all([
      Orders.aggregate([
        { $match: listFilter },
        { $addFields: { lastActivityAt: { $ifNull: [{ $max: '$activity.createdAt' }, '$createdAt'] } } },
        // "Waiting longest" puts the orders nobody has updated for the longest time first
        { $sort: sortByWaiting ? { lastActivityAt: 1, _id: 1 } : { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: {
            orderId: 1, customerInfo: 1, user: 1, placedAt: 1, shipment: 1, productName: 1,
            totalInvoice: 1, orderStatus: 1, isPayment: 1, isShipment: 1, isFinished: 1,
            unsureOrder: 1, hasProblem: 1, hasRemainingPayment: 1, orderNote: 1, createdAt: 1,
            debt: 1, credit: 1, lastActivityAt: 1,
            lastActivity: { $arrayElemAt: ['$activity', -1] },
            images: { $slice: [{ $ifNull: ['$images', []] }, 6] },
            imagesCount: { $size: { $ifNull: ['$images', []] } },
            packages: { $map: {
              input: { $ifNull: ['$paymentList', []] },
              as: 'p',
              in: {
                _id: '$$p._id',
                trackingNumber: '$$p.deliveredPackages.trackingNumber',
                received: '$$p.status.received',
                arrivedLibya: '$$p.status.arrivedLibya',
                mark: '$$p.mark',
              },
            } },
        } },
      ]).allowDiskUse(true),
      Orders.countDocuments(listFilter),
      Orders.aggregate([
        { $match: baseFilter },
        { $facet: Object.fromEntries(TRACKING_STAGES.map((key) => [key, [{ $match: trackingStageQuery(key) }, { $count: 'n' }]])) },
      ]).allowDiskUse(true),
    ]);

    await Orders.populate(orders, { path: 'user', select: TRACKING_USER_FIELDS });

    const counts = Object.fromEntries(TRACKING_STAGES.map((key) => [key, countRows[0]?.[key]?.[0]?.n || 0]));
    const offices = await Orders.distinct('placedAt', { isCanceled: false });

    res.status(200).json({ orders, total, counts, stage, skip, limit, offices: offices.filter(Boolean).sort() });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.getOrdersTab = async (req, res, next) => {
  try {
    const { limit, skip, tabType } = req.query;

    const tabTypeQuery = getTapTypeQuery(tabType);
    tabTypeQuery.isCanceled = false;
    const orders = await Orders.find(tabTypeQuery).populate('user', TRACKING_USER_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const totalOrders = await Orders.countDocuments();

    res.status(200).json({
      orders,
      tabType: tabType ? tabType : 'active',
      total: totalOrders,
      query: {
        limit: Number(limit),
        skip: Number(skip)
      }
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getOrdersBySearch = async (req, res, next) => {
  let { tabType, startDate, endDate, searchValue, searchType, hideFinishedOrdersCheck } = req.query;
  startDate = startDate && new Date(startDate) || null;
  endDate = endDate && new Date(endDate) || null;

  let query = [
    {
      $match: {
        $or: [
          { orderId: { $regex: new RegExp(searchValue.toLowerCase(), "i") } },
          { "customerInfo.fullName": { $regex: new RegExp(searchValue.toLowerCase(), "i") } },
          { "user.customerId": { $regex: new RegExp(searchValue.toLowerCase(), "i") } }
        ]
      }
    }
  ];

  if (hideFinishedOrdersCheck === "true") {
    query.push({ $match: { isFinished: false } });
  }

  const totalOrders = await Orders.countDocuments();

  if (searchType === "trackingNumber") {
    query = [
      { $unwind: "$paymentList" },
      {
        $match: {
          $or: [
            { "paymentList.deliveredPackages.trackingNumber": { $regex: new RegExp(searchValue.trim().toLowerCase(), "i") } },
            { "customerInfo.fullName": { $regex: new RegExp(searchValue.toLowerCase(), "i") } },
            { "user.customerId": { $regex: new RegExp(searchValue.toLowerCase(), "i") } }
          ]
        }
      }
    ];
    if (hideFinishedOrdersCheck === "true") {
      query.push({ $match: { isFinished: false } });
    }
  } else if (searchType === "phoneNumber") {
    query = [
      { $match: { "customerInfo.phone": { $regex: new RegExp(searchValue.trim().toLowerCase(), "i") } } }
    ];
  } else if (searchType === "receiptAndContainer") {
    query = [
      { $unwind: "$paymentList" },
      {
        $match: {
          $or: [
            { "paymentList.deliveredPackages.receiptNo": { $regex: new RegExp(searchValue.trim().toLowerCase(), "i") } },
            { "paymentList.deliveredPackages.containerInfo.billOfLading": { $regex: new RegExp(searchValue.trim().toLowerCase(), "i") } }
          ]
        }
      }
    ];
  } else if (searchType === "createdAtDate") {
    const ObjectIdRegex = /^[0-9a-fA-F]{24}$/;
    if (ObjectIdRegex.test(searchValue.toLowerCase())) {
      query = [{ $match: { _id: new ObjectId(searchValue.toLowerCase()) } }];
    } else {
      query = [
        {
          $match: {
            $or: [
              { orderId: { $regex: new RegExp(searchValue.toLowerCase(), "i") } },
              { "customerInfo.fullName": { $regex: new RegExp(searchValue.toLowerCase(), "i") } },
              { "user.customerId": { $regex: new RegExp(searchValue.toLowerCase(), "i") } }
            ]
          }
        }
      ];
    }
    if (startDate && endDate) {
      query.push({
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
          unsureOrder: false
        }
      });
    }
  }

  // Lookup user first, then sort
  query.unshift(
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user"
      }
    },
    { $unwind: "$user" },
    // Never send login secrets to the browser
    { $project: { "user.password": 0 } }
  );

  // Always keep $sort at the end
  query.push({ $sort: { createdAt: -1 } });

  try {
    // ✅ allowDiskUse enables disk-based sorting
    let orders = await Orders.aggregate(query).allowDiskUse(true);

    orders = await Orders.populate(orders, [{ path: "madeBy" }, { path: "user" }]);

    res.status(200).json({
      orders,
      tabType: tabType ? tabType : "active",
      total: searchType === "createdAtDate" ? orders.length : totalOrders
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
};
module.exports.createOrder = async (req, res, next) => {
  try {
    if (!req.body) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    const { fullName, email, customerId, phone, fromWhere, toWhere, method, exiosShipmentPrice, originShipmentPrice, weight, packageCount, netIncome, currency, creditCurrency, debt, credit } = req.body;
    // Only admins choose the invoice date, and only for a purchase; otherwise it is the moment of creation
    if (!req.user.roles?.isAdmin || String(req.body.isPayment) !== 'true' || Number.isNaN(new Date(req.body.createdAt).getTime())) delete req.body.createdAt;
    const orderId = orderid.generate().slice(7, 17);
    const isOrderIdTaken = await Orders.findOne({ orderId });
    if (!!isOrderIdTaken) {
      return next(new ErrorHandler(400, errorMessages.ORDER_ID_TAKEN));
    }

    const user = await Users.findOne({ customerId });
    if (!user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));

    const images = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-invoices");
        images.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          category: req.body.invoicesCount > i ? 'invoice' : 'receipts',
          fileType: req.files[i].mimetype
        });
      }
    }


    const outcome = await runInTransaction(async (session) => {
      await assertOpenPeriod(req.user, req.body.createdAt || new Date(), { session });
      const items = JSON.parse(req.body.items);
      const totalInvoice = calculateTotalInvoice(items);

      // Money received is recorded as a payment on the order (Payments tab) or a wallet deposit, so it
      // reaches the books; the old "received" amounts on the order itself are no longer accepted
      const parsedPackages = JSON.parse(req.body.paymentList);
      const receivedOnOrder = ['receivedUSD', 'receivedLYD', 'receivedShipmentUSD', 'receivedShipmentLYD'].some((field) => Number(req.body[field]) > 0)
        || parsedPackages.some((data) => Number(data?.deliveredPackages?.receivedShipmentUSD) > 0 || Number(data?.deliveredPackages?.receivedShipmentLYD) > 0);
      if (receivedOnOrder) {
        throw new ErrorHandler(400, 'Amounts received can no longer be typed on the order. Record them as a payment on the order or a wallet deposit.');
      }

      const paymentList = parsedPackages.map(data => ({
        link: data.paymentLink,
        status: {
          arrived: data.arrived,
          arrivedLibya: data.arrivedLibya,
          paid: data.paid,
          // Handed to the customer only by delivering it with its payment (keepDeliveryState)
          received: false
        },
        deliveredPackages: {
          weight: {
            total: data.deliveredPackages?.weight,
            measureUnit: data.deliveredPackages?.measureUnit,
            ...(data.deliveredPackages?.actualWeight !== undefined && data.deliveredPackages?.actualWeight !== '' && { actual: Number(data.deliveredPackages.actualWeight) }),
          },
          ...(data.deliveredPackages?.volumetric && { volumetric: data.deliveredPackages.volumetric }),
          ...(Number(data.deliveredPackages?.domesticFee?.amount) > 0 && { domesticFee: data.deliveredPackages.domesticFee }),
          ...(Number(data.deliveredPackages?.customsFee?.amount) > 0 && { customsFee: data.deliveredPackages.customsFee }),
          trackingNumber: data.deliveredPackages?.trackingNumber,
          originPrice: data.deliveredPackages.originPrice,
          exiosPrice: data.deliveredPackages.exiosPrice,
          receivedShipmentUSD: data.deliveredPackages.receivedShipmentUSD,
          receivedShipmentLYD: data.deliveredPackages.receivedShipmentLYD,
          containerInfo: {
            billOfLading: data.deliveredPackages?.containerInfo?.billOfLading
          },
          // An empty method is not one of the allowed values; leave it unset instead
          shipmentMethod: data.deliveredPackages.shipmentMethod || undefined,
          receiptNo: data.deliveredPackages.receiptNo,
          boxesCount: data.deliveredPackages.boxesCount,
          locationPlace: data.deliveredPackages.locationPlace,
          ...(data.deliveredPackages.arrivedAt && { arrivedAt: data.deliveredPackages.arrivedAt }),
        },
        note: data.note,
      }))
      // Charged by volume: the chargeable weight; a transport fee in dinars gets its dollars
      await normalizePackages(paymentList);

      const [order] = await Orders.create([{
        ...req.body,
        user,
        orderId,
        totalInvoice,
        customerInfo: {
          fullName,
          email,
          phone
        },
        shipment: {
          fromWhere,
          toWhere,
          method,
          exiosShipmentPrice,
          originShipmentPrice,
          weight,
          packageCount
        },
        netIncome: [{
          nameOfIncome: 'payment',
          total: netIncome
        }],
        debt: {
          currency,
          total: debt
        },
        credit: {
          currency: creditCurrency,
          total: credit
        },
        activity: [{
          country: req.body.placedAt === 'tripoli' ? 'مكتب طرابلس' : 'مكتب بنغازي',
          description: 'في مرحلة تجهيز الطلبية'
        }],
        images,
        paymentList,
        items
      }], { session });

      await Activities.create([{
        user: req.user,
        details: {
          path: '/invoices',
          status: 'added',
          type: 'order',
          actionId: order._id
        }
      }], { session })
      await emitAccountingEvent('order', order._id, {}, req.user, { session });

      let totalIncreaseOfDollar = (order.receivedShipmentUSD + order.receivedUSD) || 0;
      let totalIncreaseOfDinnar = (order.receivedShipmentLYD + order.receivedLYD) || 0;

      // calculate received shipment for each package
      for (let i = 0; i < order.paymentList?.length; i++) {
        console.log(order.paymentList[i]?.deliveredPackages?.receivedShipmentUSD);
        totalIncreaseOfDollar += (order.paymentList[i]?.deliveredPackages?.receivedShipmentUSD || 0);
        totalIncreaseOfDinnar += (order.paymentList[i]?.deliveredPackages?.receivedShipmentLYD || 0);
      }

      const updateQuery = {};

      if (totalIncreaseOfDollar !== 0) {
        updateQuery['usaDollar.value'] = totalIncreaseOfDollar;
      }

      if (totalIncreaseOfDinnar !== 0) {
        updateQuery['libyanDinar.value'] = totalIncreaseOfDinnar;
      }

      if (totalIncreaseOfDollar || totalIncreaseOfDinnar) {
        await Offices.findOneAndUpdate({ office: order.placedAt }, {
          $inc: updateQuery
        }, { ...({
          new: true
        }), session });
      }

      return order;
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    let query = { $or: [{ orderId: String(id) }] };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    }

    const order = await Orders.findOne(query).populate(['madeBy', 'user']).lean();
    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

    const updatedPaymentList = await Promise.all(order.paymentList.map(async (data) => {
      const inventory = await Inventory.findOne({ 'orders.paymentList._id': data._id, inventoryType: 'inventoryGoods', shippingType: { $ne: 'domestic' } });
      if (inventory) {
        // If inventory is found, add the flight property to the payment data
        data.flight = inventory;
      }
      return data; // Return the updated payment data
    }));

    order.paymentList = updatedPaymentList; // Assign the updated paymentList back to order

    // const newCustomer = await isNewCustomer(order.user._id);
    // order.isNewCustomer = newCustomer;

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getPublicOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    let query = { $or: [{ orderId : String(id) }] };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    }
    const order = await Orders.findOne(query).populate(['madeBy', 'user']);

    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.cancelOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    const outcome = await runInTransaction(async (session) => {

      let query = { orderId : String(id) };
      if (mongoose.Types.ObjectId.isValid(id)) {
        query = { _id: id };
      }

      const existing = await Orders.findOne(query).lean().session(session);
      if (!existing) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);
      await assertOpenPeriod(req.user, existing.createdAt, { session });
      // Everything paid on the order goes back to the customer's wallet (owner's decision). Also
      // works on an order cancelled before this rule, to give its payments back.
      const returned = await returnOrderPayments(existing, req.user, { session });

      const updateQuery = existing.isCanceled ? {} : {
        isCanceled: true,
        cancelation: {
          reason: req.body.cancelationReason
        }
      }

      const order = await Orders.findOneAndUpdate({ _id: existing._id }, updateQuery, { new: true, session }).populate('madeBy');
      await emitAccountingEvent('order', order._id, {}, req.user, { session });

      return { ...order.toObject(), returned };
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

// Removes an order for good (admins only, see the route). Refused while anything hangs on the
// order; the accounting side is settled in the same step.
module.exports.deleteOrder = async (req, res, next) => {
  try {
    const result = await runInTransaction(async (session) => {
      const result = await deleteOrderWithLedger(req.params.id, req.user, { session });
      await Activities.create([{
        user: req.user,
        details: { path: '/invoices', status: 'deleted', type: 'order', actionId: req.params.id },
        changedFields: [{ label: 'orderId', value: result.orderId, changedFrom: result.orderId, changedTo: 'deleted' }],
      }], { session });
      return result;
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.updateOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    const outcome = await runInTransaction(async (session) => {
      const body = JSON.parse(JSON.stringify(req.body || {}));

      let user;
      if (!!body.customerId) {
        user = await Users.findOne({ customerId: body.customerId }).session(session);
        if (!user) throw new ErrorHandler(400, errorMessages.USER_NOT_FOUND);
      }

      const oldOrder = await Orders.findOne({ _id: String(id) }).session(session);
      if (!oldOrder) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);
      await assertOpenPeriod(req.user, oldOrder.createdAt, { session });
      guardOrderUpdate(body, oldOrder);
      // A saved weight or volume is changed by an admin or the accountant only; the chargeable weight
      // is worked out here (spec v8)
      if (Array.isArray(body.paymentList)) {
        try {
          await guardMeasures(oldOrder, body.paymentList, req.user);
          await normalizePackages(body.paymentList);
          keepDeliveryState(oldOrder, body.paymentList);
        } catch (error) {
          throw new ErrorHandler(error.statusCode || 400, error.message);
        }
      }

      // The invoice date: admins only, and only until the invoice is confirmed
      let invoiceDate;
      if (body.createdAt !== undefined) {
        invoiceDate = new Date(body.createdAt);
        delete body.createdAt;
        if (Number.isNaN(invoiceDate.getTime())) throw new ErrorHandler(400, 'Invalid invoice date');
        if (invoiceDate.getTime() === new Date(oldOrder.createdAt).getTime()) invoiceDate = undefined;
        // A shipment's invoice is final from the moment it is created; only a purchase has a date to set
        else if (!(body.isPayment ?? oldOrder.isPayment)) invoiceDate = undefined;
        else if (!req.user.roles?.isAdmin) throw new ErrorHandler(403, 'Only admins can change the invoice date');
        else if (oldOrder.invoiceConfirmed) throw new ErrorHandler(400, 'The invoice is confirmed; its date can no longer be changed');
      }

      if (invoiceDate) await assertOpenPeriod(req.user, invoiceDate, { session });

      if (body.credit && body.credit.creditCurrency) {
        body.credit.currency = body.credit.creditCurrency;
      }

      let update = {
        ...body,
        customerInfo: {
          ...oldOrder.customerInfo,
          ...body.customerInfo
        },
        shipment: {
          ...oldOrder.shipment,
          ...body.shipment
        },
        debt: {
          ...oldOrder.debt,
          ...body.debt
        },
        credit: {
          ...oldOrder.credit,
          ...body.credit
        }
      }

      if (user) update.user = user;
      const newOrder = await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true, session }).populate('user');
      if (!newOrder) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);

      // createdAt is a timestamp Mongoose never rewrites, so it is set straight in the collection
      if (invoiceDate) await Orders.collection.updateOne({ _id: newOrder._id }, { $set: { createdAt: invoiceDate } }, { session });

      // The order moved to another customer: its unpaid debts move with it
      if (user && !user._id.equals(oldOrder.user)) {
        await syncOrderDebtsOwner(newOrder._id, user._id, { session });
      }

      // calculate the revenue of the order
      const dollarDifference =  newOrder.receivedUSD - oldOrder.receivedUSD;
      const dinnarDifference =  newOrder.receivedLYD - oldOrder.receivedLYD;

      const dinnarShipmentDifference =  newOrder.receivedShipmentLYD - oldOrder.receivedShipmentLYD;
      const dollarShipmentDifference =  newOrder.receivedShipmentUSD - oldOrder.receivedShipmentUSD;

      let totalIncreaseOfDollar = dollarDifference + dollarShipmentDifference;
      let totalIncreaseOfDinnar = dinnarDifference + dinnarShipmentDifference;

      // calculate received shipment for each package
      // Each package is compared with itself before the update (by id, not by position: a package
      // removed from the middle of the list shifts every position after it)
      const oldPackages = new Map((oldOrder.paymentList || []).map((orderPackage) => [String(orderPackage._id), orderPackage]));
      for (const orderPackage of newOrder.paymentList || []) {
        const before = oldPackages.get(String(orderPackage._id))?.deliveredPackages;
        totalIncreaseOfDollar += (orderPackage?.deliveredPackages?.receivedShipmentUSD - (before?.receivedShipmentUSD || 0)) || 0;
        totalIncreaseOfDinnar += (orderPackage?.deliveredPackages?.receivedShipmentLYD - (before?.receivedShipmentLYD || 0)) || 0;
      }
      const updateQuery = {};

      if (totalIncreaseOfDollar !== 0) {
        updateQuery['usaDollar.value'] = totalIncreaseOfDollar;
      }

      if (totalIncreaseOfDinnar !== 0) {
        updateQuery['libyanDinar.value'] = totalIncreaseOfDinnar;
      }

      if (totalIncreaseOfDollar || totalIncreaseOfDinnar) {
        await Offices.findOneAndUpdate({ office: newOrder.placedAt }, {
          $inc: updateQuery
        }, { ...({
          new: true
        }), session });
      }

      // Remove received goods from the warehouse
      if (body?.paymentList?.length > 0) {
        // Filter delivered goods and update the deliveredDate
        const receivedOrders = body.paymentList.filter(orderPackage => orderPackage.status.received);
        const ordersHasReceviedNow = (oldOrder.paymentList || []).map(oldOrderPackage => {

          const newUpdatedOrder = receivedOrders.find((newOrderPackage => {
            const found = new ObjectId(newOrderPackage._id).equals(oldOrderPackage._id);
            return found;
          }));

          if (!!newUpdatedOrder && !oldOrderPackage.status.received && newUpdatedOrder.status.received) {
            return oldOrderPackage._id;
          }
          return;
        })
          .filter(orderPackage => !!orderPackage)

        update.paymentList = body.paymentList.map(orderPackage => {
          const newPackage = orderPackage.status.received && !!orderPackage?.index;
          const isOrderReceived = ordersHasReceviedNow.find(id => new ObjectId(id).equals(orderPackage._id));

          if (isOrderReceived || newPackage) {
            return ({ ...orderPackage, deliveredPackages: { ...orderPackage.deliveredPackages, deliveredInfo: { deliveredDate: new Date() } } });
          }
          return orderPackage;
        });

        await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true, session });

        // Mongoose's query builder (Model.updateMany included) silently no-ops
        // this $pull on real warehouse documents - the raw driver, bypassing
        // it entirely, is the only reliable way to actually remove the array
        // element (see the same fix and comment in controllers/inventory.js).
        await Inventory.collection.updateMany(
          { inventoryType: 'warehouseInventory' },
          {
            $pull: {
              orders: {
                $or: [
                  { "paymentList._id": { $in: receivedOrders.map(orderPackage => orderPackage._id) } },
                  { "paymentList._id": { $in: receivedOrders.map(orderPackage => new ObjectId(orderPackage._id)) } }
                ]
              }
            }
          }
        , { session })
      }

      // add activity to the order
      const changedFields = [];
      if (Object.keys(body).length > 3) {
        for (const fieldName in body) {
          if (!(fieldName === 'isPayment' || fieldName === 'orderStatus' || fieldName === 'isFinished' || fieldName === 'isShipment' || fieldName === 'shipment' || fieldName === 'customerInfo' || fieldName === 'netIncome' || fieldName === 'unsureOrder')) {
            changedFields.push(addChangedField(fieldName, newOrder[fieldName], oldOrder[fieldName], orderLabels));
          }
        }
      }
      await Activities.create([{
        user: req.user,
        details: {
          path: '/invoices',
          status: 'updated',
          type: 'order',
          actionId: newOrder._id
        },
        changedFields
      }], { session });
      // Saving the order rewrites its packages; their trip links are worked out again
      await refreshPackageTrips((newOrder.paymentList || []).map((pkg) => pkg._id), { session });
      await emitAccountingEvent('order', newOrder._id, {}, req.user, { session });
      return newOrder;
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.updateSinglePackage = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    const outcome = await runInTransaction(async (session) => {
      const body = JSON.parse(JSON.stringify(req.body || {}));

      let user;
      if (!!body.customerId) {
        user = await Users.findOne({ customerId: body.customerId }).session(session);
        if (!user) throw new ErrorHandler(400, errorMessages.USER_NOT_FOUND);
      }

      let oldOrder = await Orders.findOne({ _id: String(id) }).session(session);
      if (!oldOrder) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);
      await assertOpenPeriod(req.user, oldOrder.createdAt, { session });
      guardOrderUpdate(body, oldOrder);
      if (body.paymentList) {
        try {
          await guardMeasures(oldOrder, [body.paymentList], req.user);
          await normalizePackages([body.paymentList]);
          keepDeliveryState(oldOrder, [body.paymentList]);
        } catch (error) {
          throw new ErrorHandler(error.statusCode || 400, error.message);
        }
      }
      const index = oldOrder.paymentList.findIndex(orderPackage => new ObjectId(body.paymentList._id).equals(new ObjectId(orderPackage._id)));
      if (index !== -1) {
        oldOrder.paymentList[index] = body.paymentList;
      }
      const update = {
        ...body,
        paymentList: oldOrder.paymentList
      }

      if (user) update.user = user;
      const newOrder = await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true, session });
      if (!newOrder) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);

      // The order moved to another customer: its unpaid debts move with it
      if (user && !user._id.equals(oldOrder.user)) {
        await syncOrderDebtsOwner(newOrder._id, user._id, { session });
      }
      // Saving the order rewrites its packages; their trip links are worked out again
      await refreshPackageTrips((newOrder.paymentList || []).map((pkg) => pkg._id), { session });
      await emitAccountingEvent('order', newOrder._id, {}, req.user, { session });

      return newOrder;
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getPackagesOfOrders = async (req, res, next) => {
  try {
    let sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 3);

    let packages = await Orders.aggregate([
      {
        $unwind: '$paymentList'
      },
      {
        $match: {
          isCanceled: false,
          unsureOrder: false,
          'paymentList.deliveredPackages.arrivedAt': { $gte: sixMonthsAgo }
        }
      },
      {
        $sort: { 'paymentList.deliveredPackages.arrivedAt': -1 }
      },
    ]);
    packages = await Orders.populate(packages, { path: "madeBy" });

    res.status(200).send(packages);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(400, error.message));
  }
}

module.exports.createUnsureOrder = async (req, res, next) => {
  try {
    if (!req.body) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    const orderId = orderid.generate().slice(7, 17);
    const isOrderIdTaken = await Orders.findOne({ orderId });
    if (!!isOrderIdTaken) {
      return next(new ErrorHandler(400, errorMessages.ORDER_ID_TAKEN));
    }
    const order = await Orders.create({
      user: req.user,
      orderId,
      customerInfo: {
        fullName: req.body.fullName,
        phone: req.body.phone,
      },
      placedAt: req.body.placedAt,
      shipment: {
        fromWhere: req.body.fromWhere,
        toWhere: req.body.toWhere,
        method: req.body.method
      },
      isShipment: true,
      unsureOrder: true
    });
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(400, error.message));
  }
}
module.exports.uploadFilesToLinks= async (req, res, next) => {
  const { id, paymentListId } = req.body;

  const images = [];
  const changedFields = [];

    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-invoices");
        images.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
        changedFields.push({
          label: 'image',
          value: 'image',
          changedFrom: '',
          changedTo: uploadedImg.publicUrl
        })
      }
    }

  await Orders.updateOne({ _id: id, 'paymentList._id': paymentListId }, {
    $push: { 'paymentList.$.images': images },
  }, { safe: true, upsert: true, new: true });

  const order = await Orders.findOne({ _id: id });

  await Activities.create({
    user: req.user,
    details: {
      path: '/invoices',
      status: 'added',
      type: 'order',
      actionName: 'image',
      actionId: order._id
    },
    changedFields
  })

  res.status(200).json(order);
}

module.exports.uploadFiles= async (req, res, next) => {
  const { id } = req.body;

  const images = [];
  const changedFields = [];

    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-invoices");
        images.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          category: req.body.type,
          fileType: req.files[i].mimetype
        });
        changedFields.push({
          label: 'image',
          value: 'image',
          changedFrom: '',
          changedTo: uploadedImg.publicUrl
        })
      }
    }

  const order = await Orders.findByIdAndUpdate(id, {
    $push: { "images": images },
  }, { safe: true, upsert: true, new: true });

  await Activities.create({
    user: req.user,
    details: {
      path: '/invoices',
      status: 'added',
      type: 'order',
      actionName: 'image',
      actionId: order._id
    },
    changedFields
  })

  res.status(200).json(order)
}

module.exports.deleteLinkFiles= async (req, res, next) => {
  try {
    const order = await Orders.findOneAndUpdate({ _id: req.body.id, 'paymentList._id': req.body.paymentListId }, {
      $pull: {
        'paymentList.$.images': {
          filename: req.body.filename
        }
      }
    }, { safe: true, upsert: true, new: true });

    // const response = await cloudinary.uploader.destroy(req.body.image.filename);
    // if (response.result !== 'ok') {
    //   return next(new ErrorHandler(404, errorMessages.IMAGE_NOT_FOUND));
    // }

    // await Activities.create({
    //   user: req.user,
    //   details: {
    //     path: '/invoices',
    //     status: 'deleted',
    //     type: 'order',
    //     actionName: 'image',
    //     actionId: order._id
    //   },
    //   changedFields: [{
    //     label: 'image',
    //     value: 'image',
    //     changedFrom: req.body.image.path,
    //     changedTo: ''
    //   }]
    // })

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.deleteFiles= async (req, res, next) => {
  try {
    const order = await Orders.findByIdAndUpdate(req.body.id, {
      $pull: {
        images: {
          filename: req.body.image.filename
        }
      }
    }, { safe: true, upsert: true, new: true });

    // const response = await cloudinary.uploader.destroy(req.body.image.filename);
    // if (response.result !== 'ok') {
    //   return next(new ErrorHandler(404, errorMessages.IMAGE_NOT_FOUND));
    // }

    await Activities.create({
      user: req.user,
      details: {
        path: '/invoices',
        status: 'deleted',
        type: 'order',
        actionName: 'image',
        actionId: order._id
      },
      changedFields: [{
        label: 'image',
        value: 'image',
        changedFrom: req.body.image.path,
        changedTo: ''
      }]
    })

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createOrderActivity = async (req, res, next) => {
  try {
    const order = await Orders.findByIdAndUpdate(req.params.id, {
      $push: {
        activity: req.body
      }
    }, { new: true });

    await Activities.create({
      user: req.user,
      details: {
        path: '/invoices',
        status: 'added',
        type: 'activity',
        actionId: order._id
      }
    })
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

// Removes one activity from an order's timeline (admins only, see the route)
module.exports.deleteOrderActivity = async (req, res, next) => {
  try {
    const { id, activityId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(activityId)) return next(new ErrorHandler(400, 'Invalid activity'));
    const order = await Orders.findOneAndUpdate(
      { _id: id, 'activity._id': activityId },
      { $pull: { activity: { _id: activityId } } },
      { new: true }
    );
    if (!order) return next(new ErrorHandler(404, 'Activity not found'));

    await Activities.create({
      user: req.user,
      details: {
        path: '/invoices',
        status: 'deleted',
        type: 'activity',
        actionId: order._id
      }
    });
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(400, error.message));
  }
}

module.exports.updateStatusOfOrder = async (req, res, next) => {
  try {
    const outcome = await runInTransaction(async (session) => {

      const { statusType, data, value, inventoryId } = req.body;
      if (!['arrived', 'arrivedLibya'].includes(statusType) || typeof value !== 'boolean' || !Array.isArray(data)) throw new ErrorHandler(400, 'Only arrival status can be changed here; use delivery for received packages');

      const orders = data;
      const response = await Orders.updateMany(
        {
          orderId: { $in: orders.map(order => order?.orderId) },
          'paymentList.deliveredPackages.trackingNumber': { $in: orders.map(order => order?.trackingNumber) }
        },
        {
          $set: {
            'paymentList.$[elem].status.arrived': true,
            [`paymentList.$[elem].status.${statusType}`]: value
          }
        },
        { ...({
          arrayFilters: [
            { 'elem.deliveredPackages.trackingNumber': { $in: orders.map(order => order?.trackingNumber) } },
          ],
          multi: true,
          new: true
        }), session }
      );

      await Orders.updateMany(
        {
          orderId: { $in: orders.map(order => order?.orderId) },
        },
        [
          {
            $set: {
              orderStatus: {
                $cond: {
                  if: { $eq: ['$isPayment', true] },
                  then: 4,
                  else: 3
                }
              }
            }
          }
        ],
        { ...({
          multi: true,
          new: true
        }), session }
      );

      await Inventory.updateMany(
        {
          _id: new ObjectId(inventoryId),
          'orders.paymentList._id': { $in: orders.map(order => order?.paymentListId) }
        },
        {
        $set: {
          [`orders.$.paymentList.status.arrived`]: true,
          [`orders.$.paymentList.status.${statusType}`]: value,
        }
      }, { new: true, session });
      await emitOrdersByNumber(orders.map(order => order?.orderId), req.user, { session });

      return response;
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

// Client Interface Controllers
module.exports.getClientHomeData = async (req, res, next) => {
  try {
    const receivedOrders = await Orders.countDocuments({ user: req.user._id, isFinished: true, unsureOrder: false });
    const readyForReceivement = await Orders.countDocuments({ user: req.user._id, unsureOrder: false, $or: [ { isPayment: true, orderStatus: 4 }, { isPayment: false, orderStatus: 3 } ] });
    const activeOrders = await Orders.countDocuments({ user: req.user._id, isCanceled: false, unsureOrder: false, isFinished: false });
    const totalPaidInvoices = (await Orders.aggregate([
      { $match: { user: req.user._id, isCanceled: false, unsureOrder: false } },
      { $group: { _id: 'id', total: { $sum: '$totalInvoice' } } },
      { $project: { _id: 0 } }
    ]))[0]?.total || 0;

    res.status(200).json({
      results: {
        countList: {
          receivedOrders,
          readyForReceivement,
          totalPaidInvoices,
          activeOrders
        }
      }
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getOrdersForUser = async (req, res, next) => {
  try {
    const { type } = req.params;
    const query = convertObjDataFromStringToNumberType(req.query);

    let orders;
    if (type === 'all') {
      orders = await Orders.find({ user: req.user._id, isCanceled: false, unsureOrder: false, isFinished: false }, query).sort({ createdAt: -1 });
    } else {
      const queryType = getTapTypeQuery(type);
      orders = await Orders.find({ ...queryType, user: req.user._id, isCanceled: false }, query).sort({ createdAt: -1 });
    }

    let ordersCountList = (await Orders.aggregate([
      { $match: { isCanceled: false, user: req.user._id } },
      {
        $group: {
          _id: null,
          finishedOrders: {
            $sum: {
              $cond: [
                { $eq: ["$isFinished", true] },
                1,
                0
              ]
            }
          },
          activeOrders: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$isFinished", false] },
                    { $eq: ["$unsureOrder", false] },
                    { $eq: ["$isCanceled", false] },
                    {
                      $or: [
                        { $and: [{ $eq: ["$isPayment", true] }, { $eq: ["$isShipment", true] }] },
                        { $and: [{ $eq: ["$isShipment", true] }, { $eq: ["$isPayment", false] }] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          unsureOrders: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$isFinished", false] }, { $eq: ["$unsureOrder", true] }] },
                1,
                0
              ]
            }
          },
          warehouseArrived: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$unsureOrder", false] },
                    { $eq: ["$isCanceled", false] },
                    {
                      $or: [
                        {
                          $and: [
                            { $eq: ["$isPayment", true] },
                            { $or: [{ $eq: ["$orderStatus", 2] }, { $eq: ["$orderStatus", 3] }] }
                          ]
                        },
                        {
                          $and: [
                            { $eq: ["$isPayment", false] },
                            { $or: [{ $eq: ["$orderStatus", 1] }, { $eq: ["$orderStatus", 2] }] }
                          ]
                        }
                      ]
                    },
                    {
                      $or: [
                        { $and: [{ $eq: ["$isPayment", true] }, { $eq: ["$isShipment", true] }] },
                        { $and: [{ $eq: ["$isShipment", true] }, { $eq: ["$isPayment", false] }] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          readyForReceivement: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$unsureOrder", false] },
                    { $eq: ["$isCanceled", false] },
                    {
                      $or: [
                        {
                          $and: [
                            { $eq: ["$isPayment", true] },
                            { $eq: ["$orderStatus", 4] }
                          ]
                        },
                        {
                          $and: [
                            { $eq: ["$isPayment", false] },
                            { $eq: ["$orderStatus", 3] }
                          ]
                        }
                      ]
                    },
                    {
                      $or: [
                        { $and: [{ $eq: ["$isPayment", true] }, { $eq: ["$isShipment", true] }] },
                        { $and: [{ $eq: ["$isShipment", true] }, { $eq: ["$isPayment", false] }] }
                      ]
                    }
                  ]
                },
                1,
                0
              ]
            }
          },
          invoiceOrders: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$isShipment", false] }, { $eq: ["$isPayment", true] }, { $eq: ["$unsureOrder", false] }] },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0];

    if (!ordersCountList) {
      ordersCountList = {
        finishedOrders: 0,
        activeOrders: 0,
        unsureOrders: 0,
        warehouseArrived: 0,
        readyForReceivement: 0,
        invoiceOrders: 0
      }
    }

    res.status(200).json({
      results: {
        orders,
        countList: ordersCountList || []
      }
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getOrdersClientBySearch= async (req, res, next) => {
  const { value } = req.params;

  let query = [
    { $match: { unsureOrder: false, $or: [ {orderId: { $regex: new RegExp(value.toLowerCase(), 'i') }, user: req.user._id}, { 'paymentList.deliveredPackages.trackingNumber': { $regex: new RegExp(value.trim().toLowerCase(), 'i') }, user: req.user._id }, { 'customerInfo.fullName': { $regex: new RegExp(value.toLowerCase(), 'i') }, user: req.user._id } ] } }
  ]

  if (value === '') {
    query = [
      { $match: { user: req.user._id, isCanceled: false, unsureOrder: false } }
    ]
  }

  // sort newest order to top
  query.push({
    $sort: { createdAt: -1 }
  })

  // show only the important fields
  const orderedList = convertObjDataFromStringToNumberType(req.query);
  query.push({
    $project: orderedList
  })

  try {
    const orders = await Orders.aggregate(query);
    res.status(200).json({
      results: {
        orders
      }
    })
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.deleteUnsureOrder = async (req, res, next) => {
  try {
    const order = await Orders.findOne({ user: req.user, _id: req.params.id });
    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
    if (!order.unsureOrder) return next(new ErrorHandler(404, errorMessages.ORDER_CANT_DELETE));

    await Orders.deleteOne({ user: req.user, _id: req.params.id });
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createTrackingNumbersForClient = async (req, res, next) => {
  try {
    const trackingArray = [];
    req.body.forEach(({ trackingNumber, method }) => {
      trackingArray.push({
        deliveredPackages: {
          trackingNumber,
          shipmentMethod: method
        }
      })
    })
    const orderId = orderid.generate().slice(7, 17);

    const order = await Orders.create({
      user: req.user,
      orderId,
      customerInfo: {
        fullName: '.',
        phone: 0,
      },
      placedAt: 'tripoli',
      shipment: {
        fromWhere: '.',
        toWhere: '.',
        method: 'air'
      },
      isShipment: true,
      unsureOrder: true,
      paymentList: trackingArray
    });
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.markPackagesAsDelivered = async (req, res, next) => {
  try {
    const id = req.params.id;
    validatePackages(req.body.selectedPackages);
    const paymentAmounts = validatePayment(req.body.payment, { allowZero: true });

    // Costs and totals come from the database; the client's totalCost and rate are ignored
    const feeMode = req.body.feeMode === 'usd' ? 'usd' : 'separate';
    const { selectedPackages } = await require('../accounting/services/transaction').runInTransaction(async (session) => {
      const { packages, totalCost, feesLYD, totalFeeLYD } = await loadDeliverablePackages(id, req.body.selectedPackages, { feeMode, session });
      // Nothing paid is right only for packages that cost nothing (free shipping with a purchase)
      if (!paymentAmounts.amountUSD && !paymentAmounts.amountLYD && (totalCost > 0 || totalFeeLYD > 0)) {
        throw new ErrorHandler(400, 'Payment amount cannot be zero');
      }

      const payment = withCalculatedRate(paymentAmounts, totalCost);
      const walletMap = await getUserWalletMap(id, session);
      checkSufficientFunds(walletMap, payment, totalCost, totalFeeLYD);

      // The transaction claims packages before any deduction. If any later write fails, both the
      // claim and every wallet, payment, debt, invoice, warehouse and outbox change roll back.
      await claimPackagesForDelivery(id, packages, session);
      await processPackagesPayment(req, res, next, id, packages, payment, { session });
      await payFeesLYD(req, res, next, id, feesLYD, session);
      await updateOrderStatuses(packages, session);
      await createInvoice(req.user, id, packages, { ...payment, amountLYD: roundFee(Number(payment.amountLYD || 0) + totalFeeLYD) }, totalCost, session);
      await cleanUpInventory(packages, session);
      await emitOrdersByNumber(packages.map(pkg => pkg.orderId), req.user, { session });
      return { selectedPackages: packages };
    });


    return res.status(200).json({ done: new Date() });

  } catch (error) {
    console.error(error);
    // Keep 400s as 400 so the admin sees the real reason instead of a generic server error
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

module.exports.getInvoicesByCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const invoices = await Invoices.find({ customer: id })
      .populate('customer')
      .populate('canceledBy', 'firstName lastName')
      .sort({ createdAt: -1 });

    res.status(200).json({
      results: invoices
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.cancelInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const wanted = Array.isArray(req.body?.packageIds) ? req.body.packageIds.map(String) : [];
    const outcome = await require('../accounting/services/transaction').runInTransaction(async (session) => {
      const current = await Invoices.findById(id).session(session).lean();
      if (!current) throw new ErrorHandler(404, 'Invoice not found');
      if (current.isCanceled) throw new ErrorHandler(400, 'Invoice is already cancelled');
      const chosen = (current.list || []).map((pkg, index) => ({ pkg, index }))
        .filter(({ pkg }) => !pkg.canceledAt && (!wanted.length || wanted.includes(String(pkg.packageId))));
      if (!chosen.length) throw new ErrorHandler(400, 'Choose a package of this invoice that is not cancelled yet');
      const whole = chosen.length === (current.list || []).filter((pkg) => !pkg.canceledAt).length;

      // Claim the cancellation and reverse its payments, customer balance and accounting outbox
      // in one transaction. A failed refund leaves the invoice and delivered packages untouched.
      const now = new Date();
      const guard = { _id: id, isCanceled: { $ne: true } };
      const marks = {};
      chosen.forEach(({ index }) => {
        guard[`list.${index}.canceledAt`] = { $exists: false };
        marks[`list.${index}.canceledAt`] = now;
        marks[`list.${index}.canceledBy`] = req.user._id;
      });
      if (whole) Object.assign(marks, { isCanceled: true, canceledAt: now, canceledBy: req.user._id });
      const invoice = await Invoices.findOneAndUpdate(guard, { $set: marks }, { new: true, session });
      if (!invoice) throw new ErrorHandler(409, 'This invoice was just changed by someone else. Refresh and try again.');

      const result = await cancelInvoicePackages(req.user, { ...invoice.toObject(), list: chosen.map(({ pkg }) => pkg) }, session);
      const round = (value) => Math.round(value * 100) / 100;
      const before = current.cancellation || {};
      const saved = {
        cancellation: {
          refundedUSD: round((before.refundedUSD || 0) + result.refundedUSD),
          refundedLYD: round((before.refundedLYD || 0) + result.refundedLYD),
          packages: [...(before.packages || []), ...result.packages],
        },
      };
      chosen.forEach(({ index }, k) => { saved[`list.${index}.refunds`] = result.packages[k]?.refunds || []; });
      await Invoices.updateOne({ _id: invoice._id }, { $set: saved }, { session });
      await emitOrdersByNumber(chosen.map(({ pkg }) => pkg.orderId), req.user, { session });
      return { result: { ...result, whole }, orderNumbers: chosen.map(({ pkg }) => pkg.orderId) };
    });
    res.status(200).json({ results: outcome.result });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getAllIssuedInvoices = async (req, res, next) => {
  try {
    const { date, from, to } = req.query;
    // Cancelled invoices were refunded, keep them out of the daily report
    let filter = { isCanceled: { $ne: true } };

    if (date) {
      // Filter by single date (start & end of that day)
      const selectedDate = new Date(date);
      const start = new Date(selectedDate.setHours(0, 0, 0, 0));
      const end = new Date(selectedDate.setHours(23, 59, 59, 999));
      filter.createdAt = { $gte: start, $lte: end };
    } else if (from && to) {
      // Filter by date range
      const start = new Date(new Date(from).setHours(0, 0, 0, 0));
      const end = new Date(new Date(to).setHours(23, 59, 59, 999));
      filter.createdAt = { $gte: start, $lte: end };
    }
    // else no filter, get all invoices

    const invoices = await Invoices.find(filter)
      .populate('customer')
      .sort({ createdAt: -1 });

    res.status(200).json({
      results: invoices,
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
};

module.exports.getClientOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  const orderedByList = convertObjDataFromStringToNumberType(req.query);
  try {
    let query = { orderId : String(id), user: req.user._id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id, user: req.user._id };
    }
    const order = await Orders.findOne(query, orderedByList);
    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
    order.images = order.images.filter(img => img.category === 'receipts');
    order.paymentList = order.paymentList.filter(package => package.settings.visableForClient);

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getRatings = async (req, res, next) => {
  try {
    const ordersRating = await OrderRating.find({}).populate(['user', 'order']).sort({ createdAt: -1 });

    res.status(200).json(ordersRating);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createRatingForOrder = async (req, res, next) => {
  const orderId = req.params.id;
  if (!orderId) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    const hasRaiting = await OrderRating.findOne({ order: orderId });
    if (!!hasRaiting) return next(new ErrorHandler(404, errorMessages.ORDER_HAS_RATING));

    const { questions } = req.body;
    const createdRating = await OrderRating.create({
      user: req.user,
      order: orderId,
      questions
    });

    res.status(200).json(createdRating);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getOrderRating = async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const orderRating = await OrderRating.findOne({ order: orderId });

    res.status(200).json(orderRating);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

// Lets a customer set a personal note (and a color to go with it) on their own
// order, purely as a reminder/memory aid for themselves, e.g. "gift for mom" so
// it's easy for them to recognize this order among their others at a glance.
// Admins/employees are not involved, this is separate from `orderNote`.
module.exports.updateOrderCustomization = async (req, res, next) => {
  const orderId = req.params.id;
  if (!orderId) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    const order = await Orders.findOne({ _id: orderId, user: req.user._id });
    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

    const { note, theme } = req.body;

    if (typeof note === 'string') {
      const trimmedNote = note.trim();
      if (trimmedNote.length > 600) return next(new ErrorHandler(400, errorMessages.ORDER_NOTE_TOO_LONG));
      order.customization.note = trimmedNote;
    }

    // Only change the color when the customer explicitly picks one. An empty or
    // omitted `theme` keeps whatever color the order already has instead of
    // resetting it, so editing just the note text never changes the color.
    if (theme) {
      if (!ORDER_THEME_IDS.includes(theme)) return next(new ErrorHandler(400, errorMessages.ORDER_THEME_INVALID));
      order.customization.theme = theme;
    } else if (!order.customization.theme) {
      order.customization.theme = ORDER_THEME_IDS[0];
    }

    await order.save();

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getPaymentsOfOrder = async (req, res, next) => {
  try {
    const id = req.params.id;
    const query = { order: id };
    if (req.query.category) {
      query.category = req.query.category;
    }
    const payments = await OrderPaymentHistory.find(query).sort({ createdAt: -1 }).populate(['order', 'createdBy', 'customer']);

    const updatedPaymentList = await Promise.all(payments.map(async (data) => {
      for (const d of data.list) {
        const inventory = await Inventory.findOne({ 'orders.paymentList._id': new ObjectId(d._id), inventoryType: 'inventoryGoods', shippingType: { $ne: 'domestic' } }).select(['-orders']).lean();
        if (inventory) {
          // If inventory is found, add the flight property to the payment data
          d.flight = inventory;
        }
      }
      // A delivery payment is cancelled with its invoice only, not from the order page
      const invoice = await deliveryInvoiceOf(data, data.order?.orderId);
      const result = data.toObject();
      if (invoice) result.deliveryInvoice = { _id: invoice._id, referenceId: invoice.referenceId };
      return result;
    }));

    res.status(200).json({
      results: updatedPaymentList
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.addPaymentToOrder = async (req, res, next) => {
  try {
    const id = req.params.id;
    const { receivedAmount, currency, createdAt, paymentType, customerId, category, list, rate } = req.body;
    const newList = typeof list === 'string' ? JSON.parse(list) : (list || []);
    if (paymentType !== 'cash') throw new ErrorHandler(400, 'Use the wallet payment action for wallet deductions');
    if (!['USD', 'LYD', 'EURO'].includes(currency) || !Number.isFinite(Number(receivedAmount)) || Math.round(Number(receivedAmount) * 100) <= 0 || typeof receivedAmount === 'boolean') throw new ErrorHandler(400, 'Enter a positive payment amount and valid currency');
    if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) throw new ErrorHandler(400, 'Invalid payment date');
    await assertOpenPeriod(req.user, createdAt);
    // Money in another currency counts at its own rate; without one it cannot be valued (owner's rule)
    if (currency && currency !== 'USD' && !(Number.isFinite(Number(rate)) && Number(rate) > 0)) {
      return next(new ErrorHandler(400, `Type the exchange rate for a payment in ${currency}.`));
    }

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-invoice-history");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }


    const outcome = await runInTransaction(async (session) => {
      await assertOpenPeriod(req.user, createdAt, { session });
      const order = await Orders.findById(id).session(session);
      if (!order || order.isCanceled || order.isDeleted) throw new ErrorHandler(400, 'Order is missing or canceled');
      if (customerId && String(customerId) !== String(order.user)) throw new ErrorHandler(400, 'Payment customer does not own this order');
      await Orders.updateOne({ _id: order._id }, { $inc: { accountingMutationVersion: 1 } }, { session });
      const data = {
        createdBy: req.user,
        customer: order.user,
        order: id,
        attachments: files,
        paymentType,
        receivedAmount: Math.round(Number(receivedAmount) * 100) / 100,
        rate: Number(rate) || 0,
        currency,
        createdAt,
      };

      if (category) {
        data.category = category;

        if (category === 'receivedGoods') {
          data.list = newList || [];

          // To Check received status for the selected packages
          // const ids = newList.map(data => new ObjectId(data._id));
          // for (const id of ids) {
          //   await Orders.updateOne(
          //     { "paymentList._id": id },
          //     { $set: { "paymentList.$.status.received": true, "paymentList.$.deliveredPackages.deliveredInfo.deliveredDate": new Date() } }
          //   );
          // }
        }
      }
      const [payment] = await OrderPaymentHistory.create([data], { session });
      if (payment.paymentType === 'cash') await emitAccountingEvent('cashPayment', payment._id, { office: req.body.office }, req.user, { session });

      return payment;
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.confirmInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;

    await Orders.findOneAndUpdate({ _id: id }, { $set: { invoiceConfirmed: true } });
    res.status(200).json({ success: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateOrderItems = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { items } = req.body;
    const totalInvoice = calculateTotalInvoice(items);

    await Orders.findOneAndUpdate({ _id: id }, {
      $set: {
        invoiceConfirmed: true,
        requestedEditDetails: {
          amount: totalInvoice,
          items,
          createdAt: new Date()
        }
      }
    });
    res.status(200).json({ success: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.confirmItemsChanges = async (req, res, next) => {
  try {
    const outcome = await runInTransaction(async (session) => {

      const { id } = req.params;
      const { status } = req.body;
      if (!['accepted', 'rejected'].includes(status)) throw new ErrorHandler(400, 'Invalid approval status');
      const order = await Orders.findOne({ _id: id }).session(session);
      if (!order) throw new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND);
      await assertOpenPeriod(req.user, order.createdAt, { session });
      const requestedEditDetails = order.requestedEditDetails;
      if (!requestedEditDetails?.items?.length) throw new ErrorHandler(400, 'No pending invoice change to approve');
      const newTotalInvoice = calculateTotalInvoice(requestedEditDetails.items);
      const oldTotalInvoice = calculateTotalInvoice(order.items);
      const update = {
        $set: {
          invoiceConfirmed: true,
          requestedEditDetails: null,
        },
        $push: {
          editedAmounts: {
            oldAmount: oldTotalInvoice,
            newAmount: newTotalInvoice,
            items: order.items,
            status,
            createdAt: new Date()
          }
        }
      }

      if (status === 'accepted') {
        update.$set.items = requestedEditDetails.items;
        update.$set.totalInvoice = newTotalInvoice;
      }

      await Orders.findOneAndUpdate({ _id: id }, update, { session });
      if (status === 'accepted') await emitAccountingEvent('order', id, {}, req.user, { session });
      return { success: true };
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getMonthReport = async (req, res, next) => {
  try {
    const { date, fetchType, skip, limit } = req.query;
    const formattedDate = new Date(date);
    const year = formattedDate.getFullYear();
    const month = formattedDate.getMonth() + 1;

    let cursor;

    // Define the skip and limit values, defaulting to null if not provided
    const skipValue = skip ? parseInt(skip) : 0;
    const limitValue = limit ? parseInt(limit) : 0; // You can decide to set a default like 100 if needed

    if (fetchType === 'receivedGoods') {
      cursor = Orders.aggregate([
        { $unwind: '$paymentList' },
        {
          $match: {
            isCanceled: false,
            unsureOrder: false,
            'paymentList.deliveredPackages.deliveredInfo.deliveredDate': { $exists: true },
            $expr: {
              $and: [
                { $eq: [{ $year: '$paymentList.deliveredPackages.deliveredInfo.deliveredDate' }, year] },
                { $eq: [{ $month: '$paymentList.deliveredPackages.deliveredInfo.deliveredDate' }, month] }
              ]
            }
          }
        },
        { $sort: { 'paymentList.deliveredPackages.deliveredInfo.deliveredDate': -1 } },
        ...(skipValue ? [{ $skip: skipValue }] : []),  // Skip logic
        ...(limitValue ? [{ $limit: limitValue }] : []) // Limit logic
      ]).cursor();

    } else if (fetchType === 'invoices') {
      cursor = Orders.aggregate([
        {
          $match: {
            isCanceled: false,
            unsureOrder: false,
            isPayment: true,
            $expr: {
              $and: [
                { $eq: [{ $year: '$createdAt' }, year] },
                { $eq: [{ $month: '$createdAt' }, month] }
              ]
            }
          }
        },
        { $sort: { createdAt: -1 } },
        ...(skipValue ? [{ $skip: skipValue }] : []),
        ...(limitValue ? [{ $limit: limitValue }] : [])
      ]).cursor();

    } else if (fetchType === 'paidDebts') {
      cursor = Balances.aggregate([
        { $unwind: '$paymentHistory' },
        {
          $match: {
            $expr: {
              $and: [
                { $eq: [{ $year: '$paymentHistory.createdAt' }, year] },
                { $eq: [{ $month: '$paymentHistory.createdAt' }, month] }
              ]
            }
          }
        },
        { $sort: { 'paymentHistory.createdAt': -1 } },
        ...(skipValue ? [{ $skip: skipValue }] : []),
        ...(limitValue ? [{ $limit: limitValue }] : [])
      ]).cursor();

    } else if (fetchType === 'paymentHistory') {
      cursor = OrderPaymentHistory.aggregate([
        {
          $match: {
            $expr: {
              $and: [
                { $eq: [{ $year: '$createdAt' }, year] },
                { $eq: [{ $month: '$createdAt' }, month] }
              ]
            }
          }
        },
        { $sort: { createdAt: -1 } },
        { $project: { _id: 1, category: 1, currency: 1, receivedAmount: 1 } },
        ...(skipValue ? [{ $skip: skipValue }] : []),
        ...(limitValue ? [{ $limit: limitValue }] : [])
      ]).cursor();
    } else if (fetchType === 'inventory') {
      cursor = Inventory.aggregate([
        {
          $match: {
            inventoryType: 'inventoryGoods',
            shippingType: { $ne: 'domestic' },
            'inventoryFinishedDate': { $exists: true },
            $expr: {
              $and: [
                { $eq: [{ $year: '$inventoryFinishedDate' }, year] },
                { $eq: [{ $month: '$inventoryFinishedDate' }, month] }
              ]
            }
          }
        },
        { $sort: { 'shippingType': -1 } },
        ...(skipValue ? [{ $skip: skipValue }] : []),
        ...(limitValue ? [{ $limit: limitValue }] : [])
      ]).cursor();
    }


    let data = [];
    await cursor.forEach(doc => {
      data.push(doc);
    });

    // Populate references if needed
    if (fetchType === 'receivedGoods') {
      data = await Orders.populate(data, [{ path: "madeBy" }, { path: "user" }]);
    } else if (fetchType === 'invoices') {
      data = await Orders.populate(data, [{ path: "madeBy" }, { path: "user" }]);
    } else if (fetchType === 'paidDebts') {
      data = await Balances.populate(data, [{ path: "owner" }]);
    } else if (fetchType === 'paymentHistory') {
      data = await OrderPaymentHistory.populate(data, [{ path: "customer" }]);
    } else if (fetchType === 'inventory') {
      data = await Inventory.populate(data, [{ path: "createdBy" }]);
    }

    res.status(200).json({ success: true, results: data });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
};

module.exports.odoReport = async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;

    // Date range filtering logic
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    } else if (startDate) {
      const start = new Date(startDate);
      const end = new Date(startDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.createdAt = { $gte: start, $lte: end };
    }

    let data = [];
    switch (type) {
      case 'invoices':
        data = await getInvoicesQuery(dateFilter);
        break;
      case 'purchaseItems':
        data = await getPurchaseItemsByDate(startDate, endDate);
        break;
      case 'payments':
        // data = await getPaymentsQuery(dateFilter);
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid export type specified.' });
    }

    return res.status(200).json({
      success: true,
      type,
      count: data.length,
      results: data,
    });
  } catch (error) {
    console.error('Export Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const calculateTotalInvoice = (items) => {
  let total = 0;
  items.forEach(item => {
    const amount = item.unitPrice * item.quantity;
    total += amount;
  })
  return total;
}
