// Order control (X-Tracking > مراقبة الطلبيات): one row per package of every open order, with its
// stage, how long it has waited, what it costs, where it is, and automatic checks that flag
// packages or orders that look wrong. Read-only: nothing here changes data.
const Orders = require('../models/order');
const Inventory = require('../models/inventory');
const Users = require('../models/user');
const ErrorHandler = require('../utils/errorHandler');

const DAY_MS = 24 * 60 * 60 * 1000;

// Same pickup windows the warehouse page uses: after this many days in Libya a package is overdue
const PICKUP_DAYS = { air: 25, sea: 65 };
// A package sitting in the warehouse abroad longer than this has probably been forgotten
const ABROAD_DAYS = { air: 30, sea: 90 };
// An order with no packages yet, older than this, needs a look
const EMPTY_ORDER_DAYS = 45;

const daysSince = (date, now) => {
  if (!date) return null;
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
};

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
};

// Where a package is: waiting (not at our warehouse abroad yet) > abroad > ready (in Libya) > delivered
const stageOf = (status = {}) => {
  if (status.received) return 'delivered';
  if (status.arrivedLibya) return 'ready';
  if (status.arrived) return 'abroad';
  return 'waiting';
};

module.exports.getOrdersControl = async (req, res, next) => {
  try {
    const now = Date.now();
    const includeDelivered = req.query.includeDelivered === 'true';
    const deliveredDays = Math.min(Math.max(Number(req.query.deliveredDays) || 60, 1), 365);

    // Open orders, plus finished orders that still have an undelivered package (a data problem),
    // plus, when asked, orders finished recently so delivered packages can be reviewed too
    const or = [
      { isFinished: { $ne: true } },
      { isFinished: true, 'paymentList.status.received': false },
    ];
    if (includeDelivered) {
      or.push({ isFinished: true, updatedAt: { $gte: new Date(now - deliveredDays * DAY_MS) } });
    }

    const [orders, warehouses, voyages] = await Promise.all([
      Orders.find(
        { isCanceled: { $ne: true }, unsureOrder: { $ne: true }, $or: or },
        {
          orderId: 1, user: 1, customerInfo: 1, placedAt: 1, shipment: 1, isPayment: 1, isShipment: 1,
          isFinished: 1, hasProblem: 1, hasRemainingPayment: 1, orderStatus: 1, totalInvoice: 1,
          receivedUSD: 1, receivedLYD: 1, createdAt: 1, updatedAt: 1,
          'paymentList._id': 1, 'paymentList.status': 1, 'paymentList.deliveredPackages': 1,
        }
      ).lean(),
      Inventory.find({ inventoryType: 'warehouseInventory' }, { inventoryPlace: 1, 'orders.paymentList._id': 1 }).lean(),
      Inventory.find({ inventoryType: 'inventoryGoods' }, { voyage: 1, shippingType: 1, status: 1, 'orders.paymentList._id': 1 }).lean(),
    ]);

    // Package id -> the office warehouse it sits in / the trip (voyage) it belongs to
    const warehouseOf = new Map();
    warehouses.forEach(warehouse => (warehouse.orders || []).forEach(order => {
      if (order?.paymentList?._id) warehouseOf.set(String(order.paymentList._id), warehouse.inventoryPlace);
    }));
    const voyageOf = new Map();
    voyages.forEach(voyage => (voyage.orders || []).forEach(order => {
      if (order?.paymentList?._id) {
        voyageOf.set(String(order.paymentList._id), { _id: voyage._id, name: voyage.voyage, shippingType: voyage.shippingType });
      }
    }));

    const userIds = Array.from(new Set(orders.map(order => String(order.user)).filter(id => id && id !== 'undefined')));
    const users = await Users.find({ _id: { $in: userIds } }, { customerId: 1, phone: 1, firstName: 1, lastName: 1 }).lean();
    const userOf = new Map(users.map(user => [String(user._id), user]));

    const rows = [];

    orders.forEach(order => {
      const user = userOf.get(String(order.user)) || {};
      const packages = order.paymentList || [];
      const orderAge = daysSince(order.createdAt, now);
      const base = {
        orderMongoId: order._id,
        orderId: order.orderId,
        customerName: order.customerInfo?.fullName || [user.firstName, user.lastName].filter(Boolean).join(' '),
        customerId: user.customerId || '',
        customerMongoId: order.user || null,
        phone: user.phone ? String(user.phone) : (order.customerInfo?.phone || ''),
        office: order.placedAt || '',
        toWhere: order.shipment?.toWhere || '',
        orderType: order.isPayment ? 'purchase' : 'shipment',
        orderCreatedAt: order.createdAt,
        orderAge,
        isFinished: !!order.isFinished,
        hasProblem: !!order.hasProblem,
        hasRemainingPayment: !!order.hasRemainingPayment,
      };

      // Order-wide checks, attached to every row of the order
      const orderIssues = [];
      if (order.hasProblem) orderIssues.push('orderProblem');
      if (order.hasRemainingPayment) orderIssues.push('remainingPayment');
      if (packages.length > 0 && !order.isFinished && packages.every(pkg => pkg.status?.received)) {
        orderIssues.push('deliveredNotFinished');
      }

      if (packages.length === 0) {
        const issues = [...orderIssues];
        if (orderAge !== null && orderAge > EMPTY_ORDER_DAYS) issues.push('emptyOrder');
        rows.push({
          ...base,
          key: `order-${order._id}`,
          stage: 'noPackages',
          method: order.shipment?.method || 'unknown',
          days: orderAge,
          weight: 0,
          unit: '',
          exiosPrice: 0,
          shippingCost: 0,
          issues,
        });
        return;
      }

      packages.forEach(pkg => {
        const delivered = pkg.deliveredPackages || {};
        const status = pkg.status || {};
        const stage = stageOf(status);
        const method = delivered.shipmentMethod || order.shipment?.method || 'unknown';
        const weight = round(delivered.weight?.total, 3);
        const exiosPrice = round(delivered.exiosPrice);
        const packageId = String(pkg._id);
        const warehouse = warehouseOf.get(packageId) || null;
        const voyage = voyageOf.get(packageId) || null;
        const days = stage === 'delivered'
          ? daysSince(delivered.deliveredInfo?.deliveredDate || delivered.arrivedAt, now)
          : daysSince(delivered.arrivedAt || order.createdAt, now);

        const issues = [...orderIssues];
        if (stage === 'ready' && days !== null && days > (PICKUP_DAYS[method] || PICKUP_DAYS.sea)) issues.push('overduePickup');
        if (stage === 'abroad' && days !== null && days > (ABROAD_DAYS[method] || ABROAD_DAYS.sea)) issues.push('stuckAbroad');
        if ((stage === 'ready' || stage === 'delivered') && (!exiosPrice || !weight)) issues.push('noPrice');
        if (stage === 'ready' && !warehouse) issues.push('readyNotInWarehouse');
        if (warehouse && stage !== 'ready') issues.push(stage === 'delivered' ? 'deliveredStillInWarehouse' : 'inWarehouseNotLibya');
        if (order.isFinished && stage !== 'delivered') issues.push('finishedNotDelivered');
        if (!delivered.trackingNumber) issues.push('noTracking');

        rows.push({
          ...base,
          key: packageId,
          packageId,
          stage,
          method,
          days,
          trackingNumber: delivered.trackingNumber || '',
          receiptNo: delivered.receiptNo || '',
          locationPlace: delivered.locationPlace || '',
          boxesCount: delivered.boxesCount || '',
          weight,
          unit: delivered.weight?.measureUnit || '',
          exiosPrice,
          shippingCost: round(exiosPrice * weight),
          arrivedAt: delivered.arrivedAt || null,
          deliveredAt: stage === 'delivered' ? (delivered.deliveredInfo?.deliveredDate || null) : null,
          warehouse,
          voyage,
          issues: Array.from(new Set(issues)),
        });
      });
    });

    res.status(200).json({
      generatedAt: new Date(now),
      includeDelivered,
      deliveredDays,
      rules: { pickupDays: PICKUP_DAYS, abroadDays: ABROAD_DAYS, emptyOrderDays: EMPTY_ORDER_DAYS },
      rows,
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(500, error.message));
  }
};
