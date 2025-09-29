const Orders = require('../models/order');
const Activities = require('../models/activities');
const orderid = require('order-id')('key');
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require('../constants/errorTypes');
const Offices = require('../models/office');
const { addChangedField, getTapTypeQuery, convertObjDataFromStringToNumberType } = require('../middleware/helper');
const { orderLabels } = require('../constants/orderLabels');
const mongoose = require('mongoose');
const mongodb = require('mongodb');
const Users = require('../models/user');
const OrderRating = require('../models/orderRating');
const Inventory = require('../models/inventory');
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const Balances = require('../models/balance');
const Invoices = require('../models/invoice');
const { cleanUpInventory, createInvoice, updateOrderStatuses, useWalletBalance, processPackagesPayment, checkSufficientFunds, truncateToTwo, getUserWalletMap, validatePayment, validatePackages   } = require('../utils/helperApi');

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
    orders = await Orders.populate(orders, [{ path: "madeBy" }, { path: "user" }]);

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
    const { limit, skip, tabType } = req.query;
    const { id } = req.params;
    
    const tabTypeQuery = getTapTypeQuery(tabType);
    tabTypeQuery.isCanceled = false;
    let orders;
    if (tabType === 'readyForPickup') {
      orders = await Orders.aggregate([
        { $match: { ...tabTypeQuery, user: new ObjectId(id) } },
        {
          $project: {
            // Include all fields
            _id: 1,
            user: 1,
            madeBy: 1,
            orderId: 1,
            customerInfo: 1,
            receivedUSD: 1,
            receivedLYD: 1,
            receivedShipmentLYD: 1,
            receivedShipmentUSD: 1,
            paymentExistNote: 1,
            placedAt: 1,
            totalInvoice: 1,
            invoiceConfirmed: 1,
            requestedEditDetails: 1,
            editedAmounts: 1,
            shipment: 1,
            productName: 1,
            quantity: 1,
            isShipment: 1,
            isPayment: 1,
            unsureOrder: 1,
            hasRemainingPayment: 1,
            hasProblem: 1,
            orderStatus: 1,
            isFinished: 1,
            activity: 1,
            netIncome: 1,
            orderNote: 1,
            isCanceled: 1,
            cancelation: 1,
            images: 1,
            debt: 1,
            credit: 1,
            items: 1,

            // Filter the paymentList array
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
        }
      ]);
    } else {
      orders = await Orders.find({ ...tabTypeQuery, user: id }).populate('user').sort({ createdAt: -1 }).skip(skip).limit(limit);
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
    const orders = await Orders.find(tabTypeQuery).populate('user').sort({ createdAt: -1 }).skip(skip).limit(limit);
    
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

module.exports.getOrdersTab = async (req, res, next) => {
  try {
    const { limit, skip, tabType } = req.query;

    const tabTypeQuery = getTapTypeQuery(tabType);
    tabTypeQuery.isCanceled = false;
    const orders = await Orders.find(tabTypeQuery).populate('user').sort({ createdAt: -1 }).skip(skip).limit(limit);
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
    { $unwind: "$user" }
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
    const { fullName, email, customerId, phone, fromWhere, toWhere, method, exiosShipmentPrice, originShipmentPrice, weight, packageCount, netIncome, currency, creditCurrency, debt, credit, containerNumber, receiptNo } = req.body;
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

    const items = JSON.parse(req.body.items);
    const totalInvoice = calculateTotalInvoice(items);

    const paymentList = JSON.parse(req.body.paymentList).map(data => ({
      link: data.paymentLink,
      status: {
        arrived: data.arrived,
        arrivedLibya: data.arrivedLibya,
        paid: data.paid,
        received: data.received
      },
      deliveredPackages: {
        weight: {
          total: data.deliveredPackages?.weight,
          measureUnit: data.deliveredPackages?.measureUnit
        },
        trackingNumber: data.deliveredPackages?.trackingNumber,
        originPrice: data.deliveredPackages.originPrice,
        exiosPrice: data.deliveredPackages.exiosPrice,
        receivedShipmentUSD: data.deliveredPackages.receivedShipmentUSD,
        receivedShipmentLYD: data.deliveredPackages.receivedShipmentLYD,
        containerInfo: {
          billOfLading: data.deliveredPackages?.containerInfo?.billOfLading
        },
        shipmentMethod: data.deliveredPackages.shipmentMethod,
        receiptNo: data.deliveredPackages.receiptNo
      },
      note: data.note,
    }))

    const order = await Orders.create({
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
    });

    await Activities.create({
      user: req.user,
      details: {
        path: '/invoices',
        status: 'added',
        type: 'order',
        actionId: order._id
      }
    })

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
      }, {
        new: true
      });
    }

    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
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
    let query = { orderId : String(id) };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { _id: id };
    }

    const updateQuery = {
      isCanceled: true,
      cancelation: {
        reason: req.body.cancelationReason
      }
    }

    const order = await Orders.findOneAndUpdate(query, updateQuery, { new: true }).populate('madeBy');

    if (!order) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
    
    res.status(200).json(order);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateOrder = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    let user;
    if (!!req.body.customerId) {
      user = await Users.findOne({ customerId: req.body.customerId });
      if (!user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));
    }

    const oldOrder = await Orders.findOne({ _id: String(id) });

    if (req.body.credit && req.body.credit.creditCurrency) {
      req.body.credit.currency = req.body.credit.creditCurrency;
    }
    
    let update = {
      ...req.body,
      customerInfo: {
        ...oldOrder.customerInfo,
        ...req.body.customerInfo
      },
      shipment: {
        ...oldOrder.shipment,
        ...req.body.shipment
      },
      debt: {
        ...oldOrder.debt,
        ...req.body.debt
      },
      credit: {
        ...oldOrder.credit,
        ...req.body.credit
      }
    }

    if (user) update.user = user;
    const newOrder = await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true }).populate('user');
    if (!newOrder) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

    // calculate the revenue of the order
    const dollarDifference =  newOrder.receivedUSD - oldOrder.receivedUSD;
    const dinnarDifference =  newOrder.receivedLYD - oldOrder.receivedLYD;

    const dinnarShipmentDifference =  newOrder.receivedShipmentLYD - oldOrder.receivedShipmentLYD;
    const dollarShipmentDifference =  newOrder.receivedShipmentUSD - oldOrder.receivedShipmentUSD;

    let totalIncreaseOfDollar = dollarDifference + dollarShipmentDifference;
    let totalIncreaseOfDinnar = dinnarDifference + dinnarShipmentDifference;

    // calculate received shipment for each package
    for (let i = 0; i < newOrder.paymentList?.length; i++) {
      totalIncreaseOfDollar += (newOrder.paymentList[i]?.deliveredPackages?.receivedShipmentUSD - (oldOrder.paymentList[i]?.deliveredPackages?.receivedShipmentUSD || 0)) || 0;
      totalIncreaseOfDinnar += (newOrder.paymentList[i]?.deliveredPackages?.receivedShipmentLYD - (oldOrder.paymentList[i]?.deliveredPackages?.receivedShipmentLYD || 0)) || 0;
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
      }, {
        new: true
      });
    }

    // Remove received goods from the warehouse
    if (req.body?.paymentList?.length > 0) {
      // Filter delivered goods and update the deliveredDate
      const receivedOrders = req.body.paymentList.filter(orderPackage => orderPackage.status.received);      
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
        
      update.paymentList = req.body.paymentList.map(orderPackage => {
        const newPackage = orderPackage.status.received && !!orderPackage?.index;
        const isOrderReceived = ordersHasReceviedNow.find(id => new ObjectId(id).equals(orderPackage._id));
        
        if (isOrderReceived || newPackage) {
          return ({ ...orderPackage, deliveredPackages: { ...orderPackage.deliveredPackages, deliveredInfo: { deliveredDate: new Date() } } });
        }
        return orderPackage;
      });

      await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true });

      await Inventory.updateMany(
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
        },
        { safe: true, upsert: true, new: true }
      )
    }

    // add activity to the order
    const changedFields = [];
    if (Object.keys(req.body).length > 3) {
      for (const fieldName in req.body) {
        if (!(fieldName === 'isPayment' || fieldName === 'orderStatus' || fieldName === 'isFinished' || fieldName === 'isShipment' || fieldName === 'shipment' || fieldName === 'customerInfo' || fieldName === 'netIncome' || fieldName === 'unsureOrder')) {
          changedFields.push(addChangedField(fieldName, newOrder[fieldName], oldOrder[fieldName], orderLabels));
        }
      }
    }
    await Activities.create({
      user: req.user,
      details: {
        path: '/invoices',
        status: 'updated',
        type: 'order',
        actionId: newOrder._id
      },
      changedFields
    });
    res.status(200).json(newOrder);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateSinglePackage = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

  try {
    let user;
    if (!!req.body.customerId) {
      user = await Users.findOne({ customerId: req.body.customerId });
      if (!user) return next(new ErrorHandler(400, errorMessages.USER_NOT_FOUND));
    }

    let oldOrder = await Orders.findOne({ _id: String(id) });
    const index = oldOrder.paymentList.findIndex(orderPackage => new ObjectId(req.body.paymentList._id).equals(new ObjectId(orderPackage._id)));
    if (index !== -1) {
      oldOrder.paymentList[index] = req.body.paymentList;
    }
    const update = {
      ...req.body,
      paymentList: oldOrder.paymentList
    }

    if (user) update.user = user;
    const newOrder = await Orders.findOneAndUpdate({ _id: String(id) }, update, { new: true });
    if (!newOrder) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));

    res.status(200).json(newOrder);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
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

module.exports.updateStatusOfOrder = async (req, res, next) => {
  try {
    const { statusType, data, value, inventoryId } = req.body;
    if (!statusType) next(new ErrorHandler(404, errorMessages.ORDER_STATUS_NOT_FOUND));

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
      {
        arrayFilters: [
          { 'elem.deliveredPackages.trackingNumber': { $in: orders.map(order => order?.trackingNumber) } },
        ],
        multi: true,
        new: true
      }
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
      {
        multi: true,
        new: true
      }
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
    }, { new: true });

    res.status(200).json(response);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
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
    const { selectedPackages, payment, totalCost } = req.body;
    
    validatePackages(selectedPackages);
    validatePayment(payment);

    const walletMap = await getUserWalletMap(id);

    checkSufficientFunds(walletMap, payment, totalCost);

    await processPackagesPayment(req, res, next, id, selectedPackages, payment);

    await updateOrderStatuses(selectedPackages);

    await createInvoice(req.user, id, selectedPackages, payment, totalCost);

    await cleanUpInventory(selectedPackages);

    return res.status(200).json({ done: new Date() });

  } catch (error) {
    console.error(error);
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.getInvoicesByCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const invoices = await Invoices.find({ customer: id }).populate('customer').sort({ createdAt: -1 });

    res.status(200).json({
      results: invoices
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getAllIssuedInvoices = async (req, res, next) => {
  try {
    const { date, from, to } = req.query;
    let filter = {};

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
      return data; // Return the updated payment data
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
    const newList = JSON.parse(list);

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

    const data = {
      createdBy: req.user,
      customer: customerId,
      order: id,
      attachments: files,
      paymentType,
      receivedAmount,
      rate: Number(rate),
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
    const payment = await OrderPaymentHistory.create(data);

    res.status(200).json(payment);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
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
    const { id } = req.params;
    const { requestedEditDetails, status } = req.body;
    const order = await Orders.findOne({ _id: id });
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

    await Orders.findOneAndUpdate({ _id: id }, update);
    res.status(200).json({ success: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
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

const calculateTotalInvoice = (items) => {
  let total = 0;
  items.forEach(item => {
    const amount = item.unitPrice * item.quantity;
    total += amount;
  })
  return total;
}
