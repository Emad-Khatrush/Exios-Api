// A lost or partly damaged package (owner's request 2026-11-02). An admin or the owner compensates
// the value of its goods from the order page, into the customer's dollar or dinar wallet, with no
// cap: a wallet line 'compensation' (520000 customer compensation / wallet). Shipping is never
// compensated (owner's decision the same day).
//
// The package is then either closed or kept open:
// - closed (always for a lost package; a choice for a damaged one): it can no longer be delivered,
//   the customer is billed only the shipping already paid (the rest is cancelled, like an abandoned
//   package) and its trip cost goes to cost of sales.
// - open (a damaged package): delivered as usual, the customer pays its shipping at delivery.
// The compensation can be undone while the customer still has the money in the wallet.
const mongoose = require('mongoose');
const Order = require('../../models/order');
const UserStatement = require('../../models/userStatement');
const Wallet = require('../../models/wallet');
const ExchangeRate = require('../../models/exchangeRate');
const ErrorHandler = require('../../utils/errorHandler');
const { lockWalletOwner } = require('../../utils/walletLock');
const { JournalEntry } = require('../models');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { logAudit } = require('./audit');
const { isOwner } = require('./access');
const { assertOpenPeriod } = require('./periodGuard');
const { emitAccountingEvent } = require('./events');
const { resolveAccount } = require('./posting/common');
const { shipmentKey, PACKAGE_FEES, packageChargeCents, CLAIM_EVENTS } = require('./claims/keys');

const fail = (message, status = 400) => new ErrorHandler(status, message);
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const TYPE_LABEL = { lost: 'مفقود', damaged: 'تالف جزئياً' };

async function assertManager(user) {
  if (user?.roles?.isAdmin || await isOwner(user)) return;
  throw fail('تعويض الطرود للمدير أو المالك فقط', 403);
}

async function findPackage(orderId, packageId, session) {
  if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(packageId)) throw fail('الطرد غير موجود', 404);
  const order = await Order.findById(orderId).select('orderId user placedAt isCanceled unsureOrder isPayment isFinished orderStatus paymentList').session(session || null).lean();
  const pkg = order?.paymentList?.find((p) => String(p._id) === String(packageId));
  if (!pkg) throw fail('الطرد غير موجود', 404);
  return { order, pkg };
}

// The office name the order's activity log uses
const activityPlace = (order) => (order.placedAt === 'tripoli' ? 'مكتب طرابلس' : order.placedAt === 'benghazi' ? 'مكتب بنغازي' : order.placedAt || '');

const isLive = async () => !!(await getConfig()).settings?.liveEnabled;

// The package's shipping (with its fees) in dollars: paid, and still owed (cancelled if closed).
// Before go-live there is no ledger: a delivered or paid package counts as paid.
async function shippingState(order, pkg) {
  const keys = [shipmentKey(order._id, pkg._id), ...PACKAGE_FEES.map(({ key }) => key(order._id, pkg._id))];
  if (!(await isLive())) {
    const charge = packageChargeCents(pkg);
    const paid = pkg.status?.received || pkg.status?.paid ? charge : 0;
    return { live: false, paidUsd: paid / 100, unpaidUsd: (charge - paid) / 100 };
  }
  const receivable = await resolveAccount('customer_receivable');
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.arKey': { $in: keys } } },
    { $unwind: '$lines' },
    { $match: { 'lines.arKey': { $in: keys }, 'lines.accountId': receivable._id } },
    { $group: { _id: { claim: { $in: ['$eventType', CLAIM_EVENTS] } }, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  const billed = rows.filter((r) => r._id.claim).reduce((s, r) => s + r.net, 0);
  const owed = Math.max(rows.reduce((s, r) => s + r.net, 0), 0);
  return { live: true, paidUsd: Math.max(billed - owed, 0) / 100, unpaidUsd: owed / 100 };
}

// What the dialog needs: the package, its shipping paid and owed, today's dinar rate
async function quote(orderId, packageId, user) {
  const { order, pkg } = await findPackage(orderId, packageId);
  const rate = Number((await ExchangeRate.findOne({ fromCurrency: 'usd' }).lean())?.rate) || null;
  return {
    orderNumber: order.orderId,
    tracking: pkg.deliveredPackages?.trackingNumber || '',
    received: !!pkg.status?.received,
    abandoned: pkg.deliveredPackages?.abandoned?.status || null,
    chargeUsd: packageChargeCents(pkg) / 100,
    ...(await shippingState(order, pkg)),
    rate,
    compensation: pkg.deliveredPackages?.compensation?.type ? pkg.deliveredPackages.compensation : null,
    canManage: !!(user?.roles?.isAdmin || await isOwner(user)),
  };
}

// { type: lost|damaged, currency: USD|LYD, rate (dinars per dollar), goodsAmount (in the wallet's
//   currency), close (a damaged package: close it, else it stays open), reason, note }
async function compensate(orderId, packageId, input, req) {
  await assertManager(req.user);
  const type = input.type;
  if (!TYPE_LABEL[type]) throw fail('اختر: مفقود أو تالف جزئياً');
  const currency = input.currency === 'LYD' ? 'LYD' : input.currency === 'USD' ? 'USD' : null;
  if (!currency) throw fail('اختر محفظة الدولار أو الدينار');
  const rate = currency === 'USD' ? 1 : Number(input.rate);
  if (!(rate > 0)) throw fail('اكتب سعر الدينار مقابل الدولار');
  const goods = round2(input.goodsAmount || 0);
  if (!(goods > 0)) throw fail('اكتب مبلغ تعويض البضاعة');
  const reason = String(input.reason || '').trim();
  if (!reason) throw fail('اكتب سبب التعويض');
  const closed = type === 'lost' || input.close === true;

  return runInTransaction(async (session) => {
    await assertOpenPeriod(req.user, new Date(), { session });
    // Lock the package: a second compensation or a delivery at the same time conflicts and retries
    await Order.updateOne({ _id: oid(orderId), 'paymentList._id': oid(packageId) }, { $inc: { accountingMutationVersion: 1 } }, { session });
    const { order, pkg } = await findPackage(orderId, packageId, session);
    if (order.isCanceled || order.unsureOrder) throw fail('الطلب ملغى أو غير مؤكد');
    if (pkg.deliveredPackages?.compensation?.type) throw fail('عُوِّض هذا الطرد مسبقاً؛ تراجع عن التعويض أولاً لتعديله');
    if (pkg.deliveredPackages?.abandoned?.status) throw fail('الطرد معلن متروكاً');
    if (type === 'lost' && pkg.status?.received) throw fail('الطرد سُلِّم للعميل؛ اختر «تالف جزئياً»');

    const tracking = pkg.deliveredPackages?.trackingNumber || String(pkg._id);
    const what = type === 'lost' ? 'مفقود' : 'تالف';
    const note = `Order Id (${order.orderId}) => تعويض طرد ${what}: ${reason}${input.note ? ` - ${String(input.note).trim()}` : ''}`;

    await lockWalletOwner(order.user, session);
    const wallet = await Wallet.findOneAndUpdate({ user: order.user, currency }, { $inc: { balance: goods } }, { new: true, session });
    if (wallet) await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: round2(wallet.balance) }, { session });
    else await Wallet.create([{ user: order.user, currency, balance: goods }], { session });
    const [last] = await UserStatement.find({ user: order.user, currency }).sort({ _id: -1 }).limit(1).session(session);
    const [statement] = await UserStatement.create([{
      user: order.user, createdBy: req.user, calculationType: '+', paymentType: 'wallet', createdAt: new Date(),
      description: `تعويض قيمة بضاعة طرد ${what} ${tracking} - طلب ${order.orderId}`, note,
      amount: goods, currency, total: round2(Number(last?.total || 0) + goods),
      office: order.placedAt, actionType: 'compensation', ...(currency !== 'USD' && { rate }),
      packageCompensation: { orderId: order._id, packageId: pkg._id },
    }], { session });
    await emitAccountingEvent('statement', statement._id, {}, req.user, { session });

    // Closed and every other package delivered or closed: the order is finished (not 'received':
    // the customer never got it)
    const finishes = closed && !order.isFinished && (order.paymentList || []).every((p) => String(p._id) === String(pkg._id) || p.status?.received || p.deliveredPackages?.compensation?.closed);
    const compensation = {
      type, closed, currency, rate, reason, note: String(input.note || '').trim(),
      goods: { amount: goods, usd: Math.round((goods / rate) * 100) / 100 },
      statementIds: [statement._id], declaredAt: new Date(), declaredBy: req.user._id,
      ...(finishes && { orderBefore: { isFinished: !!order.isFinished, orderStatus: order.orderStatus } }),
    };
    await Order.updateOne({ _id: order._id, 'paymentList._id': pkg._id }, {
      $set: { 'paymentList.$.deliveredPackages.compensation': compensation, ...(finishes && { isFinished: true, orderStatus: order.isPayment ? 5 : 4 }) },
      $push: { activity: { country: activityPlace(order), createdAt: new Date(), description: `تم تعويض العميل عن الطرد ${tracking} (${TYPE_LABEL[type]})${closed ? ' وأُقفل الطرد' : ''}` } },
    }, { session });
    await emitAccountingEvent('order', order._id, {}, req.user, { session });
    if (await isLive()) {
      await require('./posting/operations').postStatement(statement._id, { session, user: req.user });
      await require('./claims/sync').syncOrder(order._id, { session, user: req.user });
    }
    await logAudit({ req, action: 'package.compensate', model: 'Order', docId: order._id, after: { packageId: pkg._id, tracking, ...compensation } }, session);
    return { compensation };
  });
}

// Takes the compensation back: its wallet line is removed (refused once the customer spent the
// money) and the package is as it was
async function undo(orderId, packageId, req) {
  await assertManager(req.user);
  const { removeStatement } = require('../../controllers/wallet');
  return runInTransaction(async (session) => {
    await assertOpenPeriod(req.user, new Date(), { session });
    await Order.updateOne({ _id: oid(orderId), 'paymentList._id': oid(packageId) }, { $inc: { accountingMutationVersion: 1 } }, { session });
    const { order, pkg } = await findPackage(orderId, packageId, session);
    const comp = pkg.deliveredPackages?.compensation;
    if (!comp?.type) throw fail('الطرد غير معوَّض');
    const live = await isLive();
    for (const id of comp.statementIds || []) {
      const statement = await UserStatement.findById(id).session(session);
      if (!statement) continue;
      await lockWalletOwner(statement.user, session);
      const wallet = await Wallet.findOne({ user: statement.user, currency: statement.currency }).session(session).lean();
      if ((wallet?.balance || 0) - Number(statement.amount) < -0.001) {
        throw fail(`رصيد ${statement.currency} في محفظة العميل أقل من التعويض (${statement.amount})؛ صرف العميل جزءاً منه. لا يمكن التراجع.`);
      }
      await removeStatement(statement, req, session);
      if (live) await require('./posting/operations').reverseStatement(statement._id, { session, user: req.user, reason: 'التراجع عن تعويض طرد' });
    }
    await Order.updateOne({ _id: order._id, 'paymentList._id': pkg._id }, {
      $unset: { 'paymentList.$.deliveredPackages.compensation': '' },
      // The order this compensation finished is open again, as it was
      ...(comp.orderBefore && { $set: { isFinished: !!comp.orderBefore.isFinished, ...(comp.orderBefore.orderStatus !== undefined && { orderStatus: comp.orderBefore.orderStatus }) } }),
      $push: { activity: { country: activityPlace(order), createdAt: new Date(), description: `أُلغي تعويض الطرد ${pkg.deliveredPackages?.trackingNumber || pkg._id}` } },
    }, { session });
    await emitAccountingEvent('order', order._id, {}, req.user, { session });
    if (live) await require('./claims/sync').syncOrder(order._id, { session, user: req.user });
    await logAudit({ req, action: 'package.compensateUndo', model: 'Order', docId: order._id, before: comp, after: { packageId: pkg._id } }, session);
    return { compensation: null };
  });
}

// Every compensated package (report)
async function compensatedList() {
  const orders = await Order.find({ 'paymentList.deliveredPackages.compensation.type': { $exists: true } })
    .select('orderId user customerInfo.fullName paymentList._id paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.compensation').lean();
  return orders.flatMap((order) => (order.paymentList || []).filter((p) => p.deliveredPackages?.compensation?.type).map((p) => ({
    orderId: order._id, orderNumber: order.orderId, customer: order.customerInfo?.fullName, packageId: p._id,
    tracking: p.deliveredPackages.trackingNumber, ...p.deliveredPackages.compensation,
  })));
}

module.exports = { quote, compensate, undo, compensatedList, TYPE_LABEL };
