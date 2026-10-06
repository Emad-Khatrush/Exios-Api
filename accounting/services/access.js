// Who may do what in accounting (spec 7-أ.11, as the owner decided it):
// - The owner accounts (two admin accounts) can do everything, and are the only ones who can
//   give access to others.
// - Any other admin or accountant has only the permissions the owner gave them. Without them
//   they do not see the accounting section at all.
const mongoose = require('mongoose');
const { AccountingMember } = require('../models');
const User = require('../../models/user');
const ErrorHandler = require('../../utils/errorHandler');

// The permissions, grouped as the owner thinks of the work. `reference` reads (accounts,
// currencies, offices, vendors list...) are open to every member: every form needs them.
const PERMISSIONS = [
  { key: 'dashboard', label: 'لوحة المحاسبة', hint: 'أرصدة الخزائن والأرقام الرئيسية' },
  { key: 'reports', label: 'التقارير والأرباح', hint: 'قائمة الدخل، الميزانية، ميزان المراجعة، أرباح الطلبيات والرحلات، كشوف العملاء، المطابقة' },
  { key: 'purchases', label: 'فواتير الموردين وتكاليف الرحلات', hint: 'فواتير الموردين، المصروفات السريعة، تكاليف الرحلات، الموردون' },
  { key: 'payments', label: 'دفعات الموردين', hint: 'سداد فواتير الموردين وكشف حساب المورد' },
  { key: 'treasury', label: 'الخزينة والبنوك', hint: 'التحويلات، الجرد، مطابقة البنك' },
  { key: 'payroll', label: 'الموظفون والرواتب', hint: 'الرواتب والعهد والسلف' },
  { key: 'assets', label: 'الأصول ورأس المال', hint: 'الأصول والإهلاك، المصروفات المقدمة، رأس المال والقروض، المقاصة' },
  { key: 'entries_view', label: 'عرض القيود', hint: 'قراءة القيود والسندات دون إنشاء أو تعديل' },
  { key: 'entries', label: 'إدخال القيود', hint: 'عرض القيود وإنشاء القيود اليدوية والشطب؛ الإلغاء يحتاج صلاحية الإلغاء أيضاً' },
  { key: 'rates', label: 'الأسعار اليومية', hint: 'إدخال أسعار العملات' },
  { key: 'suspense', label: 'تسوية المعلّق', hint: 'تسوية ما لم يُعرف حسابه' },
  { key: 'closing', label: 'الإقفال', hint: 'إقفال الشهر والسنة' },
  { key: 'setup', label: 'الإعدادات والترحيل', hint: 'شجرة الحسابات، المكاتب، الدفاتر، الترحيل التاريخي، معالج البدء، التصدير لأودو' },
  { key: 'audit', label: 'سجل التدقيق', hint: 'من غيّر ماذا ومتى' },
  // Separate from entering documents (owner's decision): only the owner and the accountant cancel
  { key: 'cancel', label: 'إلغاء المستندات المُرحَّلة', hint: 'إلغاء فاتورة أو دفعة أو قيد مُرحَّل بقيد عكسي. الإلغاء في فترة مقفلة للمالك فقط' },
];
const KEYS = PERMISSIONS.map((p) => p.key);

// Ready-made sets to start from; the owner can then add or remove single permissions
const PRESETS = [
  { key: 'full', label: 'صلاحيات كاملة', permissions: KEYS },
  { key: 'purchases', label: 'إدخال الموردين والرحلات', permissions: ['purchases', 'payments'] },
  { key: 'cashier', label: 'أمين خزينة', permissions: ['treasury', 'rates', 'purchases'] },
  { key: 'auditor', label: 'مراجع (عرض فقط)', permissions: ['dashboard', 'reports', 'entries_view', 'audit'] },
];

// The owner accounts. The first is emadkhatrush on the production database (MONGO_URL_2); the
// others are the owner accounts of the test database (MONGO_URL), where the ids differ.
// ACCOUNTING_OWNER_IDS (comma separated) replaces the list.
const DEFAULT_OWNERS = ['69deb74c4b5e921e7416ea11', '62bb47b22aabe070791f8278', '632aeb399aefb9b93b7a7527', '6aa99588ae35416174639238'];
const ownerIds = () => (process.env.ACCOUNTING_OWNER_IDS ? process.env.ACCOUNTING_OWNER_IDS.split(',') : DEFAULT_OWNERS)
  .map((id) => id.trim()).filter((id) => mongoose.isValidObjectId(id));

// A database where none of the owner accounts exists is closed to everyone (owner's decision): a
// copy of production with other ids must set ACCOUNTING_OWNER_IDS. Only for local work,
// ACCOUNTING_DEV_ALL_ADMINS=true makes every admin an owner there. Checked once a minute.
const devAllAdmins = () => process.env.ACCOUNTING_DEV_ALL_ADMINS === 'true';
let warned = false;
const warnDevMode = () => {
  if (warned || process.env.NODE_ENV === 'test') return;
  warned = true;
  console.warn('[accounting] ACCOUNTING_DEV_ALL_ADMINS=true and no owner account in this database: every admin is an owner. Never set this in production.');
};
let ownersPresent = null;
let checkedAt = 0;
let checkedFor = '';
async function ownersExist() {
  const ids = ownerIds();
  if (ownersPresent === null || checkedFor !== ids.join(',') || Date.now() - checkedAt > 60 * 1000) {
    ownersPresent = (await User.countDocuments({ _id: { $in: ids } })) > 0;
    checkedAt = Date.now();
    checkedFor = ids.join(',');
  }
  return ownersPresent;
}

// The owner accounts are owners whatever role they have in the rest of the system
async function isOwner(user) {
  if (!user) return false;
  if (ownerIds().includes(String(user._id))) return true;
  if (!devAllAdmins() || !user.roles?.isAdmin || (await ownersExist())) return false;
  warnDevMode();
  return true;
}

// { isOwner, permissions: [...] } for a signed-in user; no permissions = no access
async function accessOf(user) {
  if (!user) return { isOwner: false, permissions: [] };
  if (await isOwner(user)) return { isOwner: true, permissions: KEYS };
  if (!user.roles?.isAdmin && !user.roles?.isAccountant) return { isOwner: false, permissions: [] };
  const member = await AccountingMember.findOne({ userId: user._id }).lean();
  return { isOwner: false, permissions: (member?.permissions || []).filter((key) => KEYS.includes(key)) };
}

const denied = () => new ErrorHandler(403, 'ليست لديك صلاحية لهذا الجزء من المحاسبة. اطلبها من المالك.');

// Loads req.access; a user with no permission at all does not get into the section
async function loadAccess(req, res, next) {
  try {
    req.access = await accessOf(req.user);
    if (!req.access.permissions.length) return next(denied());
    return next();
  } catch (error) {
    return next(error);
  }
}

// Allowed when the user holds any of these permissions
const can = (...keys) => (req, res, next) => (keys.some((key) => req.access?.permissions.includes(key)) ? next() : next(denied()));
const ownerOnly = (req, res, next) => (req.access?.isOwner ? next() : next(denied()));

// ---- Members (owner only) ----

// Every admin and accountant, with what they may do
async function listMembers() {
  const [users, members] = await Promise.all([
    User.find({ $or: [{ 'roles.isAdmin': true }, { 'roles.isAccountant': true }, { _id: { $in: ownerIds() } }] }).select('firstName lastName username imgUrl roles').sort({ firstName: 1 }).lean(),
    AccountingMember.find({}).populate('updatedBy', 'firstName lastName').lean(),
  ]);
  const byUser = new Map(members.map((m) => [String(m.userId), m]));
  const results = [];
  for (const user of users) {
    const owner = await isOwner(user);
    const member = byUser.get(String(user._id));
    results.push({
      _id: user._id, firstName: user.firstName, lastName: user.lastName, username: user.username, imgUrl: user.imgUrl,
      role: user.roles?.isAdmin ? 'admin' : 'accountant', isOwner: owner,
      permissions: owner ? KEYS : (member?.permissions || []),
      updatedAt: member?.updatedAt || null, updatedBy: member?.updatedBy || null,
    });
  }
  return results.sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
}

async function setMember(userId, permissions, by) {
  if (!mongoose.isValidObjectId(userId)) throw new ErrorHandler(400, 'المستخدم غير صالح');
  const user = await User.findById(userId).select('roles').lean();
  if (!user || (!user.roles?.isAdmin && !user.roles?.isAccountant)) throw new ErrorHandler(400, 'الصلاحيات تُعطى لحسابات المدير والمحاسب فقط');
  if (await isOwner({ ...user, _id: userId })) throw new ErrorHandler(400, 'حساب المالك له كل الصلاحيات دائماً');
  const clean = [...new Set((Array.isArray(permissions) ? permissions : []).filter((key) => KEYS.includes(key)))];
  if (!clean.length) {
    await AccountingMember.deleteOne({ userId });
    return { userId, permissions: [] };
  }
  return AccountingMember.findOneAndUpdate({ userId }, { $set: { permissions: clean, updatedBy: by?._id } }, { upsert: true, new: true }).lean();
}

module.exports = { PERMISSIONS, PRESETS, KEYS, accessOf, loadAccess, can, ownerOnly, listMembers, setMember, isOwner };
