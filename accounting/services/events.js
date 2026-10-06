// Live posting of the system's own operations through an outbox.
//
// Existing screens (wallet, orders, debts, inventory) call emitAccountingEvent() after their
// own writes. Events are recorded ALWAYS, also before live posting is on (spec 19.11); they are
// only posted once it is. When the historical migration is committed, every event recorded before
// the migration read the data is marked 'covered' (the migration posted that state already).
// An accounting problem (a missing rate, say) never blocks the operation: the event waits in the
// queue with its error until it is fixed and retried.
const { AccountingEvent } = require('../models');
const { lockPeriod } = require('./periodLock');
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
  paymentRate: (id, payload, ctx) => operations.repostPaymentRate(id, { ...ctx, ...payload }),
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
async function emitAccountingEvent(type, refId, payload = {}, user, { session } = {}) {
  try {
    if (!HANDLERS[type] || !refId) return null;
    const event = { type, refId, payload, userId: user?._id };
    if (session) {
      await lockPeriod(session);
      return (await AccountingEvent.create([event], { session }))[0];
    }
    return await AccountingEvent.create(event);
  } catch (error) {
    console.error(`[accounting] could not record ${type} ${refId}:`, error.message);
    if (session) throw error;
    return null;
  }
}

// For screens that only know the visible order number (orderId), not the document _id
async function emitOrdersByNumber(orderNumbers, user, { session } = {}) {
  try {
    const Order = require('../../models/order');
    const orders = await Order.find({ orderId: { $in: [...new Set(orderNumbers.filter(Boolean).map(String))] } }).select('_id').session(session || null).lean();
    for (const order of orders) await emitAccountingEvent('order', order._id, {}, user, { session });
  } catch (error) {
    console.error('[accounting] could not record order changes:', error.message);
    if (session) throw error;
  }
}

async function processEvent(event, { resetAttempts = false } = {}) {
  try {
    return await runInTransaction(async (session) => {
      const current = await AccountingEvent.findById(event._id).session(session);
      if (!current || !['pending', 'failed'].includes(current.status)) return current;
      // Serialize workers on this event and commit its completion with its journal entry.
      // A competing worker retries, then sees the terminal status without invoking the handler.
      await AccountingEvent.updateOne({ _id: current._id }, { $inc: { processingVersion: 1 } }, { session });
      const handler = HANDLERS[current.type];
      if (!handler) throw new Error(`Unknown accounting event type: ${current.type}`);
      const result = await handler(current.refId, current.payload || {}, { session, user: current.userId ? { _id: current.userId } : undefined });
      current.status = result?.skipped ? 'skipped' : 'done';
      current.result = result;
      current.lastError = undefined;
      current.processedAt = new Date();
      if (resetAttempts) current.attempts = 0;
      await current.save({ session });
      return current;
    });
  } catch (error) {
    // Do not let a late failure overwrite an event another worker has already completed.
    const patch = { $set: { status: 'failed', lastError: error.message, processedAt: new Date() } };
    if (resetAttempts) patch.$set.attempts = 1;
    else patch.$inc = { attempts: 1 };
    return await AccountingEvent.findOneAndUpdate(
      { _id: event._id, status: { $in: ['pending', 'failed'] } }, patch, { new: true }
    ) || await AccountingEvent.findById(event._id);
  }
}

// Oldest first, so a deposit is always posted before the payment that spends it
async function processQueue({ limit = BATCH } = {}) {
  if (!(await isLive())) return { processed: 0, done: 0, waiting: 'live posting is off' };
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

// At the commit: events recorded up to the moment the migration read the data are covered by it
async function markCovered(upTo) {
  const result = await AccountingEvent.updateMany(
    { status: { $in: ['pending', 'failed'] }, createdAt: { $lte: upTo } },
    { $set: { status: 'covered', processedAt: new Date(), lastError: undefined } },
  );
  return result.modifiedCount || 0;
}

module.exports = { markCovered, emitAccountingEvent, emitOrdersByNumber, processQueue, processEvent, startWorker, HANDLERS };
