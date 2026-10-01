// Live posting of the system's own operations through an outbox.
//
// Existing screens (wallet, orders, debts, inventory) call emitAccountingEvent() after their
// own writes. Nothing is recorded while live posting is off (before the historical migration),
// and an accounting problem (a missing rate, say) never blocks the operation: the event waits
// in the queue with its error until it is fixed and retried.
const { AccountingEvent } = require('../models');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const operations = require('./posting/operations');
const { syncOrder, syncTrip } = require('./claims/sync');

const MAX_ATTEMPTS = 5;
const BATCH = 50;

const HANDLERS = {
  // payload: { target: { orderId, category, packageIds, balanceId }, reverses: statementId }
  statement: (id, payload, ctx) => operations.postStatement(id, { ...ctx, target: payload.target, reverses: payload.reverses }),
  statementUpdated: (id, payload, ctx) => operations.repostStatement(id, { ...ctx, target: payload.target }),
  statementDeleted: (id, payload, ctx) => operations.reverseStatement(id, ctx),
  cashPayment: (id, payload, ctx) => operations.postCashPayment(id, { ...ctx, office: payload.office }),
  cashPaymentDeleted: (id, payload, ctx) => operations.reverseCashPayment(id, ctx),
  order: (id, payload, ctx) => syncOrder(id, ctx),
  trip: (id, payload, ctx) => syncTrip(id, ctx),
  balance: (id, payload, ctx) => operations.postGeneralDebt(id, ctx),
  balanceWriteOff: (id, payload, ctx) => operations.postDebtWriteOff(id, ctx),
  balanceDeleted: (id, payload, ctx) => operations.reverseBalance(id, ctx),
};

async function isLive() {
  try {
    const { settings } = await getConfig();
    return !!settings?.liveEnabled;
  } catch {
    return false;
  }
}

// Never throws: the operation that emitted it has already happened and must not fail because of it
async function emitAccountingEvent(type, refId, payload = {}, user) {
  try {
    if (!HANDLERS[type] || !refId) return null;
    if (!(await isLive())) return null;
    return await AccountingEvent.create({ type, refId, payload, userId: user?._id });
  } catch (error) {
    console.error(`[accounting] could not record ${type} ${refId}:`, error.message);
    return null;
  }
}

// For screens that only know the visible order number (orderId), not the document _id
async function emitOrdersByNumber(orderNumbers, user) {
  try {
    if (!(await isLive())) return;
    const Order = require('../../models/order');
    const orders = await Order.find({ orderId: { $in: [...new Set(orderNumbers.filter(Boolean).map(String))] } }).select('_id').lean();
    for (const order of orders) await emitAccountingEvent('order', order._id, {}, user);
  } catch (error) {
    console.error('[accounting] could not record order changes:', error.message);
  }
}

async function processEvent(event) {
  try {
    const result = await runInTransaction((session) => HANDLERS[event.type](event.refId, event.payload || {}, { session, user: event.userId ? { _id: event.userId } : undefined }));
    event.status = result?.skipped ? 'skipped' : 'done';
    event.result = result;
    event.lastError = undefined;
  } catch (error) {
    event.attempts += 1;
    event.status = 'failed';
    event.lastError = error.message;
  }
  event.processedAt = new Date();
  await event.save();
  return event;
}

// Oldest first, so a deposit is always posted before the payment that spends it
async function processQueue({ limit = BATCH } = {}) {
  const events = await AccountingEvent.find({ $or: [{ status: 'pending' }, { status: 'failed', attempts: { $lt: MAX_ATTEMPTS } }] })
    .sort({ createdAt: 1 }).limit(limit);
  let done = 0;
  for (const event of events) {
    const result = await processEvent(event);
    if (result.status !== 'failed') done++;
  }
  return { processed: events.length, done };
}

let timer = null;
let running = false;
function startWorker(intervalMs = 10000) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running || !(await isLive())) return;
    running = true;
    try {
      await processQueue();
    } catch (error) {
      console.error('[accounting] worker:', error.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { emitAccountingEvent, emitOrdersByNumber, processQueue, processEvent, startWorker, HANDLERS };
