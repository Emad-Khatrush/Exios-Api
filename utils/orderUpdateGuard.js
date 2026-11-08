const ErrorHandler = require('./errorHandler');
const REFERENCE_FIELDS = new Set(['madeBy', 'user', 'deletedBy']);
const referenceId = value => value == null ? null : String(value._id || value);

// Financial actions have their own routes. The general editor cannot impersonate
// a cancellation, rewrite audit history, or reassign the owner through a raw ID.
// madeBy (the employee credited with the sale, used by goals and employee reports, not by the
// books): any staff member fills it when empty, only an admin changes it once chosen; the
// order's change log records it.
function guardOrderUpdate(body, saved, { user } = {}) {
  const previousDispatchStage = saved.isPayment ? 3 : 2;
  const dispatchStage = (body.isPayment ?? saved.isPayment) ? 3 : 2;
  if (saved.shippingBlocked && (body.orderStatus !== undefined || body.isPayment !== undefined) && Number(saved.orderStatus || 0) < previousDispatchStage && Number(body.orderStatus ?? saved.orderStatus ?? 0) >= dispatchStage) {
    throw new ErrorHandler(409, 'Shipping is blocked for this order. Remove the restriction before marking it as shipped.');
  }
  if (Object.keys(body).some(key => key.startsWith('$') || key.includes('.'))) throw new ErrorHandler(400, 'Update operators and dotted field paths are not accepted');
  for (const key of ['shippingBlocked', 'shippingBlockReason', 'shippingBlockedAt', 'shippingBlockedBy', 'isCanceled', 'isDeleted', 'deletedAt', 'deletedBy', 'cancelation', 'invoiceConfirmed', 'requestedEditDetails', 'editedAmounts', 'accountingMutationVersion', 'madeBy', 'orderId', 'orderStatusChangedAt', 'user']) {
    if (body[key] === undefined) continue;
    const value = saved[key]?.toObject ? saved[key].toObject() : saved[key];
    // Read APIs populate staff/customer references. Sending the same reference
    // back is harmless; compare IDs rather than an object against an ObjectId.
    const same = REFERENCE_FIELDS.has(key)
      ? referenceId(body[key]) === referenceId(value)
      : JSON.stringify(body[key]) === JSON.stringify(value);
    if (!same && key === 'madeBy') {
      // Empty: anyone fills it. Already chosen: only an admin changes it.
      if (referenceId(value) && !user?.roles?.isAdmin) throw new ErrorHandler(403, 'Only an admin can change who made the order');
      const madeBy = referenceId(body.madeBy);
      if (!/^[0-9a-f]{24}$/i.test(madeBy || '')) throw new ErrorHandler(400, 'Choose an employee for Made by');
      body.madeBy = madeBy;
      continue;
    }
    if (!same) throw new ErrorHandler(400, `Use the dedicated action to change ${key}`);
    delete body[key];
  }
  for (const key of ['receivedUSD', 'receivedLYD', 'receivedShipmentUSD', 'receivedShipmentLYD']) {
    if (body[key] !== undefined && Number(body[key] || 0) !== Number(saved[key] || 0)) throw new ErrorHandler(400, 'Record received money as a payment or a wallet deposit');
    delete body[key];
  }
  if (body.items !== undefined) {
    if (saved.invoiceConfirmed) throw new ErrorHandler(400, 'Request an invoice item change for approval');
    if (!Array.isArray(body.items)) throw new ErrorHandler(400, 'Invoice items must be a list');
    const total = body.items.reduce((sum, item) => sum + Number(item.unitPrice) * Number(item.quantity), 0);
    if (!Number.isFinite(total) || total < 0) throw new ErrorHandler(400, 'Invalid invoice total');
    body.totalInvoice = total;
  } else if (body.totalInvoice !== undefined) {
    if (Number(body.totalInvoice) !== Number(saved.totalInvoice || 0)) throw new ErrorHandler(400, 'Change invoice items to change its total');
    delete body.totalInvoice;
  }
}

module.exports = { guardOrderUpdate };
