// Checks a staff member's permissions (constants/staffPermissions.js) on an API route, after `protect`.
//
// - Admins and the owner accounts pass everywhere (the owner's decision: admins have the whole system
//   outside accounting; accounting keeps its own permissions).
// - A staff member whose permissions were saved (staffAccess.kind set) passes when they hold any of
//   the route's keys.
// - A staff member nobody has configured yet keeps exactly the access they had before permissions
//   existed: the route's old guard runs instead. Nobody loses access on the day this is deployed.
const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const { STAFF_KEYS } = require('../constants/staffPermissions');
const { isOwner } = require('../accounting/services/access');

// Not 'authorize-invalid': the admin app reads that one as an expired session and signs out
const PERMISSION_DENIED = 'permission-denied';

const isConfigured = (user) => !!user?.staffAccess?.kind;

// The keys a configured staff member holds; null for someone not configured yet
const permissionsOf = (user) => (isConfigured(user)
  ? (user.staffAccess.permissions || []).filter((key) => STAFF_KEYS.includes(key))
  : null);

const isStaff = (user) => !!(user?.roles?.isAdmin || user?.roles?.isEmployee || user?.roles?.isAccountant);

// Full access: admins and owners
async function hasFullAccess(user) {
  return !!user?.roles?.isAdmin || await isOwner(user);
}

// Runs the old guards one after another, as Express would have
function runGuards(guards, req, res, next) {
  let index = 0;
  const step = (error) => {
    if (error) return next(error);
    const guard = guards[index++];
    if (!guard) return next();
    return guard(req, res, step);
  };
  step();
}

function check(test, legacyGuards) {
  // A guard that was not imported would only fail when someone calls the route: fail at startup
  if (legacyGuards.some((guard) => typeof guard !== 'function')) throw new Error('A legacy guard given to allow/anyStaff is not a function');
  return async (req, res, next) => {
    const user = req.user;
    if (!user) return next(new ErrorHandler(404, errorMessages.USER_NOT_FOUND));
    try {
      if (await hasFullAccess(user)) return next();
    } catch (error) {
      return next(error);
    }
    const permissions = permissionsOf(user);
    if (permissions) {
      if (isStaff(user) && test(permissions)) return next();
      return next(new ErrorHandler(403, PERMISSION_DENIED));
    }
    if (!legacyGuards.length) return next(new ErrorHandler(403, PERMISSION_DENIED));
    return runGuards(legacyGuards, req, res, next);
  };
}

// allow(['invoices_edit', 'warehouse'], allowAdminsAndEmployee): passes with any of the keys; an
// unconfigured staff member goes through the old guard(s) given after the keys
const allow = (keys, ...legacyGuards) => {
  const unknown = keys.filter((key) => !STAFF_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown staff permission: ${unknown.join(', ')}`);
  return check((permissions) => keys.some((key) => permissions.includes(key)), legacyGuards);
};

// For the lookups every staff screen needs (an order, a customer, a wallet's balance): any staff
// member with at least one permission
const anyStaff = (...legacyGuards) => check((permissions) => permissions.length > 0, legacyGuards);

module.exports = { allow, anyStaff, permissionsOf, isConfigured, hasFullAccess, PERMISSION_DENIED };
