const ErrorHandler = require('./errorHandler');

// Financial actions have their own routes. The general editor cannot impersonate
// a cancellation, rewrite audit history, or reassign the owner through a raw ID.
function guardOrderUpdate(body, saved) {
  if (Object.keys(body).some(key => key.startsWith('$'))) throw new ErrorHandler(400, 'Update operators are not accepted');
  for (const key of ['isCanceled', 'isDeleted', 'deletedAt', 'deletedBy', 'cancelation', 'invoiceConfirmed', 'requestedEditDetails', 'editedAmounts', 'accountingMutationVersion', 'madeBy', 'orderId', 'user']) {
    if (body[key] === undefined) continue;
    const value = saved[key]?.toObject ? saved[key].toObject() : saved[key];
    if (JSON.stringify(body[key]) !== JSON.stringify(value)) throw new ErrorHandler(400, `Use the dedicated action to change ${key}`);
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
