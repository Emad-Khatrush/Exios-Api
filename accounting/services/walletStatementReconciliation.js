// Reconcile Cashflow, Wallet and the general ledger in one transaction.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Wallet = require('../../models/wallet');
const Statement = require('../../models/userStatement');
const User = require('../../models/user');
const ErrorHandler = require('../../utils/errorHandler');
const { lockWalletOwner } = require('../../utils/walletLock');
const { lockPeriod } = require('./periodLock');
const { runInTransaction } = require('./transaction');
const { logAudit } = require('./audit');
const ledger = require('./walletStatementLedger');
const { getBalance } = require('./carrying');
const { fromMinor, toMinor } = require('./money');

const keyOf = (user, currency) => `${user}:${currency}`;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function preview({ userIds, session, ledgerContext } = {}) {
  const ctx = ledgerContext || await ledger.context({ userIds, session });
  const scope = { currency: { $in: ['USD', 'LYD'] }, ...(userIds && { user: { $in: userIds.map(id => new mongoose.Types.ObjectId(String(id))) } }) };
  const amount = { $convert: { input: '$amount', to: 'double', onError: 0, onNull: 0 } };
  const minor = { $multiply: [amount, 100] };
  const signed = { $cond: [{ $eq: ['$calculationType', '-'] }, -1, 1] };
  const sources = await Statement.aggregate([
    { $match: scope }, { $sort: { _id: 1 } },
    { $group: {
      _id: { user: '$user', currency: '$currency' }, count: { $sum: 1 },
      first: { $first: { _id: '$_id', total: '$total', amount: '$amount', calculationType: '$calculationType' } },
      movementsMinor: { $sum: { $multiply: [signed, { $round: [minor, 0] }] } },
      invalid: { $sum: { $cond: [{ $or: [
        { $not: [{ $isNumber: '$amount' }] }, { $not: [{ $in: ['$calculationType', ['+', '-']] }] },
        { $lt: [amount, 0] }, { $gt: [{ $abs: { $subtract: [minor, { $round: [minor, 0] }] } }, 0.00001] },
      ] }, 1, 0] } },
      lastUpdatedAt: { $max: '$updatedAt' },
    } },
  ]).session(session || null);
  const wallets = await Wallet.find(scope).select('user currency balance updatedAt').sort({ _id: 1 }).session(session || null).lean();
  const groups = new Map();
  const get = (user, currency) => {
    const key = keyOf(user, currency);
    if (!groups.has(key)) groups.set(key, { key, userId: user, currency, wallets: [] });
    return groups.get(key);
  };
  sources.forEach(source => { get(source._id.user, source._id.currency).source = source; });
  wallets.forEach(wallet => { get(wallet.user, wallet.currency).wallets.push(wallet); });
  // Include ledger-only discrepancies too, even when Cashflow and Wallet already agree.
  for (const balance of ctx.balances.values()) {
    const currency = ctx.byId.get(String(balance._id.account))?.currency;
    if (balance._id.partner && ['USD', 'LYD'].includes(currency)) get(balance._id.partner, currency);
  }
  const users = new Map((await User.find({ _id: { $in: Array.from(groups.values()).map(row => row.userId).filter(id => mongoose.isValidObjectId(id)) } })
    .select('firstName lastName customerId').session(session || null).lean()).map(user => [String(user._id), user]));
  const rows = [];
  for (const row of groups.values()) {
    const first = row.source?.first;
    // Same opening balance as recalculateStatementTotals() in the profile:
    // the first INSERTED statement's total, less that statement's signed amount.
    const opening = first ? Number(first.total || 0) - (first.calculationType === '-' ? -1 : 1) * Number(first.amount || 0) : 0;
    const decimals = ctx.currencies.get(row.currency)?.decimals;
    const validCurrency = Number.isInteger(decimals) && decimals >= 2 && decimals <= 4 && ctx.currencies.get(row.currency)?.isActive;
    const scale = validCurrency ? 10 ** (decimals - 2) : 1;
    const openingMinor = Math.round(opening * 100) * scale;
    const movementsMinor = (row.source ? Number(row.source.movementsMinor) : 0) * scale;
    const statementMinor = openingMinor + movementsMinor;
    const walletMinor = row.wallets.reduce((sum, wallet) => sum + (Number.isFinite(wallet.balance) ? toMinor(wallet.balance, validCurrency ? decimals : 2) : NaN), 0);
    const difference = statementMinor - walletMinor;
    const posting = ledger.plan(row.userId, row.currency, statementMinor, ctx);
    if (difference === 0 && posting.ledgerDifference === 0 && !row.source?.invalid && row.wallets.length <= 1) continue;
    const user = users.get(String(row.userId));
    const invalidWallet = row.wallets.some(wallet => !Number.isFinite(wallet.balance) || Math.abs(wallet.balance * 100 - Math.round(wallet.balance * 100)) > 0.00001);
    const blocked = !validCurrency ? 'تعريف العملة أو دقتها غير صالح' : !user ? 'العميل غير موجود' : row.wallets.length > 1 ? 'توجد أكثر من محفظة لنفس العميل والعملة؛ تحتاج مراجعة' :
      !row.source?.count ? 'لا توجد حركات كشف حساب للاعتماد عليها؛ راجع الرصيد الافتتاحي' :
      row.source.invalid || invalidWallet || !Number.isFinite(opening) || Math.abs(opening * 100 - Math.round(opening * 100)) > 0.00001 || !Number.isSafeInteger(openingMinor) || !Number.isSafeInteger(movementsMinor) || !Number.isSafeInteger(statementMinor) || !Number.isSafeInteger(walletMinor)
        ? 'توجد قيم غير صالحة أو تحتاج مراجعة دقة المبالغ في الكشف أو المحفظة' : posting.blocked;
    rows.push({ key: row.key, userId: String(row.userId), currency: row.currency, customer: user || null,
      decimals: validCurrency ? decimals : 2,
      statementMinor: Number.isFinite(statementMinor) ? statementMinor : null,
      walletMinor: Number.isFinite(walletMinor) ? walletMinor : null,
      difference: Number.isFinite(difference) ? difference : null,
      ledgerMinor: posting.ledgerMinor, ledgerDifference: posting.ledgerDifference,
      corrections: posting.corrections, postingDay: posting.postingDay, mode: posting.mode,
      openingMinor, statements: row.source?.count || 0, blocked,
      fingerprint: fingerprint({ version: 2, source: row.source, ledger: posting.signature,
        wallets: row.wallets.map(wallet => ({ id: wallet._id, balance: wallet.balance, updatedAt: wallet.updatedAt })) }),
    });
  }
  rows.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0) || a.key.localeCompare(b.key));
  return { results: rows, count: rows.length, compared: groups.size, asOf: new Date() };
}

async function repair(input, req) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new ErrorHandler(400, 'اختر من محفظة إلى 100 محفظة في الدفعة الواحدة');
  const reason = String(input.reason || '').trim();
  if (!reason || reason.length > 1000) throw new ErrorHandler(400, 'اكتب سبب التصحيح، بحد أقصى 1000 حرف');
  const items = input.items;
  if (items.some(item => !mongoose.isValidObjectId(item.userId) || !['USD', 'LYD'].includes(item.currency) || typeof item.fingerprint !== 'string')) throw new ErrorHandler(400, 'اختيار المحفظة غير صالح');
  const keys = items.map(item => keyOf(item.userId, item.currency));
  if (new Set(keys).size !== keys.length) throw new ErrorHandler(400, 'لا يمكن تكرار المحفظة في الطلب');
  const batchId = crypto.randomUUID();
  return runInTransaction(async session => {
    await lockPeriod(session);
    const userIds = Array.from(new Set(items.map(item => String(item.userId)))).sort();
    for (const id of userIds) await lockWalletOwner(id, session);
    const ctx = await ledger.context({ userIds, session });
    const fresh = new Map((await preview({ userIds, session, ledgerContext: ctx })).results.map(row => [row.key, row]));
    const result = [];
    for (const item of items) {
      const row = fresh.get(keyOf(item.userId, item.currency));
      if (!row || row.fingerprint !== item.fingerprint) throw new ErrorHandler(409, 'تغيرت إحدى المحافظ أو حركات الكشف؛ حدّث القائمة وراجع الاختيار مجددًا');
      if (row.blocked) throw new ErrorHandler(400, row.blocked);
      const before = await Wallet.findOne({ user: row.userId, currency: row.currency }).session(session).lean();
      const entries = await ledger.apply(row, ctx, { session, user: req.user, reason, batchId });
      const after = await Wallet.findOneAndUpdate({ user: row.userId, currency: row.currency }, { $set: { balance: fromMinor(row.statementMinor, row.decimals) } }, { upsert: true, new: true, session, runValidators: true });
      const balance = await getBalance(ctx.roles[`wallet_${row.currency.toLowerCase()}`], { partnerId: row.userId, session });
      if (-balance.foreign !== row.statementMinor) throw new ErrorHandler(409, 'لم تتطابق الدفاتر مع كشف العميل؛ أُلغيت الدفعة كاملة دون تغيير الأرصدة');
      await logAudit({ req, action: 'wallet.cashflow.reconcile', model: 'Wallet', docId: after._id,
        before, after: { wallet: after, batchId, reason, statementCount: row.statements, openingMinor: row.openingMinor,
          version: 2, decimals: row.decimals, previousLedgerMinor: row.ledgerMinor, ledgerMinor: -balance.foreign,
          ledgerDifference: row.ledgerDifference, entries, postingDay: row.postingDay,
          statementMinor: row.statementMinor, previousWalletMinor: row.walletMinor, difference: row.difference, reviewedFingerprint: row.fingerprint } }, session);
      result.push({ userId: row.userId, currency: row.currency, decimals: row.decimals, previous: row.walletMinor, balance: row.statementMinor, difference: row.difference, ledgerMinor: -balance.foreign, entries });
    }
    return { batchId, count: result.length, results: result };
  });
}

module.exports = { preview, repair };
