// Reading the system's history for the migration (spec 6-أ): every record that moved money or
// changed what a customer owes, with the fallbacks old data needs (spec 12).
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const Invoice = require('../../../models/invoice');
const Balance = require('../../../models/balance');
const Expense = require('../../../models/expenses');
const Income = require('../../../models/income');
const { CurrencyRate } = require('../../models');
const { toDay } = require('../dates');

const SHIPPING_PAYMENT = /تم دفع قيمة الشحن\s+(.+)/;
const CANCELLATION_REFUND = /واسترجاع قيمة شحن\s+(.+?)\s+إلى المحفظة/;
const CANCELLATION_ORDER = /cancellation\s+(\S+)\s*$/;
const PAYMENT_CANCEL = /الغاء عملية الدفع كود\s+(\S+)/;
const DEBT_PAYMENT = /^Payment for (\w*) debt\s*([^\s#]*)\s*#(.*)$/;
const MANUAL_ORDER = /Order Id \(([^)]+)\)/;
const MATCH_WINDOW_MS = 10 * 60 * 1000;

const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};
const norm = (value) => String(value ?? '').trim().toLowerCase();

// Loads everything once (lean, only needed fields) and prepares lookups
async function loadSources(cutoff) {
  const upTo = { $lte: cutoff };
  const [orders, trips, statements, payments, invoices, balances, expenses, incomes] = await Promise.all([
    Order.find({ createdAt: upTo }).setOptions({ withDeleted: true }).select('orderId user placedAt isPayment isShipment isRemittance unsureOrder isCanceled isDeleted totalInvoice editedAmounts paymentList shipment activity isFinished purchaseItems receivedUSD receivedLYD receivedShipmentUSD receivedShipmentLYD createdAt updatedAt').lean(),
    Inventory.find({ inventoryType: 'inventoryGoods', createdAt: upTo }).select('voyage shippingType inventoryPlace status expenses orders.paymentList._id createdAt arrivalDate').lean(),
    UserStatement.find({ createdAt: upTo }).lean(),
    OrderPaymentHistory.find({ createdAt: upTo }).lean(),
    Invoice.find({ createdAt: upTo }).select('list createdAt isCanceled customer').lean(),
    Balance.find({ createdAt: upTo, balanceType: 'debt' }).lean(),
    Expense.find({ createdAt: upTo }).lean(),
    Income.find({ createdAt: upTo }).lean(),
  ]);

  const ordersById = new Map(orders.map((o) => [String(o._id), o]));
  const ordersByNumber = new Map(orders.map((o) => [String(o.orderId).trim(), o]));
  const packageOwner = new Map();
  orders.forEach((o) => (o.paymentList || []).forEach((p) => packageOwner.set(String(p._id), o)));

  // Delivery time of each package: typed date, then the activity line, then the delivery invoice,
  // then the order's last update (spec 6-أ.5). Each fallback is recorded.
  const invoiceTimeByPackage = new Map();
  invoices.filter((inv) => !inv.isCanceled).forEach((inv) => (inv.list || []).forEach((item) => {
    if (item?.packageId) invoiceTimeByPackage.set(String(item.packageId), inv.createdAt);
  }));
  const deliveries = new Map();
  orders.forEach((order) => (order.paymentList || []).forEach((pkg) => {
    if (!pkg.status?.received) return;
    const tracking = norm(pkg.deliveredPackages?.trackingNumber);
    const typed = validDate(pkg.deliveredPackages?.deliveredInfo?.deliveredDate);
    const activity = tracking && (order.activity || []).find((a) => /استلام العميل الطرد/.test(a.description || '') && norm(a.description).includes(tracking));
    let at = typed && typed >= new Date(order.createdAt) ? typed : null;
    let fallback = null;
    if (!at && activity?.createdAt) { at = new Date(activity.createdAt); fallback = 'تاريخ التسليم من سجل نشاط الطلب'; }
    if (!at && invoiceTimeByPackage.get(String(pkg._id))) { at = new Date(invoiceTimeByPackage.get(String(pkg._id))); fallback = 'تاريخ التسليم من فاتورة التسليم'; }
    if (!at) { at = new Date(order.updatedAt || order.createdAt); fallback = 'تاريخ التسليم غير معروف؛ استُخدم آخر تحديث للطلب'; }
    if (at > cutoff) at = cutoff;
    deliveries.set(String(pkg._id), { at, fallback, orderId: String(order._id) });
  }));

  // The order as it was on a given date (spec 6-أ.6): accepted invoice edits, cancellation and
  // deliveries up to that date. Everything else (prices, weights, packages) is taken as it is now.
  const orderAt = (orderId, date) => {
    const order = ordersById.get(String(orderId));
    if (!order) return null;
    const when = new Date(date);
    const accepted = (order.editedAmounts || []).filter((e) => e.status === 'accepted' && validDate(e.createdAt))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let totalInvoice = order.totalInvoice;
    if (accepted.length) {
      const past = accepted.filter((e) => new Date(e.createdAt) <= when);
      totalInvoice = past.length ? past[past.length - 1].newAmount : accepted[0].oldAmount;
    }
    const canceledAt = order.isCanceled ? new Date(order.updatedAt || order.createdAt) : null;
    return {
      ...order,
      totalInvoice,
      isCanceled: !!(canceledAt && canceledAt <= when),
      paymentList: (order.paymentList || []).map((pkg) => {
        const delivery = deliveries.get(String(pkg._id));
        return { ...pkg, status: { ...(pkg.status || {}), received: !!(delivery && delivery.at <= when) } };
      }),
    };
  };

  // Which claims each wallet payment paid. New statements are linked to their payment record;
  // old ones are matched by customer, currency, amount and time, or read from the description.
  const paymentsByStatement = new Map(payments.filter((p) => p.statementId).map((p) => [String(p.statementId), p]));
  const walletPayments = new Map();
  payments.filter((p) => p.paymentType === 'wallet').forEach((p) => {
    const key = `${p.customer}|${p.currency}`;
    if (!walletPayments.has(key)) walletPayments.set(key, []);
    walletPayments.get(key).push(p);
  });
  const usedPayments = new Set();
  const matchPayment = (statement) => {
    const linked = paymentsByStatement.get(String(statement._id));
    if (linked) return linked;
    // A deduction typed with no order ("Order Id (undefined)") paid no order; one that names an
    // order is matched only to that order's payment
    const named = String(statement.note || '').match(MANUAL_ORDER)?.[1]?.trim();
    if (named === 'undefined' || named === 'null') return undefined;
    const namedOrder = named ? ordersByNumber.get(named) : null;
    const candidates = walletPayments.get(`${statement.user}|${statement.currency}`) || [];
    const time = new Date(statement.createdAt).getTime();
    // The closest in time first: two equal deductions minutes apart each take their own payment
    const found = candidates
      .filter((p) => !usedPayments.has(String(p._id))
        && Math.abs(Number(p.receivedAmount) - Number(statement.amount)) < 0.011
        && Math.abs(new Date(p.createdAt).getTime() - time) <= MATCH_WINDOW_MS
        && (!namedOrder || String(p.order) === String(namedOrder._id)))
      .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - time) - Math.abs(new Date(b.createdAt).getTime() - time))[0];
    if (found) usedPayments.add(String(found._id));
    return found;
  };
  const packageByTracking = (order, tracking) => (order?.paymentList || []).find((p) => norm(p.deliveredPackages?.trackingNumber) === norm(tracking));
  const generalDebts = balances.filter((b) => !b.order || b.debtType === 'general');

  // Old screens gave a payment back to the wallet ("الغاء عملية الدفع كود X واسترجاع القيمة…")
  // without saving the kind of operation. Such a refund undoes one earlier payment of the same
  // customer, amount and currency on the same order: that payment's entry is reversed exactly.
  const debits = new Map();
  statements.filter((s) => s.calculationType === '-').forEach((s) => {
    const key = `${s.user}|${s.currency}`;
    if (!debits.has(key)) debits.set(key, []);
    debits.get(key).push(s);
  });
  debits.forEach((list) => list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  const reversedPayments = new Set();
  const paymentOrderNumber = (s) => String(s.note || '').match(MANUAL_ORDER)?.[1]?.trim()
    || (SHIPPING_PAYMENT.test(String(s.description || '')) ? String(s.note || '').trim() : null)
    || String(s.note || '').match(DEBT_PAYMENT)?.[2]?.trim() || null;
  const originalPayment = (refund, orderNumber) => {
    const found = (debits.get(`${refund.user}|${refund.currency}`) || []).find((s) => !reversedPayments.has(String(s._id))
      && new Date(s.createdAt) <= new Date(refund.createdAt)
      && Math.abs(Number(s.amount) - Number(refund.amount)) < 0.011
      && paymentOrderNumber(s) === orderNumber);
    if (found) reversedPayments.add(String(found._id));
    return found;
  };
  const isPaymentRefund = (statement) => statement.calculationType === '+'
    && (statement.actionType === 'cancellation' || (!statement.actionType && (PAYMENT_CANCEL.test(String(statement.description || '')) || CANCELLATION_REFUND.test(String(statement.description || '')))));

  // Worked out once per statement (matching payments consumes them)
  // What each debt has been paid so far in this run, in the debt's currency (statements are read in
  // time order): a debt paid in full is not given a later payment that carries the same note
  const debtPaid = new Map();
  const pickDebt = (candidates, statement) => {
    if (!candidates.length) return null;
    const open = candidates.find((b) => (debtPaid.get(String(b._id)) || 0) < Number(b.initialAmount || b.amount || 0) - 0.005);
    const debt = open || candidates[0];
    const id = String(debt._id);
    const amount = statement.currency === debt.currency ? Number(statement.amount || 0) : Number(debt.initialAmount || 0);
    debtPaid.set(id, (debtPaid.get(id) || 0) + amount);
    return debt;
  };

  const targets = new Map();
  const statementTarget = (statement) => {
    const id = String(statement._id);
    if (!targets.has(id)) targets.set(id, findTarget(statement));
    return targets.get(id);
  };

  const findTarget = (statement) => {
    const text = String(statement.description || '');
    if (isPaymentRefund(statement)) {
      const refund = text.match(CANCELLATION_REFUND);
      const cancel = text.match(PAYMENT_CANCEL);
      const orderNumber = refund ? String(statement.note || '').match(CANCELLATION_ORDER)?.[1] : cancel?.[1]?.trim();
      const order = orderNumber && ordersByNumber.get(orderNumber);
      const pkg = refund && order ? packageByTracking(order, refund[1].trim()) : null;
      const category = refund || /receivedGoods/.test(statement.note || '') ? 'receivedGoods' : 'invoice';
      const original = orderNumber && originalPayment(statement, orderNumber);
      // Without the original payment the money still goes back on the order's claim
      return {
        kind: 'SETTLEMENT_CANCEL',
        ...(original && { reverses: original._id }),
        ...(order && { orderId: order._id, category, packageIds: pkg ? [pkg._id] : undefined }),
      };
    }
    if (statement.calculationType === '-') {
      if (statement.actionType === 'withdrawal') return null;
      const shipping = text.match(SHIPPING_PAYMENT);
      if (shipping) {
        const order = ordersByNumber.get(String(statement.note || '').trim());
        // The payment the delivery made names its package exactly and carries the rate the dinars
        // were taken at; the tracking text is only a fallback (two packages can share one, "NIL")
        const paid = order && matchPayment(statement);
        const named = (paid?.list || []).map((p) => p?.id || p?._id).filter((id) => id && (order.paymentList || []).some((pkg) => String(pkg._id) === String(id)));
        const pkg = named.length ? null : packageByTracking(order, shipping[1].trim());
        if (order) return { orderId: order._id, packageIds: named.length ? named : pkg ? [pkg._id] : undefined, category: 'receivedGoods', ...(Number(paid?.rate) > 0 && { rate: Number(paid.rate) }) };
      }
      const payment = matchPayment(statement);
      if (payment?.order) {
        return { orderId: payment.order, category: payment.category, packageIds: (payment.list || []).map((p) => p?.id || p?._id).filter(Boolean), ...(Number(payment.rate) > 0 && { rate: Number(payment.rate) }) };
      }
      const debtNote = String(statement.note || '').match(DEBT_PAYMENT);
      // A general debt is found by its note alone. Not when the statement says it paid an invoice
      // or received-goods debt: several debts can carry the same note, and that payment belongs
      // to the order, not to a general debt that happens to be named the same.
      if (/دفع دين/.test(text) && (!debtNote?.[1] || debtNote[1] === 'general')) {
        // Many debts share one note ("7 AED paid in Dubai = 2$"): the order number written on the
        // payment picks the right one, then the first one not paid in full yet
        const paidOrder = debtNote?.[2] ? ordersByNumber.get(debtNote[2]) : null;
        const sameNote = generalDebts.filter((b) => String(b.owner) === String(statement.user) && String(statement.note || '').includes(`#${b.notes}`));
        const ofOrder = paidOrder ? sameNote.filter((b) => String(b.order) === String(paidOrder._id)) : [];
        const debt = pickDebt(ofOrder.length ? ofOrder : sameNote, statement);
        if (debt) return { balanceId: debt._id };
      }
      // A debt paid from another customer's wallet, or a debt tied to an order: found by the
      // order number and the debt's note written on the statement
      if (debtNote) {
        const [, debtType, orderNumber, notes] = debtNote;
        const order = orderNumber ? ordersByNumber.get(orderNumber) : null;
        const candidates = balances.filter((b) => String(b.notes ?? '') === notes
          && (!debtType || b.debtType === debtType)
          && (order ? String(b.order) === String(order._id) : !b.order));
        const own = candidates.filter((b) => String(b.owner) === String(statement.user));
        const debt = pickDebt(own.length ? own : candidates, statement);
        if (debt) return { balanceId: debt._id };
        if (order) return { orderId: order._id, category: debtType === 'invoice' ? 'invoice' : undefined };
      }
      // A deduction typed by hand on the wallet screen with the order number in its note
      const manual = ordersByNumber.get(String(statement.note || '').match(MANUAL_ORDER)?.[1]?.trim() || '');
      if (manual) return { orderId: manual._id };
      // A deduction typed by hand with no order: by what its note says (owner's decision 2026-10-02)
      const note = String(statement.note || '');
      if (/سحب/.test(note)) return { kind: 'WITHDRAWAL' }; // the customer took money out in cash
      if (/نقل\s*داخلي|النقل\s*الداخلي|ديلفري|دليفري|delivery/i.test(note)) return { kind: 'SERVICE_FEE', revenueRole: 'revenue_shipping_domestic' };
      return null;
    }
    const refund = text.match(CANCELLATION_REFUND);
    if (refund) {
      const order = ordersByNumber.get(String(statement.note || '').match(CANCELLATION_ORDER)?.[1] || '');
      const pkg = packageByTracking(order, refund[1].trim());
      if (order) return { orderId: order._id, packageIds: pkg ? [pkg._id] : undefined, category: 'receivedGoods' };
    }
    // A refund from a supplier credited to the wallet (spec E4): when its note names the order
    // ("Order Id (X)" or just the order number) it lowers that order's sale; otherwise 520200
    if (statement.actionType === 'refund') {
      const note = String(statement.note || '');
      const number = note.match(MANUAL_ORDER)?.[1]?.trim() || text.match(MANUAL_ORDER)?.[1]?.trim() || note.trim();
      const order = number && ordersByNumber.get(number);
      return order ? { orderId: order._id } : null;
    }
    const cancel = text.match(PAYMENT_CANCEL);
    if (cancel) {
      const order = ordersByNumber.get(cancel[1].trim());
      if (order) return { orderId: order._id, category: /receivedGoods/.test(statement.note || '') ? 'receivedGoods' : 'invoice' };
    }
    return null;
  };

  const historyStart = [
    ...orders.map((o) => o.createdAt), ...statements.map((s) => s.createdAt), ...payments.map((p) => p.createdAt),
    ...expenses.map((e) => e.createdAt), ...incomes.map((i) => i.createdAt), ...balances.map((b) => b.createdAt),
  ].filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)[0] || cutoff;

  return {
    orders, trips, statements, payments, invoices, balances, expenses, incomes,
    ordersById, packageOwner, deliveries, orderAt, statementTarget, isPaymentRefund, historyStart,
  };
}

// Days with no dinar rate get one derived from the rates written on that day's operations
// (statements, invoices, payments, trip expenses); earlier days get the first known rate.
async function deriveRates(sources, runId) {
  const byDay = new Map();
  const add = (date, rate) => {
    if (!(Number(rate) > 0) || !date) return;
    const day = toDay(date);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(Number(rate));
  };
  sources.statements.filter((s) => s.currency === 'LYD').forEach((s) => add(s.createdAt, s.rate));
  sources.payments.filter((p) => p.currency === 'LYD').forEach((p) => add(p.createdAt, p.rate));
  sources.trips.forEach((t) => (t.expenses || []).filter((e) => e.currency === 'LYD').forEach((e) => add(e.date, e.rate)));
  const invoiceRates = await Invoice.find({ amountLYD: { $gt: 0 }, rate: { $gt: 0 } }).select('rate createdAt').lean();
  invoiceRates.forEach((inv) => add(inv.createdAt, inv.rate));

  const entered = new Set((await CurrencyRate.find({ currency: 'LYD' }).select('day').lean()).map((r) => r.day));
  const derived = [];
  for (const [day, rates] of [...byDay.entries()].sort()) {
    if (entered.has(day)) continue;
    const rate = Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10000) / 10000;
    derived.push({ currency: 'LYD', day, rate, source: 'derived', migrationRunId: runId });
  }
  // The first days of history, before any known rate
  const startDay = toDay(sources.historyStart);
  const known = [...entered, ...derived.map((d) => d.day)].sort();
  if (known.length && known[0] > startDay) {
    const first = derived.find((d) => d.day === known[0]) || await CurrencyRate.findOne({ currency: 'LYD', day: known[0] }).lean();
    derived.push({ currency: 'LYD', day: startDay, rate: first.rate, source: 'derived', migrationRunId: runId });
  }
  if (derived.length) await CurrencyRate.insertMany(derived, { ordered: false });
  return { derived: derived.length, missingEntirely: known.length === 0 };
}

module.exports = { loadSources, deriveRates };
