// Which trips carried a package (spec 4.3): Order.paymentList[].tripId (the air or sea trip) and
// domesticTripId (the domestic trip that took it on to another office). The trips' package lists
// (Inventory.orders) stay what the operations screens edit; these two fields follow them, so
// accounting reads one explicit link per package instead of searching copies inside trips.
// Warehouses (warehouseInventory) never set them.
const mongoose = require('mongoose');
const Order = require('../../models/order');
const Inventory = require('../../models/inventory');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const both = (ids) => ids.flatMap((id) => [String(id), oid(id)]);
const BATCH = 500;

// Recomputes the links of these packages from the trips that hold them now. A package on several
// trips of one kind belongs to the newest one.
async function refreshPackageTrips(packageIds, { session } = {}) {
  const ids = [...new Set((packageIds || []).filter((id) => id && mongoose.isValidObjectId(String(id))).map(String))];
  let updated = 0;
  for (let start = 0; start < ids.length; start += BATCH) {
    const chunk = ids.slice(start, start + BATCH);
    const trips = await Inventory.find({ inventoryType: 'inventoryGoods', 'orders.paymentList._id': { $in: both(chunk) } })
      .select('shippingType createdAt orders.paymentList._id').sort({ createdAt: 1 }).session(session || null).lean();
    const links = new Map(chunk.map((id) => [id, { tripId: null, domesticTripId: null }]));
    trips.forEach((trip) => (trip.orders || []).forEach((entry) => {
      const link = links.get(String(entry?.paymentList?._id));
      if (!link) return;
      // Oldest first, so the newest trip of each kind wins
      if (trip.shippingType === 'domestic') link.domesticTripId = trip._id;
      else link.tripId = trip._id;
    }));
    const orders = await Order.find({ 'paymentList._id': { $in: chunk.map(oid) } }).select('paymentList._id paymentList.tripId paymentList.domesticTripId').session(session || null).lean();
    const operations = [];
    orders.forEach((order) => (order.paymentList || []).forEach((pkg) => {
      const link = links.get(String(pkg._id));
      if (!link) return;
      if (String(pkg.tripId || '') === String(link.tripId || '') && String(pkg.domesticTripId || '') === String(link.domesticTripId || '')) return;
      operations.push({
        updateOne: {
          filter: { _id: order._id, 'paymentList._id': pkg._id },
          update: { $set: { 'paymentList.$.tripId': link.tripId, 'paymentList.$.domesticTripId': link.domesticTripId } },
        },
      });
    }));
    if (operations.length) {
      await Order.bulkWrite(operations, { session: session || undefined });
      updated += operations.length;
    }
  }
  return { packages: ids.length, updated };
}

// After a trip's packages changed: the packages on it now, and the ones that pointed to it
async function refreshTripPackages(tripId, { session, extraPackageIds = [] } = {}) {
  if (!tripId || !mongoose.isValidObjectId(String(tripId))) return { packages: 0, updated: 0 };
  const trip = await Inventory.findById(tripId).select('inventoryType orders.paymentList._id').session(session || null).lean();
  const current = (trip?.orders || []).map((entry) => entry?.paymentList?._id).filter(Boolean);
  const pointing = await Order.find({ $or: [{ 'paymentList.tripId': oid(tripId) }, { 'paymentList.domesticTripId': oid(tripId) }] })
    .select('paymentList._id paymentList.tripId paymentList.domesticTripId').session(session || null).lean();
  const linked = pointing.flatMap((order) => (order.paymentList || [])
    .filter((pkg) => String(pkg.tripId) === String(tripId) || String(pkg.domesticTripId) === String(tripId)).map((pkg) => pkg._id));
  return refreshPackageTrips([...current, ...linked, ...extraPackageIds], { session });
}

// Every package on any trip (run by the setup and before the historical migration): fills the
// links for data that existed before the fields did
async function backfillTripLinks() {
  const trips = await Inventory.find({ inventoryType: 'inventoryGoods' }).select('orders.paymentList._id').lean();
  const ids = trips.flatMap((trip) => (trip.orders || []).map((entry) => entry?.paymentList?._id).filter(Boolean));
  const linked = await Order.find({ $or: [{ 'paymentList.tripId': { $ne: null } }, { 'paymentList.domesticTripId': { $ne: null } }] }).select('paymentList._id').lean();
  return refreshPackageTrips([...ids, ...linked.flatMap((order) => (order.paymentList || []).map((pkg) => pkg._id))]);
}

module.exports = { refreshPackageTrips, refreshTripPackages, backfillTripLinks };
