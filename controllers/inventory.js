const Inventory = require("../models/inventory");
const Orders = require("../models/order");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const mongodb = require('mongodb');
const Activities = require("../models/activities");
const ReturnedPayments = require("../models/returnedPayments");
const Users = require("../models/user");
const PackageDeletion = require("../models/packageDeletion");
const WarehouseCheck = require("../models/warehouseCheck");

const { ObjectId } = mongodb;

module.exports.getInventory = async (req, res, next) => {
  try {
    const { limit, skip, searchValue, searchType } = req.query;

    // Base query pipeline
    let query = [
      {
        $match: {
          inventoryType: 'inventoryGoods',
          status: { $ne: 'finished' }
        }
      },
      {
        $sort: { createdAt: -1 } // Sort by creation date in descending order
      },
      {
        $skip: Number(skip) || 0 // Skip documents for pagination
      },
      {
        $limit: Number(limit) || 10 // Limit the number of results (default to 20 if not provided)
      }
    ];

    // Adjust query based on searchType
    if (searchType && searchType !== 'all') {
      if (searchType === 'finished') {
        query[0].$match.status = searchType;
      } else {
        query[0]['$match']['shippingType'] = searchType;
        query[0]['$match']['status'] = { $ne: 'finished' };
      }
    }

    // Handle searchValue with text search
    if (searchValue) {
      query = [
        {
          $match: {
            inventoryType: 'inventoryGoods',
            $text: { $search: searchValue.trim().toLowerCase() } // Use text index for faster search
          }
        },
        {
          $sort: { createdAt: -1 }
        },
        {
          $skip: Number(skip) || 0
        },
        {
          $limit: Number(limit) || 20
        }
      ];
    }

    // Aggregation pipeline
    const inventoryPipeline = [...query];

    // Add $lookup stages for populating createdBy and orders
    inventoryPipeline.push(
      {
        $lookup: {
          from: "users", // Replace with the actual collection name for createdBy
          localField: "createdBy",
          foreignField: "_id",
          as: "createdBy",
          pipeline: [
            { $project: { username: 1, email: 1 } } // Fetch only necessary fields
          ]
        }
      },
      {
        $unwind: "$createdBy" // Flatten the array created by $lookup
      },
      {
        $lookup: {
          from: "orders", // Replace with the actual collection name for orders
          localField: "orders",
          foreignField: "_id",
          as: "orders",
          pipeline: [
            { $project: { orderId: 1, paymentList: 1 } } // Fetch only necessary fields
          ]
        }
      }
    );

    // Execute the aggregation query
    let inventory = await Inventory.aggregate(inventoryPipeline);

    // If no inventory found, return an error
    if (!inventory) {
      return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    }

    // Count aggregation pipeline
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

    // Return the response
    res.status(200).json({
      results: inventory,
      total: counts.all,
      countList: counts,
      limit: Number(limit),
      skip: Number(skip)
    });
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.getInventoriesNotFinishCalculation = async (req, res, next) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 10;
    const shippingType = req.query.shippingType;

    const query = {
      $or: [
        { isCaclulationDone: { $exists: false } },
        { isCaclulationDone: false },
        { isCaclulationDone: null }
      ],
      inventoryType: 'inventoryGoods',
      shippingType: shippingType || { $ne: 'domestic' }
    };

    const inventories = await Inventory.find(query)
      .populate('createdBy')
      .sort({ createdAt: -1 }) // newest first
      .skip(skip)
      .limit(limit);

    res.status(200).json({ results: inventories });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
};

module.exports.createInventory = async (req, res, next) => {
  try {
    const { inventoryFinishedDate, arrivalDate, voyage, voyageAmount, voyageCurrency, shippedCountry, inventoryPlace, inventoryType, shippingType, note, costPrice, odoReferenceCode } = req.body;
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

    let odoCode = odoReferenceCode;
    if (!odoCode && shippedCountry === 'UAE') {
      if (shippingType === 'air') odoCode = 242;
      else if (shippingType === 'sea') odoCode = 243;
    }

    const inventory = await Inventory.create({
      createdBy: req.user,
      attachments,
      inventoryFinishedDate,
      arrivalDate: arrivalDate || undefined,
      voyageAmount,
      voyage,
      shippedCountry,
      inventoryPlace,
      voyageCurrency,
      inventoryType,
      shippingType,
      note,
      costPrice,
      odoReferenceCode: odoCode
    })

    res.status(200).json(inventory);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getSingleInventory = async (req, res, next) => {
  try {
    const inventory = await Inventory.findOne({ _id: req.params.id }).select('-orders');
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const ordersIds = await Inventory.findById(req.params.id)
    .select("orders.paymentList._id")
    .lean();
    
    const ids = (ordersIds?.orders || [])
      .map(o => o?.paymentList?._id)
      .filter(Boolean)
      .map(id => new ObjectId(id));
    
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

// Admin only (see routes/inventory.js) - permanently removes the inventory
// record itself. The orders grouped under it live in the separate Orders
// collection and are untouched, they just stop showing up under this voyage.
module.exports.deleteInventory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const inventory = await Inventory.findByIdAndDelete(id);
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    res.status(200).json({ message: 'Inventory deleted successfully' });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.addExpenseToInventory = async (req, res, next) => {
  try {
    const { inventoryId } = req.params; // e.g. /inventory/:inventoryId/expenses
    const { description, amount, currency, rate, date } = req.body;

    // 1️⃣ Find the inventory document
    const inventory = await Inventory.findById(inventoryId);
    if (!inventory) {
      return res.status(404).json({ message: 'Inventory not found' });
    }

    // 2️⃣ Create the expense object
    const expense = {
      description,
      amount,
      currency,
      rate: rate || 0,
      date: date || new Date()
    };

    // 3️⃣ Push the expense to the expenses array
    inventory.expenses.push(expense);

    // 4️⃣ Save the document
    await inventory.save();

    // 5️⃣ Return updated inventory or expenses list
    res.status(200).json({
      message: 'Expense added successfully',
      expenses: inventory.expenses
    });

  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.deleteExpenseOfInventory = async (req, res, next) => {
  try {
    const { inventoryId } = req.params;  // from URL
    const { expenseId } = req.body;      // from request body

    // 1. Find inventory by ID
    const inventory = await Inventory.findById(inventoryId);
    if (!inventory) {
      return next(new ErrorHandler(404, 'Inventory not found'));
    }

    // 2. Remove expense from expenses array
    const initialLength = inventory.expenses.length;
    inventory.expenses = inventory.expenses.filter(exp => exp._id.toString() !== expenseId);

    if (inventory.expenses.length === initialLength) {
      return next(new ErrorHandler(404, 'Expense not found in this inventory'));
    }

    // 3. Save updated inventory
    await inventory.save();

    // 4. Return updated expenses list
    res.status(200).json({
      message: 'Expense deleted successfully',
      expenses: inventory.expenses
    });

  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

module.exports.updateExpenseOfInventory = async (req, res, next) => {
  try {
    const { inventoryId } = req.params; // from URL, e.g. /inventory/:inventoryId/expenses
    const { editingId, description, amount, currency, date, rate } = req.body;

    if (!editingId) {
      return next(new ErrorHandler(400, 'editingId (expense id) is required'));
    }

    // Find the inventory by id
    const inventory = await Inventory.findById(inventoryId);
    if (!inventory) {
      return next(new ErrorHandler(404, 'Inventory not found'));
    }

    // Find the expense by editingId inside expenses array
    const expenseIndex = inventory.expenses.findIndex(exp => exp._id.toString() === editingId);
    if (expenseIndex === -1) {
      return next(new ErrorHandler(404, 'Expense not found'));
    }

    // Update the expense fields
    inventory.expenses[expenseIndex] = {
      ...inventory.expenses[expenseIndex]._doc, // preserve other fields
      description,
      amount,
      currency,
      date,
      rate
    };

    // Save updated inventory
    await inventory.save();

    res.status(200).json({
      message: 'Expense updated successfully',
      expense: inventory.expenses[expenseIndex]
    });

  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

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
    const paymentListIds = req.body.map(order => new ObjectId(order?.paymentList?._id));
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

    // ?office=tripoli|benghazi targets that office's warehouse, resolved the
    // same way getWarehouseInventory does (newest one), instead of callers
    // hardcoding an inventory id that breaks when the warehouse is recreated.
    let inventoryId = req.query.id;
    if (req.query.office) {
      const warehouse = await Inventory.findOne({ inventoryType: 'warehouseInventory', inventoryPlace: req.query.office })
        .sort({ createdAt: -1 })
        .select('_id');
      if (!warehouse) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
      inventoryId = warehouse._id;
    }

    // No upsert: a missing inventory must fail, not be silently recreated as
    // a blank inventory holding these packages.
    const inventory = await Inventory.findOneAndUpdate(
      { _id: inventoryId },
      {
        $push: {
          "orders": {
            $each: orders.map(orderArray => orderArray)
          }
        },
      },
      { new: true }
    )
    .populate(['createdBy', 'orders'])

    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));
    const ids = inventory.orders.map(order => new ObjectId(order.paymentList?._id));
    
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

    // See the comment on deleteWarehousePackage: Mongoose's query builder
    // (findOneAndUpdate included) silently no-ops this $pull on real
    // documents, so the raw driver is used here instead, then the updated
    // document is re-fetched normally (with populate) for the response.
    await Inventory.collection.updateOne(
      { _id: new ObjectId(req.query.id) },
      {
        $pull: {
          orders: {
            $or: [
              { "paymentList._id": { $in: paymentList.map(id => id) } },
              { "paymentList._id": { $in: paymentList.map(id => new ObjectId(id)) } }
            ]
          }
        }
      }
    );

    const inventory = await Inventory.findById(req.query.id).populate(['createdBy', 'orders']);
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
  });
  
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

module.exports.deleteFiles = async (req, res, next) => {
  try {
    const inventory = await Inventory.findByIdAndUpdate(req.body.id, {
      $pull: {
        attachments: {
          filename: req.body.image.filename
        }
      }
    }, { new: true });

    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    await Activities.create({
      user: req.user,
      details: {
        path: '/inventory',
        status: 'deleted',
        type: 'inventory',
        actionName: 'image',
        actionId: inventory._id
      },
      changedFields: [{
        label: 'image',
        value: 'image',
        changedFrom: req.body.image.path,
        changedTo: ''
      }]
    })

    res.status(200).json({ isSuccess: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getWarehouseInventory = async (req, res, next) => {
  try {
    const { office } = req.params;
    const inventory = await Inventory.find({ inventoryType: 'warehouseInventory', inventoryPlace: office }).sort({ createdAt: -1 }).populate(['createdBy', 'orders']);
    if (inventory.length === 0) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const ids = (inventory[0].orders || []).map(order => new ObjectId(order.paymentList?._id));

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

// Employee/admin: removes one package from a warehouse, with a required
// reason, and keeps a permanent audit record of who did it and why (an
// employee can delete, but only an admin can list these records - see
// getPackageDeletions).
module.exports.deleteWarehousePackage = async (req, res, next) => {
  try {
    const { id, paymentListId } = req.params;
    const reason = (req.body?.reason || '').trim();

    if (!reason) {
      return next(new ErrorHandler(400, 'A reason is required to delete a package'));
    }

    const inventory = await Inventory.findById(id);
    if (!inventory) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const entry = inventory.orders.find((order) => String(order.paymentList?._id) === paymentListId);
    if (!entry) return next(new ErrorHandler(404, 'Package not found in this warehouse'));

    const pkg = entry.paymentList?.deliveredPackages || {};
    // The order snapshot embedded in the warehouse only stores `user` as a
    // bare id (it's pushed unpopulated), so look up the customerId separately.
    const customer = entry.user ? await Users.findById(entry.user).select('customerId') : null;

    // Every Mongoose query method (updateOne, findOneAndUpdate, updateMany)
    // silently no-ops this $pull on real warehouse documents - it reports
    // matched/modified but leaves `orders` untouched, because this array has
    // no schema type (orders: []) and Mongoose's query casting for that
    // mis-handles the nested 'paymentList._id' path once the document has
    // real-world complexity (confirmed on clones of production data; only
    // trivial single-field test docs happened to pass). The raw MongoDB
    // driver, bypassing Mongoose's query builder entirely, works correctly.
    await Inventory.collection.updateOne(
      { _id: new ObjectId(id) },
      { $pull: { orders: { 'paymentList._id': new ObjectId(paymentListId) } } }
    );

    const deletion = await PackageDeletion.create({
      inventory: id,
      inventoryPlace: inventory.inventoryPlace,
      order: entry._id,
      orderId: entry.orderId,
      paymentListId,
      snapshot: {
        customerName: entry.customerInfo?.fullName,
        customerId: customer?.customerId,
        phone: entry.customerInfo?.phone,
        trackingNumber: pkg.trackingNumber,
        receiptNo: pkg.receiptNo,
        weight: pkg.weight,
      },
      reason,
      deletedBy: req.user._id,
    });

    res.status(200).json(deletion);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Admin only: the audit trail of packages employees (or admins) have deleted
// from a warehouse, most recent first.
module.exports.getPackageDeletions = async (req, res, next) => {
  try {
    const { office } = req.query;
    const query = office ? { inventoryPlace: office } : {};
    const deletions = await PackageDeletion.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('deletedBy', 'firstName lastName');

    res.status(200).json(deletions);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// Employee/admin: records that someone physically walked the warehouse and
// reconciled it against the system. `discrepancies` lists any package that
// didn't match (missing, damaged, wrong location, ...), each with a note.
module.exports.submitWarehouseCheck = async (req, res, next) => {
  try {
    const { office } = req.params;
    const { notes, discrepancies } = req.body;

    const cleanDiscrepancies = Array.isArray(discrepancies)
      ? discrepancies
          .filter((d) => d?.note && String(d.note).trim())
          .map((d) => ({
            paymentListId: d.paymentListId,
            trackingNumber: d.trackingNumber,
            customerName: d.customerName,
            note: String(d.note).trim(),
          }))
      : [];

    const warehouse = await Inventory.findOne({ inventoryType: 'warehouseInventory', inventoryPlace: office })
      .sort({ createdAt: -1 })
      .select('_id orders');
    if (!warehouse) return next(new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND));

    const check = await WarehouseCheck.create({
      inventoryPlace: office,
      inventory: warehouse._id,
      checkedBy: req.user._id,
      totalPackages: warehouse.orders.length,
      discrepancies: cleanDiscrepancies,
      notes: (notes || '').trim() || undefined,
    });

    const populated = await check.populate('checkedBy', 'firstName lastName');
    res.status(201).json(populated);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

// History of weekly checks for an office, most recent first - lets the
// employee see proof they submitted it, and the admin see every one.
module.exports.getWarehouseChecks = async (req, res, next) => {
  try {
    const { office } = req.params;
    const checks = await WarehouseCheck.find({ inventoryPlace: office })
      .sort({ createdAt: -1 })
      .limit(30)
      .populate('checkedBy', 'firstName lastName');

    res.status(200).json(checks);
  } catch (error) {
    return next(new ErrorHandler(500, error.message));
  }
};

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

    const counts = (await ReturnedPayments.aggregate([
      {
        $group: {
          _id: null,
          active: {
            $sum: {
              $cond: [
                { $eq: ["$status", 'active'] },
                1,
                0
              ]
            }
          },
          waitingApproval: {
            $sum: {
              $cond: [
                { $eq: ["$status", 'waitingApproval'] },
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
      results: returnedPayments,
      meta: {
        counts
      }
    });
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
