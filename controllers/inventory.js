const Inventory = require("../models/inventory");
const Orders = require("../models/order");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const mongodb = require('mongodb');
const { ObjectId } = mongodb;

module.exports.getInventory = async (req, res, next) => {
  try {
    const inventory = await Inventory.find({}).populate(['createdBy', 'orders']);
    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createInventory = async (req, res, next) => {
  try {
    const { inventoryFinishedDate, voyage, voyageAmount, voyageCurrency, shippedCountry, inventoryPlace, inventoryType } = req.body;
    await Inventory.deleteMany({})
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
      inventoryType
    })

    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getSingleInventory = async (req, res, next) => {
  try {
    const inventory = await Inventory.findOne({ _id: req.params.id }).populate([{
      path: 'orders',
      select: 'status', // Specify the fields you want to include
    }]);
    // let inventory = await Inventory.aggregate([
    //   { $match: { _id: ObjectId(req.params.id) } }, // Match the desired inventory document
    //   {
    //     $unwind: {
    //       path: '$orders.order.paymentList',
    //       preserveNullAndEmptyArrays: true,
    //     },
    //   },
    // ]);

    // inventory = await Inventory.populate(inventory, [{ path: "createdBy" }, { path: "orders.order" }]);
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    
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
                { 'user.customerId': { $regex: new RegExp(searchValue.toLowerCase(), 'i') } }
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
    const { body, query } = req;
    const orders = body

    const inventory = await Inventory.findOneAndUpdate(
      { _id: req.query.id },
      {
        $push: { "orders": orders },
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

module.exports.removeOrdersFromInventory = async (req, res, next) => {
  try {
    const { body } = req;
    const orders = body;

    const inventory = await Inventory.findOneAndUpdate(
      { _id: req.query.id },
      {
        $pullAll: { "orders": orders },
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
