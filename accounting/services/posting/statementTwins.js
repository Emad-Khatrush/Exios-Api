// A payment typed by hand from a bank whose statement already holds that movement (owner's request
// 2026-11-10). The matching page warns when a statement line looks like an entry already in the
// books; this is the same check from the other side. Without it the payment is saved, the line is
// later posted as a new expense, and the cost is in the books twice. So a payment whose amount is
// an unmatched line of its bank, within a week, must say which it is: that line (the payment is
// posted on the line's day and the line matched to it, in one step), or another movement.
const mongoose = require('mongoose');
const { BankStatementLine } = require('../../models/documents');
const { Account } = require('../../models');
const { getConfig } = require('../config');
const { isDay, addDays } = require('../dates');
const { fail } = require('./common');

const DAYS = 7;

// amount: + into the account / - out of it, in the account's currency
async function find(accountId, amount, day, session) {
  if (!mongoose.isValidObjectId(accountId) || !isDay(day) || !Number.isFinite(amount) || !amount) return [];
  const account = await Account.findById(accountId).select('currency isCash').session(session || null).lean();
  if (!account?.isCash) return [];
  const unit = 10 ** ((await getConfig()).currencies.get(account.currency || 'USD')?.decimals ?? 2);
  const lines = await BankStatementLine.find({ accountId, lineStatus: 'unmatched', amount: Math.round(amount * unit),
    day: { $gte: addDays(day, -DAYS), $lte: addDays(day, DAYS) } }).sort({ day: 1, _id: 1 }).limit(10).session(session || null).lean();
  return lines.map(line => ({ _id: line._id, day: line.day, description: line.description, reference: line.reference || '', amount: line.amount / unit }));
}

// movement(input): { accountId, amount } the document moves on a bank by hand, or null
const guarded = (create, movement) => async (input, context) => {
  const move = movement(input || {});
  const twins = move ? await find(move.accountId, move.amount, input.day, context.session) : [];
  let line = null;
  let replay = null;
  if (input?.statementLineId) {
    line = twins.find(twin => String(twin._id) === String(input.statementLineId));
    // The same request sent twice: the line is already matched to the document saved the first time
    if (!line && mongoose.isValidObjectId(input.statementLineId))
      replay = await BankStatementLine.findOne({ _id: input.statementLineId, lineStatus: 'matched' }).session(context.session || null).lean();
    if (!line && !replay) throw fail('سطر الكشف المختار لم يعد متاحًا أو لا يطابق مبلغ الدفعة وحسابها؛ حدّث الصفحة');
    if (line && line.day !== input.day) throw fail(`تاريخ الدفعة يجب أن يكون تاريخ سطر الكشف ${line.day}`);
  } else if (twins.length && !input?.confirmNotInStatement) {
    throw fail(`هذه الحركة موجودة في كشف البنك ولم تُطابق بعد (${twins[0].day} · ${twins[0].description}). اربطها بسطر الكشف حتى لا تُسجَّل مرتين، أو أكّد أنها حركة أخرى.`);
  }
  const doc = await create(input, context);
  if (replay && !(replay.matchedEntryIds || []).some(id => String(id) === String(doc.entryId))) throw fail('سطر الكشف المختار طوبق بعملية أخرى؛ حدّث الصفحة');
  if (line) {
    if (!doc.entryId) throw fail('تعذر ربط الدفعة بسطر الكشف');
    await require('./bank').manualMatch(line._id, [doc.entryId], context);
  }
  return doc;
};

module.exports = { find, guarded, DAYS };
