const mongoose = require('mongoose');
const User = require('../models/user');
const Wallet = require('../models/wallet');
const Statement = require('../models/userStatement');
const Exchange = require('../models/walletExchange');
const ErrorHandler = require('../utils/errorHandler');
const amounts = require('../utils/walletExchangeAmounts');
const accounting = require('../utils/walletExchangeAccounting');

const round = n => Math.round(n * 100) / 100;
const fail = text => new ErrorHandler(400, text);
const staff = user => user?.roles?.isAdmin || user?.roles?.isEmployee || user?.roles?.isAccountant;
function authorize(user) { if (!staff(user)) throw new ErrorHandler(403, 'الصرافة متاحة للموظفين المخولين فقط'); }

async function createExchange(userId, input, actor) {
  authorize(actor);
  if (!mongoose.isValidObjectId(userId)) throw fail('العميل غير صالح');
  const quote = amounts.quote(input);
  const effectiveAt = amounts.operationDate(input.day);
  if (typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey)) throw fail('مرجع العملية غير صالح؛ حدّث الصفحة');
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > 500)) throw fail('الملاحظة يجب ألا تتجاوز 500 حرف');
  const note = (input.note || '').trim();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Serialize exchanges, including first-time creation of the destination wallet.
      const user = await User.findOneAndUpdate({ _id: userId, isCanceled: { $ne: true } },
        { $inc: { walletExchangeVersion: 1 } }, { new: true, session });
      if (!user) throw fail('العميل غير موجود أو حسابه موقوف');
      const existing = await Exchange.findOne({ user: userId, idempotencyKey: input.idempotencyKey }).session(session);
      if (existing) {
        if (existing.fromCurrency !== quote.fromCurrency || existing.fromMinor !== quote.fromMinor || existing.toMinor !== quote.toMinor || existing.rate !== quote.rate || existing.day !== input.day || existing.note !== note) {
          throw new ErrorHandler(409, 'مرجع العملية مستخدم لتحويل مختلف؛ أعد فتح نافذة الصرافة');
        }
        result = { exchange: existing, replayed: true }; return;
      }
      await accounting.assertPeriod(actor, input.day, session);
      const wallets = await Wallet.find({ user: userId, currency: { $in: ['USD', 'LYD'] } }).session(session);
      if (['USD', 'LYD'].some(c => wallets.filter(w => w.currency === c).length > 1)) throw fail('توجد محافظ مكررة لهذا العميل؛ راجعها قبل الصرافة');
      const source = wallets.find(w => w.currency === quote.fromCurrency);
      const amount = quote.fromMinor / 100, received = quote.toMinor / 100;
      if (!source) throw fail('لا يوجد رصيد في محفظة المصدر');
      const from = await Wallet.findOneAndUpdate({ _id: source._id, balance: { $gte: amount } },
        { $inc: { balance: -amount } }, { new: true, session });
      if (!from) throw fail('رصيد محفظة المصدر لا يكفي للصرافة');
      const to = await Wallet.findOneAndUpdate({ user: userId, currency: quote.toCurrency },
        { $inc: { balance: received }, $setOnInsert: { user: userId, currency: quote.toCurrency } }, { new: true, upsert: true, session });
      for (const wallet of [from, to]) await Wallet.updateOne({ _id: wallet._id }, { $set: { balance: round(wallet.balance) } }, { session });
      const [exchange] = await Exchange.create([{ user: userId, createdBy: actor._id, idempotencyKey: input.idempotencyKey,
        ...quote, day: input.day, effectiveAt, note,
        office: [actor.office, actor.city].map(value => String(value || '').trim().toLowerCase())
          .find(value => ['tripoli', 'benghazi', 'turkey', 'china', 'misurata'].includes(value)),
      }], { session });
      const lines = [];
      for (const [currency, value, sign, balance, leg] of [
        [quote.fromCurrency, amount, '-', from.balance, 'from'], [quote.toCurrency, received, '+', to.balance, 'to'],
      ]) {
        const [last] = await Statement.find({ user: userId, currency }).sort({ _id: -1 }).limit(1).session(session);
        const total = round(last ? Number(last.total) + (sign === '-' ? -value : value) : balance);
        const [statement] = await Statement.create([{ user: userId, createdBy: actor._id, createdAt: effectiveAt,
          amount: value, currency, calculationType: sign, total, paymentType: 'wallet', actionType: 'exchange',
          rate: Number(quote.rate), office: exchange.office, note,
          description: `صرافة داخل المحفظة: ${amount.toFixed(2)} ${quote.fromCurrency} مقابل ${received.toFixed(2)} ${quote.toCurrency} — سعر الدولار ${Number(quote.rate)} د.ل`,
          walletExchangeId: exchange._id, walletExchangeLeg: leg,
          accountingSource: { model: 'WalletExchange', id: exchange._id },
        }], { session });
        lines.push(statement);
      }
      exchange.fromStatementId = lines[0]._id; exchange.toStatementId = lines[1]._id;
      await exchange.save({ session });
      await accounting.postExchange(exchange, { session, user: actor });
      // Existing outbox events also cover the two immutable statement records after accounting merges.
      if (accounting.available()) {
        const { emitAccountingEvent } = require('../accounting/services/events');
        for (const line of lines) await emitAccountingEvent('statement', line._id, {}, actor, { session });
      }
      result = { exchange: await Exchange.findById(exchange._id).session(session), replayed: false };
    });
    return result;
  } finally { await session.endSession(); }
}

exports.quote = async (req, res, next) => {
  try { authorize(req.user); res.json({ results: amounts.quote(req.body || {}) }); }
  catch (error) { next(error); }
};
exports.create = async (req, res, next) => {
  try { const result = await createExchange(req.params.id, req.body || {}, req.user); res.status(result.replayed ? 200 : 201).json({ results: result.exchange, replayed: result.replayed }); }
  catch (error) { next(error); }
};
exports.createExchange = createExchange;
