const mongoose = require('mongoose');
const Order = require('../models/order');
const Activities = require('../models/activities');
const ErrorHandler = require('../utils/errorHandler');
const { runInTransaction } = require('../accounting/services/transaction');

exports.update = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ErrorHandler(400, 'Invalid order ID.');
    if (typeof req.body.blocked !== 'boolean' || (req.body.reason !== undefined && typeof req.body.reason !== 'string')) throw new ErrorHandler(400, 'Choose a valid shipping restriction and reason.');
    const reason = String(req.body.reason || '').trim();
    if (req.body.blocked && !reason) throw new ErrorHandler(400, 'Enter a reason before blocking shipping.');
    if (reason.length > 500) throw new ErrorHandler(400, 'The reason must be 500 characters or fewer.');
    const outcome = await runInTransaction(async session => {
      const order = await Order.findOne({ _id: req.params.id, isDeleted: { $ne: true }, isCanceled: { $ne: true } }).session(session);
      if (!order) throw new ErrorHandler(404, 'Order not found or no longer active.');
      const nextReason = req.body.blocked ? reason : '';
      if (!!order.shippingBlocked === req.body.blocked && (order.shippingBlockReason || '') === nextReason) return order;
      // The same order row is locked when packages enter a trip. A simultaneous
      // block/add operation cannot commit from a stale snapshot.
      const updated = await Order.findByIdAndUpdate(order._id, {
        $set: { shippingBlocked: req.body.blocked, shippingBlockReason: nextReason,
          shippingBlockedAt: req.body.blocked ? new Date() : null, shippingBlockedBy: req.body.blocked ? req.user._id : null },
        $inc: { accountingMutationVersion: 1 },
      }, { new: true, session, runValidators: true });
      await Activities.create([{
        user: req.user._id, details: { path: `/invoice/${order._id}/edit`, status: 'updated', type: 'order', actionId: String(order._id) },
        changedFields: [
          { label: 'Shipping blocked', changedFrom: String(!!order.shippingBlocked), changedTo: String(req.body.blocked) },
          { label: 'Shipping restriction reason', changedFrom: order.shippingBlockReason || '', changedTo: nextReason },
        ],
      }], { session });
      return updated;
    });
    res.json({ shippingBlocked: !!outcome.shippingBlocked, shippingBlockReason: outcome.shippingBlockReason || '' });
  } catch (error) { next(error); }
};
