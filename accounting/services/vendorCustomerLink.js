const mongoose = require('mongoose');
const User = require('../../models/user');
const { Vendor } = require('../models/documents');
const { fail } = require('./posting/common');

async function customerByCode(value, session) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw fail('اكتب كود عميل واحد صالح');
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const customers = await User.find({ customerId: new RegExp(`^${escaped}$`, 'i'), isCanceled: { $ne: true } })
    .select('_id firstName lastName customerId').limit(2).session(session || null).lean();
  if (customers.length !== 1) throw fail(customers.length ? 'كود العميل غير فريد؛ راجع بيانات العملاء' : 'لا يوجد عميل نشط بهذا الكود');
  return customers[0];
}

// A vendor stores one scalar customer ID. Writing a new link requires its exact
// customer code; selecting arbitrary IDs or lists cannot create another link.
async function linkFromInput(input, session) {
  if (input.isCustomerVendor !== undefined && typeof input.isCustomerVendor !== 'boolean') throw fail('خيار مورد وعميل غير صالح');
  if (Array.isArray(input.linkedCustomer) || Array.isArray(input.linkedCustomerCode)) throw fail('يمكن ربط المورد بعميل واحد فقط');
  if (input.isCustomerVendor === false) return null;
  const requested = input.isCustomerVendor === true || !!input.linkedCustomerCode || !!input.linkedCustomer;
  if (!requested) return input.linkedCustomer === '' || input.linkedCustomer === null ? null : undefined;
  const customer = await customerByCode(input.linkedCustomerCode, session);
  if (input.linkedCustomer && String(input.linkedCustomer) !== String(customer._id)) throw fail('كود العميل لا يطابق العميل المختار');
  return customer._id;
}

async function lockVendor(id, session) {
  if (!mongoose.isValidObjectId(id)) throw fail('اختر المورد');
  const vendor = await Vendor.findOneAndUpdate({ _id: id, isActive: true }, { $inc: { costPostingVersion: 1 } }, { new: true, session });
  if (!vendor) throw fail('اختر موردًا نشطًا');
  return vendor;
}

async function linkedCustomer(vendor, expectedId, session, required = true) {
  if (!vendor.linkedCustomer) {
    if (required || expectedId) throw fail('اربط المورد بكود العميل من قسم الموردين قبل الإضافة للمحفظة');
    return null;
  }
  if (expectedId && String(expectedId) !== String(vendor.linkedCustomer)) throw fail('الإضافة مسموحة لمحفظة العميل المرتبط بهذا المورد فقط');
  const customer = await User.findOne({ _id: vendor.linkedCustomer, isCanceled: { $ne: true }, customerId: { $type: 'string', $ne: '' } })
    .select('_id firstName lastName customerId').session(session || null).lean();
  if (!customer) throw fail('العميل المرتبط غير متاح؛ راجع ربط المورد');
  return customer;
}

module.exports = { customerByCode, linkFromInput, lockVendor, linkedCustomer };
