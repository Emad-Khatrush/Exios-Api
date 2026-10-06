// Moving an order from A000 (the placeholder customer) to its real customer (spec 19.10,
// owner's decision 63). The order's claims and payments follow it automatically (syncOrder
// re-posts them on their own dates). The wallet lines A000 has for the shipment (a deposit made
// for it, the payment taken from it) are only listed: the staff member picks which to move, and
// each picked line changes owner, both wallets and running totals are corrected, and its entry is
// posted again for the new customer on its own date (the old pair is hidden).
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const Order = require('../../models/order');
const User = require('../../models/user');
const UserStatement = require('../../models/userStatement');
const Wallet = require('../../models/wallet');
const OrderPaymentHistory = require('../../models/orderPaymentHistory');
const ErrorHandler = require('../../utils/errorHandler');
const { getConfig } = require('./config');
const { runInTransaction } = require('./transaction');
const { resolveAccount } = require('./roles');
const { lockWalletOwner } = require('../../utils/walletLock');
const { assertOpenPeriod } = require('./periodGuard');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n) => Math.round(n * 100) / 100;
const signed = (s) => (s.calculationType === '-' ? -1 : 1) * Number(s.amount || 0);

// The customers the order belonged to before: whoever its claims were posted on, and A000
async function previousCustomers(order, session) {
  const receivable = await resolveAccount('customer_receivable').catch(() => null);
  const fromBooks = receivable
    ? await JournalEntry.distinct('lines.partnerId', { lines: { $elemMatch: { orderId: order._id, accountId: receivable._id } } }).session(session || null)
    : [];
  const placeholders = await User.find({ customerId: { $in: ['A000', 'a000'] } }).select('_id').session(session || null).lean();
  return [...new Set([...fromBooks.filter(Boolean).map(String), ...placeholders.map((u) => String(u._id))])]
    .filter((id) => id !== String(order.user));
}

// Wallet lines of the previous customers that belong to this order
async function movableStatements(orderId, { session } = {}) {
  if (!mongoose.isValidObjectId(orderId)) throw new ErrorHandler(400, 'الطلب غير موجود');
  const order = await Order.findById(orderId).select('orderId user createdAt').session(session || null).lean();
  if (!order) throw new ErrorHandler(404, 'الطلب غير موجود');
  const previous = await previousCustomers(order, session);
  const placeholders = (await User.find({ customerId: { $in: ['A000', 'a000'] } }).select('_id').session(session || null).lean()).map((u) => String(u._id));
  if (!previous.length) return { orderId: order.orderId, results: [] };

  const payments = await OrderPaymentHistory.find({ order: order._id, statementId: { $ne: null } }).select('statementId').session(session || null).lean();
  const posted = await JournalEntry.distinct('source.id', { 'source.model': 'UserStatement', 'lines.orderId': order._id }).session(session || null);
  const linked = [...payments.map((p) => p.statementId), ...posted].filter(Boolean).map(String);
  const mention = new RegExp(escapeRegex(order.orderId), 'i');
  const statements = await UserStatement.find({
    user: { $in: previous.map(oid) },
    $or: [
      { _id: { $in: linked.map(oid) } }, { description: mention }, { note: mention },
      // A deposit to A000 rarely names the order: its deposits from a month before the order on are
      // offered too, so the one this customer made can be moved with the payment it paid
      { user: { $in: placeholders.map(oid) }, calculationType: '+', actionType: { $nin: ['cancellation', 'wallet'] }, createdAt: { $gte: new Date(new Date(order.createdAt || Date.now()).getTime() - 30 * 86400000) } },
    ],
  }).sort({ createdAt: 1 }).populate('user', 'firstName lastName customerId').session(session || null).lean();
  return {
    orderId: order.orderId,
    results: statements.map((s) => ({
      _id: s._id, date: s.createdAt, description: s.description, note: s.note, amount: s.amount, currency: s.currency,
      calculationType: s.calculationType, customer: s.user, linked: linked.includes(String(s._id)),
    })),
  };
}

// Puts back the stored running totals of one wallet in insert order (as the wallet screens do)
async function rebuildTotals(userId, currency, opening, session) {
  const rows = await UserStatement.find({ user: userId, currency }).sort({ _id: 1 }).select('amount calculationType total').session(session).lean();
  let running = opening;
  const updates = [];
  rows.forEach((row) => {
    running = round2(running + signed(row));
    if (row.total !== running) updates.push({ updateOne: { filter: { _id: row._id }, update: { $set: { total: running } } } });
  });
  if (updates.length) await UserStatement.bulkWrite(updates, { session });
}

async function openingOf(userId, currency, session) {
  const first = await UserStatement.findOne({ user: userId, currency }).sort({ _id: 1 }).select('amount calculationType total').session(session).lean();
  return first ? round2(Number(first.total || 0) - signed(first)) : 0;
}

async function moveStatements(orderId, statementIds, req) {
  const ids = [...new Set((statementIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) throw new ErrorHandler(400, 'اختر سطراً واحداً على الأقل');
  return runInTransaction(async (session) => {
    const { results } = await movableStatements(orderId, { session });
    const allowed = new Set(results.map((r) => String(r._id)));
    if (ids.some((id) => !allowed.has(id))) throw new ErrorHandler(400, 'بعض السطور ليست من سطور العميل السابق لهذا الطلب');
    const order = await Order.findById(orderId).select('orderId user').session(session).lean();
    const { settings } = await getConfig().catch(() => ({ settings: null }));
    const live = !!settings?.liveEnabled;

      await Order.updateOne({ _id: order._id }, { $inc: { accountingMutationVersion: 1 } }, { session });
      const statements = await UserStatement.find({ _id: { $in: ids.map(oid) } }).session(session).lean();
      for (const s of statements) await assertOpenPeriod(req.user, s.createdAt, { session });
      for (const id of [...new Set([String(order.user), ...statements.map(s => String(s.user))])].sort()) await lockWalletOwner(id, session);
      const wallets = new Map();
      statements.forEach((s) => wallets.set(`${s.user}|${s.currency}`, null).set(`${order.user}|${s.currency}`, null));
      for (const key of wallets.keys()) {
        const [user, currency] = key.split('|');
        wallets.set(key, await openingOf(user, currency, session));
      }

      for (const s of statements) {
        await UserStatement.updateOne({ _id: s._id }, {
          $set: { user: order.user },
          $push: { editHistory: { editedBy: req.user?._id, editedAt: new Date(), before: { user: s.user, reason: `نقل مع الطلب ${order.orderId}` } } },
        }, { session });
        await Wallet.updateOne({ user: s.user, currency: s.currency }, { $inc: { balance: -signed(s) } }, { session });
        await Wallet.updateOne({ user: order.user, currency: s.currency }, { $inc: { balance: signed(s) } }, { session, upsert: true });
        await OrderPaymentHistory.updateMany({ statementId: s._id }, { $set: { customer: order.user } }, { session });
      }
      for (const [key, opening] of wallets) {
        const [user, currency] = key.split('|');
        await rebuildTotals(oid(user), currency, opening, session);
        const wallet = await Wallet.findOne({ user, currency }).session(session);
        // Moving a payment without the deposit it was paid from would leave one wallet below zero
        if (wallet && wallet.balance < -0.001) {
          throw new ErrorHandler(400, `نقل هذه السطور يجعل محفظة ${currency} لأحد العميلين سالبة. انقل معها سطر الإيداع الذي دُفعت منه.`);
        }
        if (wallet) await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { $set: { balance: round2(wallet.balance) } }, { session });
      }

      let reposted = 0;
      if (live) {
        // Loaded here: posting pulls in the claims engine, which loads this module's neighbours
        const { repostStatement } = require('./posting/operations');
        const { syncOrder } = require('./claims/sync');
        for (const s of statements) {
          const before = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': s._id, status: 'posted', reversalOf: null }).select('_id lines.arKey').session(session).lean();
          // The claims it paid stay the claims it pays
          const arKeys = [...new Set(before.flatMap((e) => e.lines.map((l) => l.arKey)).filter(Boolean))];
          await repostStatement(s._id, { session, user: req.user, ...(arKeys.length && { target: { arKeys } }) });
          const old = before.map((e) => e._id);
          await JournalEntry.updateMany({ $or: [{ _id: { $in: old } }, { reversalOf: { $in: old } }] }, { $set: { hiddenWithCancel: true } }, { session });
          reposted += 1;
        }
        await syncOrder(order._id, { session, user: req.user });
      }
      return { moved: statements.length, reposted };
  });
}

module.exports = { movableStatements, moveStatements };
