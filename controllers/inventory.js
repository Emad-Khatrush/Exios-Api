const { runInTransaction } = require('../accounting/services/transaction');
const Inventory = require("../models/inventory");
const Orders = require("../models/order");
const ErrorHandler = require('../utils/errorHandler');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { errorMessages } = require("../constants/errorTypes");
const mongodb = require('mongodb');
const Activities = require("../models/activities");
const ReturnedPayments = require("../models/returnedPayments");
const { emitAccountingEvent } = require('../accounting/services/events');
const { tripDeletionBlockers } = require('../accounting/services/tripGuards');
const { refreshTripPackages } = require('../accounting/services/tripLinks');
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

    // Partial search: any part of a voyage, order ID or tracking number matches
    // (the text index only matched whole words, so half a tracking number found nothing).
    const search = String(searchValue || '').trim();
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const orderMatch = { $or: [{ orderId: pattern }, { 'paymentList.deliveredPackages.trackingNumber': pattern }] };
      // Packages found on the live orders, since the copies kept on the inventory can be outdated
      const livePackages = await Orders.aggregate([
        { $match: orderMatch },
        { $unwind: '$paymentList' },
        { $match: orderMatch },
        { $limit: 2000 },
        { $project: { _id: 0, id: '$paymentList._id' } },
      ]);
      query = [
        {
          $match: {
            inventoryType: 'inventoryGoods',
            $or: [
              { voyage: pattern },
              { 'orders.orderId': pattern },
              { 'orders.paymentList.deliveredPackages.trackingNumber': pattern },
              { 'orders.paymentList._id': { $in: livePackages.map((p) => p.id) } },
            ],
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

    // The list only needs package counts, not every embedded order (see attachFlightStats)
    inventoryPipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "createdBy",
          pipeline: [
            { $project: { username: 1, firstName: 1, lastName: 1 } }
          ]
        }
      },
      {
        $unwind: { path: "$createdBy", preserveNullAndEmptyArrays: true }
      },
      {
        $addFields: { packageIds: "$orders.paymentList._id" }
      },
      {
        $project: { orders: 0, expenses: 0 }
      }
    );

    // Execute the aggregation query
    let inventory = await attachFlightStats(await Inventory.aggregate(inventoryPipeline));

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
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FLIGHT_TYPES = ['air', 'sea'];
const STALE_OPEN_DAYS = 30;
const EMPTY_FLIGHT_DAYS = 7;

// Package counts and weights for each inventory, read from the live orders (the copies
// embedded in inventory.orders go stale). Expects `packageIds` (orders.paymentList._id)
// on every inventory and replaces it with `stats`.
const attachFlightStats = async (inventories) => {
  const ids = inventories.flatMap((inv) => inv.packageIds || []).filter((id) => id && ObjectId.isValid(id)).map((id) => new ObjectId(id));
  const rows = ids.length ? await Orders.aggregate([
    { $match: { 'paymentList._id': { $in: ids } } },
    { $unwind: '$paymentList' },
    { $match: { 'paymentList._id': { $in: ids } } },
    { $project: {
        _id: 0,
        id: '$paymentList._id',
        received: '$paymentList.status.received',
        mark: '$paymentList.mark',
        weight: '$paymentList.deliveredPackages.weight.total',
        unit: '$paymentList.deliveredPackages.weight.measureUnit',
    } },
  ]) : [];
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  return inventories.map(({ packageIds, ...inv }) => {
    const packages = [...new Set((packageIds || []).filter(Boolean).map(String))].map((id) => byId.get(id)).filter(Boolean);
    const stats = {
      packagesCount: packages.length,
      receivedCount: packages.filter((p) => p.received).length,
      missingCount: packages.filter((p) => p.mark === 'missing').length,
      totalKG: packages.filter((p) => p.unit === 'KG').reduce((sum, p) => sum + (p.weight || 0), 0),
      totalCBM: packages.filter((p) => p.unit === 'CBM').reduce((sum, p) => sum + (p.weight || 0), 0),
    };
    return { ...inv, stats };
  });
};

// Expenses in USD; LYD expenses without an exchange rate are kept apart so nothing is guessed.
const summarizeExpenses = (expenses = []) => {
  let usd = 0;
  let unconvertedLYD = 0;
  expenses.forEach((exp) => {
    if (exp.currency === 'USD') usd += exp.amount || 0;
    else if (exp.rate > 0) usd += (exp.amount || 0) / exp.rate;
    else unconvertedLYD += exp.amount || 0;
  });
  return { usd, unconvertedLYD, count: expenses.length };
};

// Things on an open flight that someone should look at. Each one is actionable.
const flightFlags = (flight, now = Date.now()) => {
  if (flight.status === 'finished') return [];
  const flags = [];
  const { stats } = flight;
  const openedAt = new Date(flight.arrivalDate || flight.createdAt).getTime();

  if (stats.packagesCount > 0 && stats.receivedCount === stats.packagesCount) flags.push('readyToClose');
  if (stats.missingCount > 0) flags.push('missingPackages');
  if (stats.packagesCount === 0 && now - new Date(flight.createdAt).getTime() > EMPTY_FLIGHT_DAYS * DAY_MS) flags.push('noPackages');
  if (!flight.arrivalDate) flags.push('noArrivalDate');
  if (!flight.expenses?.length) flags.push('noExpenses');
  if (now - openedAt > STALE_OPEN_DAYS * DAY_MS) flags.push('openTooLong');
  return flags;
};

const toFlight = (inv, now) => {
  const money = summarizeExpenses(inv.expenses);
  const unitWeight = inv.shippingType === 'sea' ? inv.stats.totalCBM : inv.stats.totalKG;
  const openedAt = new Date(inv.arrivalDate || inv.createdAt).getTime();
  return {
    _id: inv._id,
    voyage: inv.voyage,
    shippingType: inv.shippingType,
    shippedCountry: inv.shippedCountry,
    inventoryPlace: inv.inventoryPlace,
    status: inv.status,
    arrivalDate: inv.arrivalDate,
    inventoryFinishedDate: inv.inventoryFinishedDate,
    createdAt: inv.createdAt,
    note: inv.note,
    attachmentsCount: inv.attachments?.length || 0,
    stats: inv.stats,
    expenses: money,
    // Shipping cost per KG (air) or per CBM (sea), from the expenses recorded so far
    costPerUnit: unitWeight > 0 && money.usd > 0 ? money.usd / unitWeight : null,
    daysOpen: inv.status === 'finished' ? null : Math.max(0, Math.floor((now - openedAt) / DAY_MS)),
    flags: flightFlags(inv, now),
  };
};

// Admin flight board. Query: view (open | attention | finished), shippingType (air | sea),
// office, search (voyage), skip, limit. Open flights are few, so they're always scored in
// full to give the attention count; finished flights are paged in the database.
module.exports.getFlights = async (req, res, next) => {
  try {
    const view = ['open', 'attention', 'finished'].includes(req.query.view) ? req.query.view : 'open';
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const match = {
      inventoryType: 'inventoryGoods',
      shippingType: FLIGHT_TYPES.includes(req.query.shippingType) ? req.query.shippingType : { $in: FLIGHT_TYPES },
    };
    if ((await require('../utils/offices').officeCodes()).includes(req.query.office)) match.inventoryPlace = req.query.office;
    const search = String(req.query.search || '').trim();
    if (search) match.voyage = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const projection = { orders: 0 };
    const withIds = (docs) => docs.map((doc) => ({ ...doc, packageIds: (doc.orderIds || []).map((o) => o?.paymentList?._id) }));
    const load = (filter, options = {}) => Inventory.aggregate([
      { $match: filter },
      { $sort: options.sort || { createdAt: -1 } },
      ...(options.skip ? [{ $skip: options.skip }] : []),
      ...(options.limit ? [{ $limit: options.limit }] : []),
      { $addFields: { orderIds: { $map: { input: { $ifNull: ['$orders', []] }, as: 'o', in: { paymentList: { _id: '$$o.paymentList._id' } } } } } },
      { $project: projection },
    ]);

    const now = Date.now();
    const openFlights = (await attachFlightStats(withIds(await load({ ...match, status: { $ne: 'finished' } }))))
      .map((inv) => toFlight(inv, now))
      // Longest-waiting first, so the oldest open flights are handled first
      .sort((a, b) => (b.daysOpen || 0) - (a.daysOpen || 0));
    const attention = openFlights.filter((f) => f.flags.length > 0);
    const finishedCount = await Inventory.countDocuments({ ...match, status: 'finished' });

    let results;
    let total;
    if (view === 'finished') {
      const page = await load({ ...match, status: 'finished' }, { sort: { inventoryFinishedDate: -1, createdAt: -1 }, skip, limit });
      results = (await attachFlightStats(withIds(page))).map((inv) => toFlight(inv, now));
      total = finishedCount;
    } else {
      const list = view === 'attention' ? attention : openFlights;
      results = list.slice(skip, skip + limit);
      total = list.length;
    }

    const sum = (list, pick) => list.reduce((acc, f) => acc + (pick(f) || 0), 0);
    res.status(200).json({
      results,
      total,
      skip,
      limit,
      counts: { open: openFlights.length, attention: attention.length, finished: finishedCount },
      // Totals across every open flight matching the type/office/search filters
      openSummary: {
        packages: sum(openFlights, (f) => f.stats.packagesCount),
        received: sum(openFlights, (f) => f.stats.receivedCount),
        totalKG: sum(openFlights, (f) => f.stats.totalKG),
        totalCBM: sum(openFlights, (f) => f.stats.totalCBM),
        expensesUSD: sum(openFlights, (f) => f.expenses.usd),
        readyToClose: openFlights.filter((f) => f.flags.includes('readyToClose')).length,
      },
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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


    const outcome = await runInTransaction(async (session) => {
      const [inventory] = await Inventory.create([{
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
      }], { session })

      return inventory;
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    const outcome = await runInTransaction(async (session) => {

      const { id } = req.params;
      const existing = await Inventory.findById(id).select('inventoryType orders.paymentList._id expenses').lean().session(session);
      if (!existing) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      // A trip with costs or packages is never deleted: its accounting history would be lost
      const blockers = await tripDeletionBlockers(existing, { session });
      if (blockers.length) throw new ErrorHandler(400, `This trip cannot be deleted: ${blockers.join('; ')}.`);
      const inventory = await Inventory.findByIdAndDelete(id, { session });
      if (!inventory) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      await emitAccountingEvent('trip', inventory._id, {}, req.user, { session });

      return { message: 'Inventory deleted successfully' };
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    const outcome = await runInTransaction(async (session) => {

      if (!Array.isArray(req.body) || !req.body.length) throw new ErrorHandler(400, 'Select packages');
      const paymentListIds = [...new Set(req.body.map(order => String(order?.paymentList?._id)))].map(id => new ObjectId(id));
      const orders = await Orders.aggregate([
        {
          $unwind: '$paymentList'
        },
        {
          $match: {
            'paymentList._id': { $in: paymentListIds },
            isDeleted: { $ne: true },
            isCanceled: { $ne: true }
          }
        }
      ]).session(session)

      if (orders.length !== paymentListIds.length) throw new ErrorHandler(409, 'Some packages are no longer available');
      for (const id of [...new Set(orders.map(order => String(order._id)))].sort()) {
        await Orders.updateOne({ _id: id }, { $inc: { accountingMutationVersion: 1 } }, { session });
      }

      // ?office=tripoli|benghazi targets that office's warehouse, resolved the
      // same way getWarehouseInventory does (newest one), instead of callers
      // hardcoding an inventory id that breaks when the warehouse is recreated.
      let inventoryId = req.query.id;
      if (req.query.office) {
        if (!WAREHOUSE_OFFICES.includes(req.query.office)) throw new ErrorHandler(400, 'Unknown office');
        // Created on first use, so moving packages to an office with no warehouse yet works
        const warehouse = await getOrCreateWarehouse(req.query.office, req.user, { session });
        inventoryId = warehouse._id;
      }

      // No upsert: a missing inventory must fail, not be silently recreated as
      // a blank inventory holding these packages.
      const savedInventory = await Inventory.findById(inventoryId).session(session);
      if (!savedInventory) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      const present = new Set((savedInventory.orders || []).map(order => String(order.paymentList?._id)));
      const additions = orders.filter(order => !present.has(String(order.paymentList._id)));
      const inventory = await Inventory.findOneAndUpdate(
        { _id: inventoryId },
        {
          $push: {
            "orders": {
              $each: additions
            }
          },
        },
        { new: true, session }
      )
      .populate(['createdBy', 'orders'])

      if (!inventory) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      // The packages' trip links follow the trip's list (accounting reads them)
      await refreshTripPackages(inventory._id, { session });
      await emitAccountingEvent('trip', inventory._id, {}, req.user, { session });
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
      ]).session(session);
      updatedOrders = await Orders.populate(updatedOrders, [{ path: "madeBy" }, { path: "user" }, { path: "orders" }]);

      inventory.orders = updatedOrders;

      return inventory;
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.removeOrdersFromInventory = async (req, res, next) => {
  try {
    const outcome = await runInTransaction(async (session) => {

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
      , { session });

      const inventory = await Inventory.findById(req.query.id).populate(['createdBy', 'orders']).session(session);
      if (!inventory) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      // The packages' trip links follow the trip's list (accounting reads them)
      await refreshTripPackages(inventory._id, { session });
      await emitAccountingEvent('trip', inventory._id, {}, req.user, { session });

      return inventory;
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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

const WAREHOUSE_OFFICES = ['tripoli', 'benghazi'];
const WAREHOUSE_NAMES = { tripoli: 'مخزن طرابلس', benghazi: 'مخزن بنغازي' };

// The office warehouse is the newest 'warehouseInventory' of that office. When an office has
// none yet it is created here, so the warehouse page and "move to warehouse" never hit a 404.
// The upsert is atomic, so two requests at the same time still end up with one warehouse.
const getOrCreateWarehouse = async (office, user, { session } = {}) => {
  if (!session) return runInTransaction((activeSession) => getOrCreateWarehouse(office, user, { session: activeSession }));
  await require('../accounting/services/counter').nextSeq(`WAREHOUSE:${office}`, session);
  const existing = await Inventory.findOne({ inventoryType: 'warehouseInventory', inventoryPlace: office })
    .sort({ createdAt: -1 })
    .select('_id').session(session || null);
  if (existing) return existing;

  return Inventory.findOneAndUpdate(
    { inventoryType: 'warehouseInventory', inventoryPlace: office },
    {
      $setOnInsert: {
        inventoryType: 'warehouseInventory',
        inventoryPlace: office,
        voyage: WAREHOUSE_NAMES[office],
        shippedCountry: 'LY',
        shippingType: 'domestic',
        status: 'processing',
        createdBy: user?._id,
        orders: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, session }
  ).select('_id');
};

module.exports.getWarehouseInventory = async (req, res, next) => {
  try {
    const { office } = req.params;
    if (!WAREHOUSE_OFFICES.includes(office)) return next(new ErrorHandler(400, 'Unknown office'));

    await getOrCreateWarehouse(office, req.user);
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
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

module.exports.updateInventory = async (req, res, next) => {
  try {
    const outcome = await runInTransaction(async (session) => {

      const { id } = req.query;
      if (!id) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);

      const currentInventory = await Inventory.findById(id).session(session);
      if (!currentInventory) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);
      const update = { ...req.body };
      // Package membership uses the dedicated add/remove operations.
      if (update.orders !== undefined) throw new ErrorHandler(400, 'Use package add/remove actions to change trip packages');

      // The ready date (inventoryFinishedDate) is the day the inventory is marked finished (اكتملت).
      // Set it here when the status changes to finished and no date was sent with it.
      if (update.status === 'finished' && !update.inventoryFinishedDate) {
        const current = await Inventory.findById(id).select('status').session(session);
        if (current && current.status !== 'finished') {
          update.inventoryFinishedDate = new Date();
        }
      }

      const updatedInventory = await Inventory.updateOne({ _id: id }, update, { new: true, session });
      // The packages' trip links follow the trip's list (accounting reads them)
      await refreshTripPackages(id, { session });
      await emitAccountingEvent('trip', id, {}, req.user, { session });

      return updatedInventory;
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
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

// Internal shipping (شحن داخلي): send selected packages out of an office warehouse.
// Creates a new domestic inventory holding them, then removes them from the warehouse.
module.exports.createInternalShipping = async (req, res, next) => {
  try {
    const outcome = await runInTransaction(async (session) => {

      const { office } = req.params;
      const { paymentListIds, voyage, destination, note } = req.body || {};

      if (!WAREHOUSE_OFFICES.includes(office)) throw new ErrorHandler(400, 'Unknown office');
      if (!WAREHOUSE_OFFICES.includes(destination)) throw new ErrorHandler(400, 'Choose the destination office');
      if (!String(voyage || '').trim()) throw new ErrorHandler(400, 'Shipment name is required');
      if (!Array.isArray(paymentListIds) || paymentListIds.length === 0) {
        throw new ErrorHandler(400, 'Select at least one package');
      }

      const warehouse = await Inventory.findOne({ inventoryType: 'warehouseInventory', inventoryPlace: office }).sort({ createdAt: -1 }).session(session);
      if (!warehouse) throw new ErrorHandler(404, errorMessages.INVENTORY_NOT_FOUND);

      // Every selected package must still be in this warehouse (someone may have moved or deleted it meanwhile)
      const inWarehouse = new Set((warehouse.orders || []).map(order => String(order.paymentList?._id)));
      const requested = Array.from(new Set(paymentListIds.map(String)));
      const missing = requested.filter(id => !inWarehouse.has(id));
      if (missing.length > 0) {
        throw new ErrorHandler(409, `${missing.length} of the selected packages are no longer in this warehouse. Refresh the page and try again.`);
      }

      // Fresh copies of the packages, the same way packages are added to any inventory
      const objectIds = requested.map(id => new ObjectId(id));
      const orders = await Orders.aggregate([
        { $unwind: '$paymentList' },
        { $match: { 'paymentList._id': { $in: objectIds } } }
      ]).session(session);
      if (orders.length !== requested.length) throw new ErrorHandler(409, 'Some selected packages are missing');
      for (const id of [...new Set(orders.map(order => String(order._id)))].sort()) {
        const locked = await Orders.updateOne({ _id: id, isDeleted: { $ne: true }, isCanceled: { $ne: true } }, { $inc: { accountingMutationVersion: 1 } }, { session });
        if (locked.modifiedCount !== 1) throw new ErrorHandler(409, 'A selected order is no longer available');
      }

      const [shipment] = await Inventory.create([{
        createdBy: req.user,
        inventoryType: 'inventoryGoods',
        shippingType: 'domestic',
        shippedCountry: 'LY',
        inventoryPlace: destination,
        voyage: String(voyage).trim(),
        note: [`شحن داخلي من ${WAREHOUSE_NAMES[office]}`, String(note || '').trim()].filter(Boolean).join('\n'),
        status: 'processing',
        orders,
      }], { session });

      // Raw driver $pull, see deleteWarehousePackage for why Mongoose can't be used here.
      // Any failure rolls back both the shipment and the warehouse change.
      try {
        await Inventory.collection.updateOne(
          { _id: warehouse._id },
          {
            $pull: {
              orders: {
                $or: [
                  { 'paymentList._id': { $in: requested } },
                  { 'paymentList._id': { $in: objectIds } }
                ]
              }
            }
          }
        , { session });
      } catch (error) {
        // The transaction rolls back the newly created shipment.
        throw error;
      }

      await Activities.create([{
        user: req.user,
        details: {
          path: `/inventory/${shipment._id}/edit`,
          status: 'added',
          type: 'inventory',
          actionId: String(shipment._id),
        },
        changedFields: [
          { label: 'Internal shipping', value: `${requested.length} packages from ${office} to ${destination}` },
        ],
      }], { session });

      // The packages' trip links follow the trip's list (accounting reads them)
      await refreshTripPackages(shipment._id, { session });
      await emitAccountingEvent('trip', shipment._id, {}, req.user, { session });
      return { _id: shipment._id, voyage: shipment.voyage, movedCount: requested.length };
    });
    res.status(200).json(outcome);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}
