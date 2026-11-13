// Settings > Permissions: what each staff member may open, set by an admin or an owner.
// - The owner accounts always have everything; nobody can change them.
// - Admins have the whole system; only their accounting permissions can be set here.
// - Everyone else (employees, accountants) gets a type of work and the permissions ticked for them,
//   plus accounting, which they see only when given at least one accounting permission.
// Nobody changes their own permissions.
const mongoose = require('mongoose');
const User = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');
const { PERMISSION_GROUPS, STAFF_KEYS, STAFF_TYPES, STAFF_TYPE_KEYS } = require('../constants/staffPermissions');
const accountingAccess = require('../accounting/services/access');
const { AccountingMember } = require('../accounting/models');
const { logAudit } = require('../accounting/services/audit');
const { permissionsOf, isConfigured } = require('../middleware/permissions');

const STAFF_FILTER = { $or: [{ 'roles.isAdmin': true }, { 'roles.isEmployee': true }, { 'roles.isAccountant': true }] };

const roleOf = (user) => (user.roles?.isAdmin ? 'admin' : user.roles?.isAccountant && !user.roles?.isEmployee ? 'accountant' : 'employee');

// What the signed-in staff member may open, for the admin app to show only that
module.exports.me = async (req, res, next) => {
  try {
    const user = req.user;
    const isOwner = await accountingAccess.isOwner(user);
    const full = isOwner || !!user.roles?.isAdmin;
    res.status(200).json({
      isOwner,
      isAdmin: !!user.roles?.isAdmin,
      full,
      configured: !full && isConfigured(user),
      kind: user.staffAccess?.kind || null,
      permissions: full ? STAFF_KEYS : (permissionsOf(user) || []),
      canManage: full,
    });
  } catch (error) {
    return next(error);
  }
};

async function describe(user, accountingByUser, actor) {
  const isOwner = await accountingAccess.isOwner(user);
  const isAdmin = !!user.roles?.isAdmin;
  const self = String(user._id) === String(actor._id);
  let lockedReason = null;
  if (isOwner) lockedReason = 'owner';
  else if (self) lockedReason = 'self';
  return {
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    imgUrl: user.imgUrl,
    office: user.office || null,
    role: roleOf(user),
    isOwner,
    isAdmin,
    lockedReason,
    configured: !isOwner && !isAdmin && isConfigured(user),
    kind: user.staffAccess?.kind || null,
    permissions: isOwner || isAdmin ? STAFF_KEYS : (permissionsOf(user) || []),
    accounting: isOwner ? accountingAccess.KEYS : (accountingByUser.get(String(user._id)) || []),
    updatedAt: user.staffAccess?.updatedAt || null,
    updatedBy: user.staffAccess?.updatedBy || null,
  };
}

// Every staff member with what they may do, and the choices
module.exports.members = async (req, res, next) => {
  try {
    const [users, members] = await Promise.all([
      User.find({ ...STAFF_FILTER, isCanceled: { $ne: true } })
        .select('firstName lastName username imgUrl roles office staffAccess')
        .populate('staffAccess.updatedBy', 'firstName lastName')
        .sort({ firstName: 1 })
        .lean(),
      AccountingMember.find({}).lean(),
    ]);
    const accountingByUser = new Map(members.map((m) => [String(m.userId), (m.permissions || []).filter((key) => accountingAccess.KEYS.includes(key))]));
    const results = [];
    for (const user of users) results.push(await describe(user, accountingByUser, req.user));
    // Owners first, then admins, then everyone else by name
    const rank = (m) => (m.isOwner ? 0 : m.isAdmin ? 1 : 2);
    results.sort((a, b) => rank(a) - rank(b));
    res.status(200).json({
      results,
      // Only an owner may move someone between admin and employee
      viewer: { canChangeRole: await accountingAccess.isOwner(req.user) },
      groups: PERMISSION_GROUPS,
      types: STAFF_TYPES,
      accounting: { permissions: accountingAccess.PERMISSIONS, presets: accountingAccess.PRESETS },
    });
  } catch (error) {
    return next(error);
  }
};

// { role, kind, permissions: [...], accounting: [...] }. role is 'admin' or 'staff' and only an owner
// may change it (an admin demoting another admin, or promoting someone, is the owner's call). For an
// admin only `accounting` is used.
module.exports.save = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new ErrorHandler(400, 'الموظف غير صالح');
    if (String(id) === String(req.user._id)) throw new ErrorHandler(403, 'لا يمكنك تعديل صلاحياتك بنفسك');

    const user = await User.findOne({ _id: id, ...STAFF_FILTER }).select('firstName lastName roles staffAccess');
    if (!user) throw new ErrorHandler(404, 'الموظف غير موجود');
    if (await accountingAccess.isOwner(user)) throw new ErrorHandler(403, 'صلاحيات المالك كاملة دائماً ولا يمكن لأحد تعديلها');

    const body = req.body || {};
    const before = {
      role: user.roles?.isAdmin ? 'admin' : 'staff',
      kind: user.staffAccess?.kind || null,
      permissions: permissionsOf(user) || [],
      accounting: (await AccountingMember.findOne({ userId: user._id }).lean())?.permissions || [],
    };

    const role = body.role === undefined ? before.role : body.role;
    if (!['admin', 'staff'].includes(role)) throw new ErrorHandler(400, 'الدور غير صالح');
    if (role !== before.role) {
      if (!(await accountingAccess.isOwner(req.user))) throw new ErrorHandler(403, 'تغيير الدور بين مدير وموظف للمالك فقط');
      user.roles.isAdmin = role === 'admin';
      user.markModified('roles');
    }

    if (role === 'admin') {
      if (role !== before.role) await user.save();
    } else {
      const kind = String(body.kind || '');
      if (!STAFF_TYPE_KEYS.includes(kind)) throw new ErrorHandler(400, 'اختر نوع الموظف');
      const permissions = [...new Set((Array.isArray(body.permissions) ? body.permissions : []).filter((key) => STAFF_KEYS.includes(key)))];
      user.staffAccess = { kind, permissions, updatedAt: new Date(), updatedBy: req.user._id };
      // A configured staff member is an employee for the rest of the system (lists of employees,
      // who made an invoice, the employee home page), whatever role they had
      user.roles.isEmployee = true;
      user.markModified('roles');
      await user.save();
    }

    let accounting = before.accounting;
    if (Array.isArray(body.accounting)) {
      const saved = await accountingAccess.setMember(user._id, body.accounting, req.user);
      accounting = saved?.permissions || [];
    }

    const after = { role, kind: user.staffAccess?.kind || null, permissions: permissionsOf(user) || [], accounting };
    await logAudit({ req, action: 'access.staff', model: 'User', docId: user._id, before, after });
    res.status(200).json({ _id: user._id, ...after });
  } catch (error) {
    return next(error);
  }
};
