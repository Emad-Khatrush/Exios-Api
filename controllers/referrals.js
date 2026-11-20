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

// Every reward from the customer's friends (or one friend's), page by page
module.exports.history = handle((req) => referrals.historyOf(req.user._id, {
  friendId: req.query.friend || undefined, status: req.query.status || undefined, page: req.query.page,
}));

module.exports.check = handle((req) => referrals.check(req.params.code));

module.exports.staffInfo = handle((req) => referrals.staffInfo(customerId(req)));

module.exports.staffSet = handle(async (req) => {
  const friendId = customerId(req);
  const attached = await runInTransaction((session) => referrals.attach({ friendId, code: req.body?.code, source: 'staff', by: req.user._id }, session));
  await announce(friendId, attached);
  return referrals.staffInfo(friendId);
});

// The review queue (suspicious referrals, step rewards) and the report of referrals set by hand
module.exports.reviewQueue = handle(() => referrals.reviewQueue());
module.exports.manualReport = handle(() => referrals.manualReport());
module.exports.approveReferral = handle((req) => runInTransaction((session) => referrals.approveReferral({ friendId: customerId(req), by: req.user._id }, session)));
module.exports.rejectReferral = handle((req) => runInTransaction((session) => referrals.rejectReferral({ friendId: customerId(req), reason: req.body?.reason, by: req.user._id }, session)));
module.exports.approveStep = handle((req) => runInTransaction((session) => referrals.approveStep({ rewardId: customerId(req), by: req.user._id }, session)));
module.exports.rejectStep = handle((req) => runInTransaction((session) => referrals.rejectStep({ rewardId: customerId(req), reason: req.body?.reason, by: req.user._id }, session)));

module.exports.staffCancel = handle(async (req) => {
  const friendId = customerId(req);
  await runInTransaction((session) => referrals.cancel({ friendId, reason: req.body?.reason, by: req.user._id }, session));
  return referrals.staffInfo(friendId);
});

// Sign-up: the code a new customer gave. A code that cannot be used never fails the sign-up: the
// account stays, without an inviter, and the app is told why. Without an inviter the account gets
// the new account's gift instead (100 points; invited: 500, never both).
async function attachCode(friendId, code, source) {
  if (!String(code || '').trim()) return null;
  try {
    const attached = await runInTransaction((session) => referrals.attach({ friendId, code, source: source === 'link' ? 'link' : 'code' }, session));
    await announce(friendId, attached);
    return { ok: true, inviterName: attached.inviterName, welcome: attached.welcome };
  } catch (error) {
    return { ok: false, message: error?.statusCode === 400 || error?.status === 400 ? error.message : 'تعذر تطبيق كود الدعوة' };
  }
}
module.exports.attachAtSignup = async (friendId, code, source) => {
  const referral = await attachCode(friendId, code, source);
  if (referral?.ok) return { referral };
  let signupGift = 0;
  try {
    signupGift = await runInTransaction((session) => referrals.signupGift({ userId: friendId }, session));
  } catch (error) {
    console.error('[referrals] signup gift:', error.message);
  }
  return { ...(referral && { referral }), signupGift };
};
