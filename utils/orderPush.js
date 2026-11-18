// Tells customers on their phones when a shipment moves on: bought, at our warehouse, on the way
// to Libya, ready for pickup.
//
// Every screen that moves an order sets orderStatus, and the order model stamps
// orderStatusChangedAt whichever way it was written (save, updateOne, updateMany, pipelines). So
// instead of a call in each of those screens, this watches that stamp once a minute: an order whose
// status differs from the last one notified (pushedStatus) gets one notification, after its
// transaction has committed. Claiming pushedStatus with a conditional update means two servers, or
// two ticks, never notify the same change twice.
const Order = require('../models/order');
const { sendToUsers, isPushOn } = require('./push');
const { officeList } = require('./offices');

const TICK_MS = 60 * 1000;
// Changes older than this are not announced (the server was down, or the feature just shipped)
const WINDOW_MS = 3 * 60 * 60 * 1000;
const BATCH = 500;

const OFFICE_NAMES = { tripoli: 'مكتب طرابلس', benghazi: 'مكتب بنغازي', misurata: 'مكتب مصراتة' };

// The stage the customer sees, from the order's status (same steps as the client app's orderUtils)
const stageOf = (order) => {
  const s = Number(order.orderStatus) || 0;
  if (order.isPayment) return ['waiting', 'bought', 'warehouse', 'onTheWay', 'ready'][Math.min(4, s)];
  return ['waiting', 'warehouse', 'onTheWay', 'ready'][Math.min(3, s)];
};

const STAGE_RANK = { waiting: 0, bought: 1, warehouse: 2, onTheWay: 3, ready: 4 };

const officeName = async (code) => {
  if (OFFICE_NAMES[code]) return OFFICE_NAMES[code];
  const office = (await officeList()).find((o) => o.code === code);
  return office && office.name !== code ? office.name : 'المكتب';
};

// One notification per customer and stage: several orders that moved together become one message
const messageFor = async (stage, orders) => {
  const one = orders.length === 1 ? orders[0] : null;
  const n = orders.length;
  const ids = one ? `طلبيتك ${one.orderId}` : `${n} من طلبياتك`;
  const sea = orders.every((o) => o.shipment?.method === 'sea');
  switch (stage) {
    case 'bought':
      return { title: 'اشترينا طلبيتك 🛍️', body: `اشترينا ${ids}، وننتظر وصولها إلى مخزننا.` };
    case 'warehouse':
      return { title: 'وصلت مخزننا 📦', body: `${ids} وصلت مخزننا، وتُشحن إلى ليبيا مع أقرب رحلة.` };
    case 'onTheWay':
      return { title: `في الطريق إلى ليبيا ${sea ? '🚢' : '✈️'}`, body: `${ids} في الطريق إليك. نبلغك عندما تصبح جاهزة للاستلام.` };
    case 'ready': {
      const offices = [...new Set(orders.map((o) => o.placedAt))];
      const where = offices.length === 1 ? ` من ${await officeName(offices[0])}` : '';
      return { title: 'جاهزة للاستلام ✅', body: `${ids} وصلت وجاهزة للاستلام${where}.` };
    }
    default:
      return null;
  }
};

async function tick() {
  const since = new Date(Date.now() - WINDOW_MS);
  const orders = await Order.find({
    orderStatusChangedAt: { $gte: since },
    $expr: { $ne: ['$orderStatus', { $ifNull: ['$pushedStatus', -1] }] },
  })
    .select('_id orderId user orderStatus pushedStatus isPayment isCanceled unsureOrder isFinished shippingBlocked placedAt shipment.method')
    .limit(BATCH)
    .lean();

  const groups = new Map(); // `${user}|${stage}` -> orders
  for (const order of orders) {
    // Claim the change first: whoever sets pushedStatus is the one who announces it
    const claim = await Order.updateOne(
      { _id: order._id, orderStatus: order.orderStatus, pushedStatus: order.pushedStatus ?? { $exists: false } },
      { $set: { pushedStatus: order.orderStatus } },
      { timestamps: false },
    );
    if (!claim.modifiedCount) continue;

    const stage = stageOf(order);
    const before = order.pushedStatus == null ? -1 : STAGE_RANK[stageOf({ ...order, orderStatus: order.pushedStatus })];
    const quiet = !order.user || order.isCanceled || order.unsureOrder || order.isFinished || order.shippingBlocked;
    // Only forward moves are news; a status put back by staff is recorded silently
    if (quiet || stage === 'waiting' || STAGE_RANK[stage] <= before) continue;

    const key = `${order.user}|${stage}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }

  for (const [key, list] of groups) {
    const [user, stage] = key.split('|');
    const message = await messageFor(stage, list);
    if (!message) continue;
    const url = list.length === 1 ? `/order/${list[0]._id}` : (stage === 'ready' ? '/orders?tab=readyForPickup' : '/orders?tab=active');
    await sendToUsers([user], { ...message, url, tag: list.length === 1 ? `order-${list[0]._id}` : `orders-${stage}` });
  }
  return { checked: orders.length, notified: groups.size };
}

let timer = null;
let running = false;
function startOrderPush() {
  if (timer || !isPushOn()) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      console.error('[push] order watcher:', error.message);
    } finally {
      running = false;
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[push] order notifications on');
}

module.exports = { startOrderPush, tick, stageOf, messageFor };
