// Customer analytics settings (owner 2026-11-27): the targets and the accounts marked as companies.
// GET/PUT /analytics/customers-settings; saving clears the dataset kept in memory.
const mongoose = require('mongoose');
const ErrorHandler = require('../../../utils/errorHandler');
const Setting = require('../../../models/customerAnalyticsSetting');
const User = require('../../../models/user');
const { clearCache } = require('./dataset');

// Rates 0..1, money in US cents, days
const TARGET_KEYS = [
  'repeatRate', 'returningRate', 'month1Retention', 'conversionRate', 'medianDaysToFirstOrder',
  'lostCustomers', 'atRiskCustomers', 'avgOrderCents', 'ordersPerCustomer', 'cacCents', 'valueToCac',
  'medianDeliveryDays', 'avgRating',
];

const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ');

async function getSettings() {
  const doc = await Setting.findOne({ key: 'main' }).lean();
  const ids = doc?.companies || [];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select({ firstName: 1, lastName: 1, customerId: 1 }).lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return {
    targets: doc?.targets || {},
    companies: ids.map(String).filter((id) => byId.has(id)).map((id) => ({ id, name: fullName(byId.get(id)), customerId: byId.get(id).customerId || null })),
  };
}

function checkTargets(targets) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new ErrorHandler(400, 'الأهداف يجب أن تكون قائمة مفاتيح وأرقام');
  const kept = {};
  for (const [key, value] of Object.entries(targets)) {
    if (!TARGET_KEYS.includes(key)) throw new ErrorHandler(400, `هدف غير معروف: ${key}`);
    // A target left empty in the dialog comes as null: no target for it
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ErrorHandler(400, `قيمة الهدف ${key} يجب أن تكون رقماً`);
    kept[key] = value;
  }
  return kept;
}

async function checkCompanies(companies) {
  if (!Array.isArray(companies)) throw new ErrorHandler(400, 'حسابات الشركات يجب أن تكون قائمة');
  const ids = [...new Set(companies.map(String))];
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id) || String(new mongoose.Types.ObjectId(id)) !== id)) {
    throw new ErrorHandler(400, 'رقم حساب غير صحيح في حسابات الشركات');
  }
  const found = await User.countDocuments({ _id: { $in: ids }, 'roles.isClient': true });
  if (found !== ids.length) throw new ErrorHandler(400, 'بعض حسابات الشركات ليست حسابات عملاء موجودة');
  return ids;
}

// body { targets?, companies? }: each one sent replaces what was saved
async function putSettings(body = {}, { userId } = {}) {
  const set = {};
  if (body.targets !== undefined) set.targets = checkTargets(body.targets);
  if (body.companies !== undefined) set.companies = await checkCompanies(body.companies);
  if (userId) set.updatedBy = userId;
  await Setting.updateOne({ key: 'main' }, { $set: set, $setOnInsert: { key: 'main' } }, { upsert: true });
  clearCache();
  return getSettings();
}

module.exports = { getSettings, putSettings, TARGET_KEYS };
