// A delivery debt is a reminder of the package's existing SHP claim, never a second sale.
const Balance = require('../models/balance');
const Order = require('../models/order');
const Invoice = require('../models/invoice');
const Payment = require('../models/orderPaymentHistory');
const ErrorHandler = require('./errorHandler');
const { emitAccountingEvent } = require('../accounting/services/events');
const round = value => Math.round(Number(value) * 100) / 100;
const cents = value => Math.round(Number(value) * 100);
const fail = message => new ErrorHandler(400, message);

async function prepare(input, total, wallet, user, session) {
  if (!(user.roles?.isAdmin || user.roles?.isAccountant)) throw new ErrorHandler(403, 'التسليم مع دين متبقٍ متاح للأدمن أو المحاسب فقط');
  if (!Number.isFinite(total) || total < 0) throw fail('راجع أسعار الطرود ورسومها قبل التسليم');
  const amountUSD = round(input.amountUSD || 0), amountLYD = round(input.amountLYD || 0);
  if (![amountUSD, amountLYD].every(Number.isFinite) || amountUSD < 0 || amountLYD < 0) throw fail('راجع المبالغ المدفوعة');
  let rate = 0;
  if (amountLYD) {
    const limits = await require('../accounting/services/walletRate').lydRateLimits(new Date());
    rate = Number(input.rate);
    if (!(rate > 0) || !Number.isFinite(rate)) throw fail('أدخل سعر صرف صحيحًا للدفع الجزئي بالدينار');
    if (limits && rate < limits.minimum - 1e-9) throw fail(`سعر الصرف أقل من الحد المسموح ${limits.minimum}`);
  }
  if (amountUSD > Number(wallet.USD || 0) + 0.001 || amountLYD > Number(wallet.LYD || 0) + 0.001) throw fail('رصيد المحفظة لا يكفي للمبلغ المدفوع');
  const covered = round(amountUSD + (amountLYD ? amountLYD / rate : 0));
  if (covered > total + 0.001) throw fail('الدفعة أكبر من إجمالي الطرود المحددة');
  await require('../accounting/services/periodGuard').assertOpenPeriod(user, new Date(), { session });
  return { amountUSD, amountLYD, rate, covered };
}

async function refresh(invoiceId, session) {
  const invoice = await Invoice.findById(invoiceId).session(session);
  if (!invoice?.partialDelivery) return;
  const debts = await Balance.find({ deliveryInvoiceId: invoice._id, status: { $ne: 'canceled' } }).session(session).lean();
  const payments = await Payment.find({ deliveryInvoiceId: invoice._id }).session(session).lean();
  const remainingUSD = round(debts.reduce((sum, debt) => sum + (['open', 'overdue'].includes(debt.status) ? Number(debt.amount || 0) : 0), 0));
  const writtenOffUSD = round(debts.reduce((sum, debt) => sum + Number(debt.manualClosure?.writtenOffAmount || 0), 0));
  const paidUSD = round(payments.filter(p => p.currency === 'USD').reduce((sum, p) => sum + p.receivedAmount, 0));
  const paidLYD = round(payments.filter(p => p.currency === 'LYD').reduce((sum, p) => sum + p.receivedAmount, 0));
  const paidEquivalentUSD = round(payments.reduce((sum, p) => sum + (p.currency === 'USD' ? p.receivedAmount : p.receivedAmount / p.rate), 0));
  invoice.settlement = { paidUSD, paidLYD, paidEquivalentUSD, remainingUSD, writtenOffUSD,
    paymentStatus: invoice.isCanceled ? 'canceled' : remainingUSD > 0 ? paidEquivalentUSD > 0 ? 'partial' : 'unpaid' : writtenOffUSD ? 'settled' : 'paid' };
  for (const pkg of invoice.list) {
    const packagePayments = payments.filter(payment => String(payment.deliveryPackageId) === String(pkg.packageId));
    pkg.paidUSD = round(packagePayments.filter(payment => payment.currency === 'USD').reduce((sum, payment) => sum + Number(payment.receivedAmount), 0));
    pkg.paidLYD = round(packagePayments.filter(payment => payment.currency === 'LYD').reduce((sum, payment) => sum + Number(payment.receivedAmount), 0));
    pkg.remainingUSD = round(debts.filter(debt => String(debt.deliveryPackageId) === String(pkg.packageId) && ['open', 'overdue'].includes(debt.status)).reduce((sum, debt) => sum + Number(debt.amount || 0), 0));
    const outstanding = debts.some(debt => String(debt.deliveryPackageId) === String(pkg.packageId) && Number(debt.amount) > 0 && ['open', 'overdue'].includes(debt.status));
    if (!pkg.canceledAt) await Order.updateOne({ orderId: pkg.orderId, paymentList: { $elemMatch: { _id: pkg.packageId, creditDeliveryInvoiceId: invoice._id } } }, { $set: { 'paymentList.$.status.paid': !outstanding } }, { session });
  }
  invoice.markModified('list');
  await invoice.save({ session });
  return invoice;
}

async function deliver({ req, res, next, customerId, packages, totalCost, payment, session }) {
  const helpers = require('./helperApi');
  const orders = await Order.find({ orderId: { $in: packages.map(pkg => pkg.orderId) } }).session(session).lean();
  if (orders.some(order => order.unsureOrder || order.isCanceled || order.isDeleted) || packages.some(pkg => !Number.isFinite(pkg.cost) || pkg.cost < 0)) throw fail('راجع اعتماد الطلبية وأسعار الطرود قبل التسليم على الحساب');
  const byNumber = new Map(orders.map(order => [order.orderId, order]));
  const selectedIds = new Set(packages.map(pkg => String(pkg.id)));
  const selectedTracking = new Set(packages.map(pkg => pkg.trackingNumber).filter(Boolean));
  const priorPayments = await Payment.find({ order: { $in: orders.map(order => order._id) }, category: 'receivedGoods', receivedAmount: { $gt: 0 } }).session(session).lean();
  if (priorPayments.some(payment => !payment.list?.length || payment.list.some(item => selectedIds.has(String(item.id || item._id || '')) || (item.trackingNumber && selectedTracking.has(item.trackingNumber))))) {
    throw fail('توجد دفعات شحن سابقة لهذه الطرود؛ راجعها قبل التسليم الجزئي حتى لا تُحسب دفعة أو مديونية مرتين');
  }
  const oldDebt = await Balance.exists({ order: { $in: orders.map(order => order._id) }, debtType: 'receivedGoods', balanceType: 'debt', status: { $in: ['open', 'overdue'] }, amount: { $gt: 0 }, deliveryInvoiceId: { $exists: false } }).session(session);
  if (oldDebt) throw fail('توجد ديون شحن سابقة غير مرتبطة بطرود محددة لهذه الطلبية؛ راجعها قبل التسليم الجزئي لمنع تكرار الدين');
  const invoice = await helpers.createInvoice(req.user, customerId, packages, payment, totalCost, session);
  invoice.partialDelivery = true; await invoice.save({ session });
  for (const pkg of packages) await Order.updateOne({ orderId: pkg.orderId, 'paymentList._id': pkg.id }, { $set: { 'paymentList.$.creditDeliveryInvoiceId': invoice._id } }, { session });
  await helpers.updateOrderStatuses(packages, session);
  const settings = await require('../accounting/services/periodLock').lockPeriod(session);
  if (settings?.liveEnabled) for (const order of orders) await require('../accounting/services/claims/sync').syncOrder(order._id, { session, user: req.user, date: new Date() });
  let dollars = cents(payment.amountUSD), dinars = cents(payment.amountLYD);
  for (const pkg of packages) {
    const order = byNumber.get(pkg.orderId);
    const due = cents(pkg.cost);
    const usd = Math.min(dollars, due); dollars -= usd;
    const needed = due - usd;
    const lyd = needed && dinars ? Math.min(dinars, Math.round(needed * payment.rate)) : 0; dinars -= lyd;
    const paid = usd + (lyd ? Math.min(needed, Math.round(lyd / payment.rate)) : 0);
    const arKeys = pkg.payKeys || [`SHP:${order._id}:${pkg.id}`];
    const payable = { ...pkg, deliveryInvoiceId: invoice._id, payKeys: arKeys };
    for (const [minor, currency] of [[usd, 'USD'], [lyd, 'LYD']]) if (minor) {
      await helpers.useWalletBalance(req, res, next, customerId, payable, minor / 100, currency, payment.rate, false, session);
    }
    const remaining = Math.max(0, due - paid) / 100;
    if (remaining) {
      const [debt] = await Balance.create([{ owner: customerId, createdBy: req.user._id, createdOffice: order.placedAt,
        order: order._id, balanceType: 'debt', debtType: 'receivedGoods', source: { kind: 'order' }, followsOrder: true,
        currency: 'USD', amount: remaining, initialAmount: remaining, status: 'open',
        deliveryInvoiceId: invoice._id, deliveryPackageId: pkg.id, deliveryClaimKeys: arKeys,
        notes: `متبقي فاتورة تسليم #0${invoice.referenceId} · طلب ${pkg.orderId} · تتبع ${pkg.trackingNumber || pkg.id}` }], { session });
      await emitAccountingEvent('balance', debt._id, {}, req.user, { session });
    }
  }
  if (dollars || dinars) throw fail('تعذر توزيع الدفعة على الطرود بدقة؛ راجع المبلغ وسعر الصرف');
  const settledInvoice = await refresh(invoice._id, session);
  await require('../accounting/services/audit').logAudit({ req, action: 'delivery.partial', model: 'Invoice', docId: invoice._id, after: settledInvoice }, session);
  return settledInvoice;
}

async function cancelPackage(user, invoice, pkg, session) {
  const debts = await Balance.find({ deliveryInvoiceId: invoice._id, deliveryPackageId: pkg.packageId }).session(session);
  if (debts.some(debt => debt.manualClosure?.writtenOffAmount || debt.status === 'lost')) throw fail('راجع تسوية شطب الدين قبل إلغاء تسليم هذا الطرد');
  const payments = await Payment.find({ deliveryInvoiceId: invoice._id, deliveryPackageId: pkg.packageId }).session(session);
  const refunds = [];
  for (const payment of payments) {
    const amount = await require('./helperApi').refundWalletPayment(user, payment, `إلغاء تسليم الطرد ${pkg.trackingNumber || ''} من الفاتورة #0${invoice.referenceId}`, `إلغاء فاتورة تسليم #0${invoice.referenceId}`, session);
    refunds.push({ currency: payment.currency, amount });
  }
  await Balance.updateMany({ deliveryInvoiceId: invoice._id, deliveryPackageId: pkg.packageId }, { $set: { amount: 0, status: 'canceled', deliveryCanceledAt: new Date() } }, { session });
  await Order.updateOne({ orderId: pkg.orderId, 'paymentList._id': pkg.packageId }, { $unset: { 'paymentList.$.creditDeliveryInvoiceId': 1 }, $set: { 'paymentList.$.status.paid': false } }, { session });
  return refunds;
}
module.exports = { prepare, deliver, refresh, cancelPackage };
