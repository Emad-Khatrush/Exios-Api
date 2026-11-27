// Who a WhatsApp campaign (POST /api/sendMessagesToClients) goes to: every client, the clients
// without an order yet, or a list chosen in the customer analyses (customList, owner 2026-11-27).
// Cancelled accounts are always left out.
const mongoose = require('mongoose');
const Users = require('../models/user');
const ErrorHandler = require('./errorHandler');

const FIELDS = { phone: 1, firstName: 1, lastName: 1, customerId: 1 };
const MAX_LIST = 5000;

const isObjectId = (id) => id != null && mongoose.Types.ObjectId.isValid(String(id)) && String(new mongoose.Types.ObjectId(String(id))) === String(id);

async function usersForCampaign({ target, userIds, skip, limit } = {}) {
  if (target === 'customList') {
    if (!Array.isArray(userIds) || !userIds.length || userIds.length > MAX_LIST || !userIds.every(isObjectId)) {
      throw new ErrorHandler(400, `قائمة العملاء يجب أن تحتوي من 1 إلى ${MAX_LIST} رقم حساب صحيح`);
    }
    const ids = [...new Set(userIds.map(String))];
    return Users.find({ _id: { $in: ids }, isCanceled: false, 'roles.isClient': true }).select(FIELDS).sort({ createdAt: -1 }).lean();
  }
  if (target === 'onlyNewClients') {
    return Users.aggregate([
      { $match: { 'roles.isClient': true, isCanceled: false } },
      { $lookup: { from: 'orders', localField: '_id', foreignField: 'user', as: 'orders' } },
      { $match: { orders: { $size: 0 } } },
      { $project: FIELDS },
      { $sort: { createdAt: -1 } },
      { $skip: Number(skip) || 0 },
      { $limit: Number(limit) || 5000 },
    ]);
  }
  return Users.find({ isCanceled: false, 'roles.isClient': true })
    .select(FIELDS)
    .sort({ createdAt: -1 })
    .skip(Number(skip) || 0)
    .limit(Number(limit) || 5000);
}

module.exports = { usersForCampaign, MAX_LIST };
