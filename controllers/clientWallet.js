// The customer's wallet in the client app (owner's request 2026-11-18): what is in the wallet and
// what is owed in each currency (and the net of the two), what the packages on the way will cost
// when collected, and the wallet's movements for the account statement. A customer only ever reads
// their own; staff fields (notes, who recorded a movement, the accounting account, the office or
// box, edit history, review state) never leave the server.
const mongoose = require('mongoose');
const Wallet = require('../models/wallet');
const UserStatement = require('../models/userStatement');
const Balance = require('../models/balance');
const Order = require('../models/order');
const ErrorHandler = require('../utils/errorHandler');
const { packageChargeCents } = require('../accounting/services/claims/keys');

const CURRENCIES = ['USD', 'LYD'];
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const signed = (row) => (row.calculationType === '-' ? -1 : 1) * Number(row.amount || 0);

// A movement's description is shown as plain text (some were saved with HTML line breaks)
const plainText = (value) => String(value || '')
  .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n').trim();

// The kind of a movement, as the admin's statement names it (statementUtils.statementFlow)
const CREDIT_ACTIONS = ['refund', 'compensation', 'cancellation', 'wallet'];
function kindOf(row) {
  if (row.walletExchangeId || row.actionType === 'exchange') return 'exchange';
  if (row.calculationType === '-') return row.actionType === 'withdrawal' || row.paymentType === 'withdrawal' ? 'withdrawal' : 'payment';
  if (!CREDIT_ACTIONS.includes(row.actionType || '')) return 'deposit';
  return row.actionType === 'compensation' ? 'compensation' : row.actionType === 'cancellation' ? 'cancellation' : 'refund';
}

// The statement of one currency, oldest first, each line with the balance after it. The balance is
// the customer's NET position (owner's request 2026-11-18): the wallet's movements and also the
// debts of that currency, so it goes below zero when the customer owes:
// - a wallet movement: + or −, as on the admin's statement
// - a debt (an invoice left on credit): − its first amount, on the day it was created
// - a payment on a debt (from the wallet, in cash, or with an order's payment): + what it took off
//   the debt, in the debt's currency. Paid from the wallet, the wallet's − and this + cancel out.
// - a debt closed by hand: + the remainder written off
// The last balance is then wallet − open debts, the net the page shows. The wallet's part starts
// from the balance before its first movement ever recorded, the same way the admin's statement does
// (exios-admin utils/methods recalculateStatementTotals), so its figures match.
const DEBT_LINE_STATUSES = ['open', 'overdue', 'closed', 'waitingApproval'];
// Said as what it is to the customer: the part of an order's value not paid yet
const DEBT_NAMES = { invoice: 'متبقي من قيمة الشراء', receivedGoods: 'متبقي من قيمة الشحن', general: 'مبلغ متبقي' };

async function debtLinesOf(userId, currency) {
  const debts = await Balance.find({ owner: userId, balanceType: 'debt', currency, status: { $in: DEBT_LINE_STATUSES } })
    .select('_id order amount status initialAmount currency debtType createdAt paymentHistory manualClosure')
    .populate('order', 'orderId')
    .lean();
  const lines = [];
  for (const debt of debts) {
    // Closed with money still on it and not by hand: our side settled it (a claim write-off). The
    // customer is not shown it (owner 2026-11-26): the debt and its payments stay off the statement,
    // so it ends at the net; what was paid from the wallet stays as the wallet's own line.
    if (debt.status === 'closed' && Number(debt.amount || 0) > 0.001 && !(Number(debt.manualClosure?.writtenOffAmount || 0) > 0)) continue;
    const order = debt.order?.orderId ? ` - طلبية ${debt.order.orderId}` : '';
    lines.push({ id: `D${debt._id}`, at: debt.createdAt, description: `${DEBT_NAMES[debt.debtType] || DEBT_NAMES.general}${order}`,
      amount: round2(debt.initialAmount), direction: 'out', kind: 'debt' });
    (debt.paymentHistory || []).forEach((payment, i) => {
      const rate = Number(payment.rate || 0);
      const inDebtCurrency = payment.currency && payment.currency !== debt.currency
        ? (rate > 0 ? Number(payment.amount || 0) / rate : 0)
        : Number(payment.amount || 0);
      if (!(inDebtCurrency > 0)) return;
      lines.push({ id: `P${payment._id || `${debt._id}-${i}`}`, at: payment.createdAt || debt.createdAt, description: `${payment.paymentType === 'points' ? 'سداد المتبقي بالنقاط' : 'سداد المتبقي'}${order}`,
        amount: round2(inDebtCurrency), direction: 'in', kind: 'debtPayment' });
    });
    const writtenOff = Number(debt.manualClosure?.writtenOffAmount || 0);
    if (writtenOff > 0) {
      lines.push({ id: `W${debt._id}`, at: debt.manualClosure.closedAt || debt.createdAt, description: `تسوية المتبقي${order}`,
        amount: round2(writtenOff), direction: 'in', kind: 'writeOff' });
    }
  }
  return lines;
}

async function movementsOf(userId, currency) {
  const [rows, debtLines] = await Promise.all([
    UserStatement.find({ user: userId, currency })
      .select('_id createdAt description amount total calculationType actionType paymentType walletExchangeId').lean(),
    debtLinesOf(userId, currency),
  ]);
  let running = 0;
  if (rows.length) {
    const firstInserted = [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id)))[0];
    running = round2(Number(firstInserted.total || 0) - signed(firstInserted));
  }
  const walletLines = rows.map((row) => ({
    id: String(row._id),
    at: row.createdAt,
    description: plainText(row.description),
    amount: round2(row.amount),
    direction: row.calculationType === '-' ? 'out' : 'in',
    kind: kindOf(row),
  }));
  return [...walletLines, ...debtLines]
    .sort((a, b) => (new Date(a.at) - new Date(b.at)) || String(a.id).localeCompare(String(b.id)))
    .map((line) => {
      running = round2(running + (line.direction === 'out' ? -1 : 1) * line.amount);
      return { ...line, balance: running };
    });
}

// The open debts (unpaid invoices), newest first
async function debtsOf(userId) {
  const debts = await Balance.find({ owner: userId, balanceType: 'debt', status: { $in: ['open', 'overdue'] }, amount: { $gt: 0 } })
    .select('_id order amount initialAmount currency debtType status createdAt')
    .populate('order', 'orderId')
    .sort({ createdAt: -1 })
    .lean();
  return debts.map((debt) => ({
    id: String(debt._id),
    orderId: debt.order?._id ? String(debt.order._id) : null,
    orderNumber: debt.order?.orderId || null,
    amount: round2(debt.amount),
    initialAmount: round2(debt.initialAmount),
    currency: debt.currency,
    type: debt.debtType || 'general',
    overdue: debt.status === 'overdue',
    at: debt.createdAt,
  }));
}

// What the packages not collected yet will cost when collected (dollars): shipping (weight x price,
// as billed at delivery) plus a transport or customs fee. Packages already paid or collected, on a
// cancelled order, hidden from the customer, abandoned or shipped free with no fee are left out. A
// package not weighed or priced yet is counted apart: its cost is known when it is weighed.
async function upcomingOf(userId) {
  const orders = await Order.find({ user: userId, isCanceled: { $ne: true }, 'paymentList.0': { $exists: true } })
    .select('_id orderId paymentList._id paymentList.status paymentList.settings paymentList.freeShippingOffer paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice paymentList.deliveredPackages.domesticFee paymentList.deliveredPackages.customsFee paymentList.deliveredPackages.abandoned')
    .lean();
  const items = [];
  let unpriced = 0;
  for (const order of orders) {
    for (const pkg of order.paymentList || []) {
      if (pkg.status?.received || pkg.status?.paid) continue;
      if (pkg.settings?.visableForClient === false) continue;
      const dp = pkg.deliveredPackages || {};
      if (dp.abandoned?.status) continue;
      const weight = Number(dp.weight?.total || 0);
      const price = Number(dp.exiosPrice || 0);
      const fees = Math.round(Number(dp.domesticFee?.usd || 0) * 100) + Math.round(Number(dp.customsFee?.usd || 0) * 100);
      const free = !!pkg.freeShippingOffer?.enabled;
      const priced = free || (weight > 0 && price > 0);
      if (!priced) { unpriced += 1; continue; }
      const cents = packageChargeCents(pkg) + fees;
      if (cents <= 0) continue;
      items.push({
        orderId: String(order._id),
        orderNumber: order.orderId,
        packageId: String(pkg._id),
        trackingNumber: dp.trackingNumber || '',
        weight: round2(weight),
        unit: dp.weight?.measureUnit || '',
        amount: cents / 100,
        arrived: !!pkg.status?.arrivedLibya,
      });
    }
  }
  items.sort((a, b) => Number(b.arrived) - Number(a.arrived) || b.amount - a.amount);
  return { usd: round2(items.reduce((sum, item) => sum + item.amount, 0)), items, unpriced };
}

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error.statusCode ? error : new ErrorHandler(500, 'تعذّر تحميل المحفظة'));
  }
};

// GET /client/wallet: per currency { wallet, debts, net }, the open debts, and what is coming
module.exports.summary = handle(async (req) => {
  const userId = new mongoose.Types.ObjectId(String(req.user._id));
  const [wallets, debts, upcoming] = await Promise.all([
    Wallet.find({ user: userId }).select('currency balance').lean(),
    debtsOf(userId),
    upcomingOf(userId),
  ]);
  const currencies = {};
  for (const currency of CURRENCIES) {
    const wallet = round2(wallets.filter((w) => w.currency === currency).reduce((sum, w) => sum + Number(w.balance || 0), 0));
    const owed = round2(debts.filter((d) => d.currency === currency).reduce((sum, d) => sum + d.amount, 0));
    currencies[currency] = { wallet, debts: owed, net: round2(wallet - owed) };
  }
  return { currencies, debts, upcoming, netAfterUpcomingUsd: round2(currencies.USD.net - upcoming.usd) };
});

// The part of the statement the app asked for (owner's request 2026-11-24: a customer with many
// movements should not download them all). Every balance is worked out from the whole history first,
// so a part's balances are the same as in the full statement. Lines are oldest first.
// - a period ({ from, to }, two instants): its lines and the balance before its first one
// - a page ({ limit, before }): the `limit` lines just older than the line `before` (or the newest
//   `limit` lines), whether older ones are left, and how many lines there are in all
// - nothing: every line, as the app before this asked
const MAX_PAGE = 100;
function partOf(lines, query = {}) {
  const start = lines.length ? round2(lines[0].balance - (lines[0].direction === 'out' ? -1 : 1) * lines[0].amount) : 0;
  const instant = (value) => {
    if (!value) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new ErrorHandler(400, 'التاريخ غير صحيح');
    return date.getTime();
  };
  const from = instant(query.from);
  const to = instant(query.to);
  if (from !== null || to !== null) {
    const time = (line) => new Date(line.at).getTime();
    const before = from === null ? [] : lines.filter((line) => time(line) < from);
    return {
      rows: lines.filter((line) => (from === null || time(line) >= from) && (to === null || time(line) <= to)),
      opening: before.length ? before[before.length - 1].balance : start,
    };
  }
  if (query.limit !== undefined) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(query.limit)) || 30));
    let end = lines.length;
    if (query.before) {
      const at = lines.findIndex((line) => line.id === String(query.before));
      // The line is gone (a debt cancelled since): nothing older can be placed after it
      end = at < 0 ? 0 : at;
    }
    const begin = Math.max(0, end - limit);
    return { rows: lines.slice(begin, end), hasMore: begin > 0, total: lines.length };
  }
  return { rows: lines };
}

// GET /client/wallet/statement?currency=USD: the wallet's movements of that currency, oldest first;
// &limit=30[&before=<id>] for a page, &from=<ISO>&to=<ISO> for a period
module.exports.statement = handle(async (req) => {
  const currency = String(req.query.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new ErrorHandler(400, 'العملة غير معروفة');
  const userId = new mongoose.Types.ObjectId(String(req.user._id));
  return { currency, ...partOf(await movementsOf(userId, currency), req.query) };
});

module.exports._test = { movementsOf, partOf, debtsOf, upcomingOf, kindOf, plainText };
