// What stops a trip from being deleted (spec 7-ج.8): a trip that carries costs or packages keeps
// its history; only an empty mistake can disappear. Warehouses are not trips and are not checked.
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { SupplierBill } = require('../models/documents');
const Order = require('../../models/order');

async function tripDeletionBlockers(trip, { session } = {}) {
  if (!trip || trip.inventoryType !== 'inventoryGoods') return [];
  const id = new mongoose.Types.ObjectId(String(trip._id));
  const queries = [
    JournalEntry.countDocuments({ 'lines.tripId': id }),
    SupplierBill.countDocuments({ 'lines.tripId': id, status: { $ne: 'canceled' } }),
    Order.countDocuments({ $or: [{ 'paymentList.tripId': id }, { 'paymentList.domesticTripId': id }] }),
  ];
  const results = [];
  for (const query of queries) results.push(await query.session(session || null));
  const [entryCount, billCount, linkedCount] = results;
  const blockers = [];
  if ((trip.orders || []).length || linkedCount) blockers.push('the trip still has packages; remove them first');
  if ((trip.expenses || []).length) blockers.push('the trip has recorded expenses');
  if (billCount) blockers.push(`the trip has ${billCount} supplier bill(s) in accounting; cancel them first`);
  if (entryCount && !billCount) blockers.push('the trip has accounting entries');
  return blockers;
}

module.exports = { tripDeletionBlockers };
