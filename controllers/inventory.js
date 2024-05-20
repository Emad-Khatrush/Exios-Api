const Inventory = require("../models/inventory");
const Orders = require("../models/order");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const mongodb = require('mongodb');
const Activities = require("../models/activities");
const ReturnedPayments = require("../models/returnedPayments");
const Users = require("../models/user");

const { ObjectId } = mongodb;

module.exports.getInventory = async (req, res, next) => {
  try {
    const { limit, skip, searchValue, searchType } = req.query;

    let query = [
      {
        $match: {
          inventoryType: 'inventoryGoods',
          status: { $ne: 'finished' }
        }
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
    ];
    if (searchType && searchType !== 'all') {
      if (searchType === 'finished') {
        query[0].$match.status = searchType;
      } else {
        query[0]['$match']['shippingType'] = searchType;
        query[0]['$match']['status'] = { $ne: 'finished' };
      }
    }
    if (searchValue) {
      query = [
        {
          $match: {
            inventoryType: 'inventoryGoods',
            $or: [
              { 'voyage': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { 'shippingType': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { 'inventoryPlace': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { 'shippedCountry': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { '_id': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { 'orders.orderId': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              { 'orders.paymentList.deliveredPackages.trackingNumber': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
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

    let inventory = await Inventory.aggregate(query);
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    inventory = await Inventory.populate(inventory, [{ path: "createdBy" }, { path: "orders" }]);

    let counts = { all: inventory?.length };
    if (!searchValue) {
      counts = (await Inventory.aggregate([
        { $match: { inventoryType: 'inventoryGoods' } },
        {
          $group: {
            _id: null,
            all: {
              $sum: {
                $cond: [
                  { $ne: ["$status", 'finished'] },
                  1,
                  0
                ]
              }
            },
            air: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$status", 'finished'] }, { $eq: ["$shippingType", 'air'] }] },
                  1,
                  0
                ]
              }
            },
            sea: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$status", 'finished'] }, { $eq: ["$shippingType", 'sea'] }] },
                  1,
                  0
                ]
              }
            },
            domestic: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ["$status", 'finished'] }, { $eq: ["$shippingType", 'domestic'] }] },
                  1,
                  0
                ]
              }
            },
            finished: {
              $sum: {
                $cond: [
                  { $eq: ["$status", 'finished'] },
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
    }

    // Extract order IDs from each inventory item
    const orderIds = inventory.map(item => item.orders.map(order => order._id));

    // Flatten the array of arrays of order IDs
    const flattenedOrderIds = orderIds.flat();

    // Perform aggregation to get orders using the extracted order IDs
    const orders = await Orders.aggregate([
        { 
          $unwind: {
            path: '$paymentList', 
            preserveNullAndEmptyArrays: true
          }
        },
        { $match: { _id: { $in: flattenedOrderIds } } }
    ]);

    // Create a map of order IDs to orders for efficient lookup
    const orderMap = orders.reduce((acc, order) => {
        acc[order._id.toString()] = order;
        return acc;
    }, {});

    // Replace inventory.orders with corresponding orders
    const updatedInventory = inventory.map(item => ({
        ...item,
        orders: item.orders.map(order => orderMap[order._id.toString()])
    }));
    res.status(200).json({
      results: updatedInventory,
      total: 0,
      countList: counts,
      limit,
      skip
    });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createInventory = async (req, res, next) => {
  try {
    const { inventoryFinishedDate, voyage, voyageAmount, voyageCurrency, shippedCountry, inventoryPlace, inventoryType, shippingType, note } = req.body;
    const attachments = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-inventory");
        attachments.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    const inventory = await Inventory.create({
      createdBy: req.user,
      attachments,
      inventoryFinishedDate,
      voyageAmount,
      voyage,
      shippedCountry,
      inventoryPlace,
      voyageCurrency,
      inventoryType,
      shippingType,
      note
    })

    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getSingleInventory = async (req, res, next) => {
  try {
    const inventory = await Inventory.findOne({ _id: req.params.id }).populate(['orders']);
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    const ids = inventory.orders.map(order => ObjectId(order.paymentList?._id));

    let orders = await Orders.aggregate([
      {
        $unwind: {
          path: '$paymentList', 
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          'paymentList._id': { $in: ids }
        }
      },
      {
        $sort: {
          orderId: -1
        }
      }
    ]);
    orders = await Orders.populate(orders, [{ path: "madeBy" }, { path: "user" }, { path: "orders" }]);

    inventory.orders = orders;

    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getInventoryOrders = async (req, res, next) => {
  try {
    const { searchValue, inventoryId } = req.query;
    if (!searchValue) return res.status(200).json([]);

    const inventory = await Inventory.findOne({ _id: inventoryId });
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    const ids = inventory.orders.map(order => order.paymentList?._id);

    const orders = await Orders.aggregate([
      {
        $unwind: {
          path: '$paymentList', 
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          $and: [
            {
              'paymentList._id': { $nin: ids }
            },
            {
              $or: [
                { orderId: { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
                { 'paymentList.deliveredPackages.trackingNumber': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
                { 'customerInfo.fullName': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
                { 'user.customerId': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } },
                { 'paymentList.deliveredPackages.receiptNo': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
                { 'paymentList.deliveredPackages.locationPlace': { $regex: new RegExp(searchValue.trim().toLowerCase(), 'i') } },
              ]
            }
          ]
        }
      },
      {
        $sort: {
          orderId: -1
        }
      }
    ]);
    if (!orders) return next(new ErrorHandler(404, errorMessages.ORDER_NOT_FOUND));
    
    res.status(200).json(orders);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.addOrdersToTheInventory = async (req, res, next) => {
  try {
    const paymentListIds = req.body.map(order => ObjectId(order?.paymentList?._id));
    const orders = await Orders.aggregate([
      {
        $unwind: '$paymentList'
      },
      {
        $match: {
          'paymentList._id': { $in: paymentListIds }
        }
      }
    ])

    const inventory = await Inventory.findOneAndUpdate(
      { _id: req.query.id },
      {
        $push: { 
          "orders": { 
            $each: orders.map(orderArray => orderArray)
          }
        },
      },
      { safe: true, upsert: true, new: true }
    )
    .populate(['createdBy', 'orders'])

    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    const ids = inventory.orders.map(order => ObjectId(order.paymentList?._id));
    
    let updatedOrders = await Orders.aggregate([
      {
        $unwind: {
          path: '$paymentList', 
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          'paymentList._id': { $in: ids }
        }
      },
      {
        $sort: {
          orderId: -1
        }
      }
    ]);
    updatedOrders = await Orders.populate(updatedOrders, [{ path: "madeBy" }, { path: "user" }, { path: "orders" }]);

    inventory.orders = updatedOrders;

    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.removeOrdersFromInventory = async (req, res, next) => {
  try {
    const { body } = req;
    const paymentList = body;

    const inventory = await Inventory.findOneAndUpdate(
      { _id: req.query.id },
      {
        $pull: { 
          orders: { 
            $or: [
              { "paymentList._id": { $in: paymentList.map(id => id) } },
              { "paymentList._id": { $in: paymentList.map(id => ObjectId(id)) } }
            ]
          } 
        }
      },
      { safe: true, upsert: true, new: true }
    )
    .populate(['createdBy', 'orders'])
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    
    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.uploadFiles= async (req, res, next) => {
  const { id } = req.body;

  const images = [];
  const changedFields = [];

  if (req.files) {
    for (let i = 0; i < req.files.length; i++) {
      const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-inventory");
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
  
  const inventory = await Inventory.findByIdAndUpdate(id, {
    $push: { "attachments": images },
  }, { safe: true, upsert: true });
  
  await Activities.create({
    user: req.user,
    details: {
      path: '/inventory',
      status: 'added',
      type: 'inventory',
      actionName: 'image',
      actionId: inventory._id
    },
    changedFields
  })
  res.status(200).json(inventory)
}

module.exports.getWarehouseInventory = async (req, res, next) => {
  try {
    const { office } = req.params;
    const inventory = await Inventory.find({ inventoryType: 'warehouseInventory', inventoryPlace: office }).sort({ createdAt: -1 }).populate(['createdBy', 'orders']);
    if (inventory.length === 0) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const ids = (inventory[0].orders || []).map(order => ObjectId(order.paymentList?._id));

    let orders = await Orders.aggregate([
      {
        $unwind: {
          path: '$paymentList', 
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          'paymentList._id': { $in: ids }
        }
      },
      {
        $sort: {
          orderId: -1
        }
      }
    ]);
    orders = await Orders.populate(orders, [{ path: "madeBy" }, { path: "user" }]);
    inventory[0].orders = orders;
    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateInventory = async (req, res, next) => {
  try {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const updatedInventory = await Inventory.updateOne({ _id: id }, { ...req.body }, { new: true });

    res.status(200).json(updatedInventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

// Returned Payments functions
module.exports.getReturnedPayments = async (req, res, next) => {
  try {
    const returnedPayments = await ReturnedPayments.find({ status: req.query.status || 'active' }).sort({ createdAt: -1 }).populate(['createdBy', 'customer']);
    if (!returnedPayments) return next(new ErrorHandler(404, errorMessages.RETURNED_PAYMENTS_NOT_FOUND));

    res.status(200).json(returnedPayments);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateReturnedPayment = async (req, res, next) => {
  try {
    const returnedPayments = await ReturnedPayments.updateOne({ _id: req.body._id }, { ...req.body }, { new: true });
    if (!returnedPayments) return next(new ErrorHandler(404, errorMessages.RETURNED_PAYMENTS_NOT_FOUND));

    res.status(200).json(returnedPayments);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createReturnedPayment = async (req, res, next) => {
  try {
    const { customerId, amount, currency, shippingCompanyName, deliveryTo, issuedOffice, goodsSentDate, shippingType, note, orders } = req.body;
    const attachments = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-returned-payments");
        attachments.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }
    const parsedOrders = JSON.parse(orders);

    const customer = await Users.findOne({ customerId });
    if (!customer) return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));

    const returnedPayment = await ReturnedPayments.create({
      createdBy: req.user,
      attachments,
      customer,
      amount,
      currency,
      deliveryTo,
      issuedOffice,
      goodsSentDate,
      shippingType,
      note,
      orders: parsedOrders,
      shippingCompanyName
    })

    res.status(200).json(returnedPayment);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}
