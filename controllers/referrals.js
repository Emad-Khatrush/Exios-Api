// Invite a friend over HTTP (spec 2026-11-20-referrals-design.md): the customer's invite page, the
// sign-up page's code check, and staff setting or cancelling a customer's inviter.
const mongoose = require('mongoose');
const referrals = require('../accounting/services/loyalty/referrals');
const { runInTransaction } = require('../accounting/services/transaction');
const ErrorHandler = require('../utils/errorHandler');
const customerPush = require('../utils/customerPush');

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error);
  }
};
const customerId = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ErrorHandler(400, 'حدد العميل');
  return req.params.id;
};

// Tell both sides once the referral is saved (never fails the request)
async function announce(friendId, attached) {
  await customerPush.referralJoined(attached.inviterId, attached.friendName);
  await customerPush.referralWelcome(friendId, attached.inviterName, attached.welcome);
}

module.exports.mine = handle((req) => referrals.mine(req.user._id));

module.exports.check = handle((req) => referrals.check(req.params.code));

module.exports.staffInfo = handle((req) => referrals.staffInfo(customerId(req)));

module.exports.staffSet = handle(async (req) => {
  const friendId = customerId(req);
  const attached = await runInTransaction((session) => referrals.attach({ friendId, code: req.body?.code, source: 'staff', by: req.user._id }, session));
  await announce(friendId, attached);
  return referrals.staffInfo(friendId);
});

module.exports.staffCancel = handle(async (req) => {
  const friendId = customerId(req);
  await runInTransaction((session) => referrals.cancel({ friendId, reason: req.body?.reason, by: req.user._id }, session));
  return referrals.staffInfo(friendId);
});

// Sign-up: the code a new customer gave. A code that cannot be used never fails the sign-up: the
// account stays, without an inviter, and the app is told why.
module.exports.attachAtSignup = async (friendId, code, source) => {
  if (!String(code || '').trim()) return null;
  try {
    const attached = await runInTransaction((session) => referrals.attach({ friendId, code, source: source === 'link' ? 'link' : 'code' }, session));
    await announce(friendId, attached);
    return { ok: true, inviterName: attached.inviterName, welcome: attached.welcome };
  } catch (error) {
    return { ok: false, message: error?.statusCode === 400 || error?.status === 400 ? error.message : 'تعذر تطبيق كود الدعوة' };
  }
};
