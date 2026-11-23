// A tracking number typed by staff that is already somewhere else: a package waiting in a customer's
// "طرود منتظرة" (an unsure order the customer opened by reporting the number), or a package of
// another order. Staff are warned, never stopped (owner's request 2026-11-24), and a waiting package
// of the same customer is linked: it leaves the waiting order once the real order is saved.
const Orders = require('../models/order');
const Activities = require('../models/activities');

const MAX_NUMBERS = 100;

// The same number however it was typed: no spaces, any case
const normalize = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Matches the stored number with spaces anywhere and in any case
const pattern = (number) => new RegExp(`^\\s*${[...number].map(escape).join('\\s*')}\\s*$`, 'i');

const numbersOf = (list) => [...new Set((list || []).map(normalize).filter(Boolean))].slice(0, MAX_NUMBERS);

// Every package elsewhere carrying one of these numbers. The order being edited is left out.
const findMatches = async (numbers, { excludeOrderId, session } = {}) => {
  const wanted = numbersOf(numbers);
  if (!wanted.length) return [];
  const filter = { 'paymentList.deliveredPackages.trackingNumber': { $in: wanted.map(pattern) } };
  if (excludeOrderId) filter._id = { $ne: excludeOrderId };
  const orders = await Orders.find(filter)
    .select('orderId user unsureOrder isCanceled isFinished isPayment customerInfo.fullName paymentList._id paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.shipmentMethod paymentList.status.received')
    .populate('user', 'customerId firstName lastName')
    .limit(50)
    .session(session || null)
    .lean();
  const matches = [];
  for (const order of orders) {
    for (const pkg of order.paymentList || []) {
      const number = normalize(pkg.deliveredPackages?.trackingNumber);
      if (!wanted.includes(number)) continue;
      matches.push({
        trackingNumber: number,
        orderObjectId: String(order._id),
        orderId: order.orderId,
        unsureOrder: !!order.unsureOrder,
        isCanceled: !!order.isCanceled,
        isFinished: !!order.isFinished,
        isPayment: !!order.isPayment,
        received: !!pkg.status?.received,
        // For a waiting package, the method the customer chose when reporting it (air, sea, unknown)
        shipmentMethod: pkg.deliveredPackages?.shipmentMethod || null,
        customer: order.user ? {
          _id: String(order.user._id),
          customerId: order.user.customerId,
          name: [order.user.firstName, order.user.lastName].filter(Boolean).join(' '),
        } : null,
      });
    }
  }
  return matches;
};

// The order was saved as a real order: its customer's waiting packages with the same numbers leave
// their waiting orders, and a waiting order left with no package goes away. Another customer's
// waiting package is never touched (staff only see a warning for it).
const linkWaitingPackages = async (order, { user, session } = {}) => {
  if (!order || order.unsureOrder || order.isCanceled || !order.user) return [];
  const wanted = numbersOf((order.paymentList || []).map((pkg) => pkg.deliveredPackages?.trackingNumber));
  if (!wanted.length) return [];
  const customer = order.user._id || order.user;
  const waiting = await Orders.find({
    _id: { $ne: order._id },
    user: customer,
    unsureOrder: true,
    'paymentList.deliveredPackages.trackingNumber': { $in: wanted.map(pattern) },
  }).session(session || null);

  const linked = [];
  for (const pending of waiting) {
    const keep = [];
    for (const pkg of pending.paymentList || []) {
      const number = normalize(pkg.deliveredPackages?.trackingNumber);
      if (wanted.includes(number) && !pkg.status?.received) linked.push({ trackingNumber: number, from: pending.orderId });
      else keep.push(pkg);
    }
    if (keep.length === (pending.paymentList || []).length) continue;
    if (keep.length) await Orders.updateOne({ _id: pending._id }, { $set: { paymentList: keep } }, { session });
    else await Orders.deleteOne({ _id: pending._id }, { session });
  }
  if (linked.length) {
    await Activities.create([{
      user,
      details: { path: '/invoices', status: 'updated', type: 'order', actionId: String(order._id) },
      changedFields: linked.map(({ trackingNumber, from }) => ({
        label: 'ربط طرد منتظر',
        value: trackingNumber,
        changedFrom: `طرد منتظر ${from}`,
        changedTo: `الفاتورة ${order.orderId}`,
      })),
    }], { session });
  }
  return linked;
};

module.exports = { normalize, findMatches, linkWaitingPackages, MAX_NUMBERS };
