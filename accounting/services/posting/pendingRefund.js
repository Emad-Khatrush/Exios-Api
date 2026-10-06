const mongoose = require('mongoose');
const { BankStatementLine } = require('../../models/documents');
const { Account } = require('../../models');
const { postEntry } = require('../ledger');
const { logAudit } = require('../audit');
const { getConfig } = require('../config');
const { isDay, addDays } = require('../dates');
const { fail, currencyOf, moneyLine, RateBook, toCurrencyMinor } = require('./common');
async function post(line, { session, req }) {
  if (line.amount <= 0 || line.lineStatus !== 'unmatched' || line.movementKind === 'card_payment') throw fail('اختر استرداداً وارداً غير مرحّل');
  const bank = await Account.findById(line.accountId).session(session).lean();
  const pending = await Account.findOne({ $or: [{ seedKey: '219100' }, { code: '219100' }] }).session(session).lean();
  if (!bank?.isCash || !pending?.isActive || pending.isGroup || pending.type !== 'liability') throw fail('راجع حساب استردادات الموردين قيد التحديد في إعداد الحسابات');
  const rates = new RateBook(session);
  const usd = currencyOf(bank) === 'USD' ? line.amount : Number(line.settlementUsd) > 0 ? Math.round(line.settlementUsd * 100)
    : line.originalCurrency === 'USD' && Number(line.originalAmount) > 0 ? Math.round(line.originalAmount * 100) : await rates.toUsd(line.amount, currencyOf(bank), line.day);
  const entry = await postEntry({ eventType: 'REFUND', eventKey: `PENDING_REFUND:${line._id}:${line.postingAttempt || 0}`, date: line.day,
    description: `استرداد مورد قيد التحديد: ${line.description}`, source: { model: 'AccountingBankStatementLine', id: line._id }, fallbacks: rates.fallbacks,
    lines: [moneyLine(bank, 'debit', line.amount, usd, { label: 'استرداد وارد إلى البنك' }),
      { accountId: pending._id, credit: usd, label: 'استرداد مجهول الطلبية؛ ينتظر تحديد المستفيد' }] }, { session, user: req?.user });
  await rates.lock();
  Object.assign(line, { entryId: entry._id, lineStatus: 'created_entry', movementKind: 'purchase_refund', pendingRefund: true, pendingRefundAccountId: pending._id, valuationUsd: usd / 100 });
  await line.save({ session });
  await logAudit({ req, action: 'bank.pendingRefund', model: 'AccountingBankStatementLine', docId: line._id, after: { entryId: entry._id, usd } }, session);
  return line;
}
async function candidates(input, session, { allDates = false, suggestFractions = false } = {}) {
  if (!mongoose.isValidObjectId(input.accountId) || !isDay(input.day)) return [];
  const bank = await Account.findById(input.accountId).session(session || null).lean();
  if (!bank?.isCash) return [];
  const amount = Number(input.amount) > 0 ? await toCurrencyMinor(input.amount, currencyOf(bank)) : 0;
  const usd = Number(input.usdValue) > 0 ? Math.round(Number(input.usdValue) * 100) : 0;
  if (!amount && !usd) return [];
  const { currencies } = await getConfig();
  const scale = 10 ** (currencies.get(currencyOf(bank))?.decimals ?? 2);
  const nativeFloor = Math.floor(amount / scale) * scale;
  const dollarFloor = Math.floor(usd / 100);
  const matchAmount = {
    $or: [...(amount ? [{ amount: suggestFractions ? { $gte: nativeFloor, $lt: nativeFloor + scale } : amount }] : []),
      ...(usd ? ['valuationUsd', 'settlementUsd'].map(field => ({ [field]: suggestFractions ? { $gte: dollarFloor, $lt: dollarFloor + 1 } : usd / 100 })) : []),
      ...(usd ? [{ originalCurrency: 'USD', originalAmount: suggestFractions ? { $gte: dollarFloor, $lt: dollarFloor + 1 } : usd / 100 }] : []),
      ...(usd && currencyOf(bank) === 'USD' ? [{ amount: suggestFractions ? { $gte: dollarFloor * scale, $lt: (dollarFloor + 1) * scale } : usd }] : [])],
  };
  const rows = await BankStatementLine.find({ accountId: bank._id, customerRefundId: null, receiptId: null,
    $and: [matchAmount, { $or: [{ lineStatus: 'created_entry', pendingRefund: true },
      { lineStatus: 'unmatched', entryId: null, amount: { $gt: 0 }, movementKind: { $ne: 'card_payment' } }] }],
    ...(!allDates && { day: { $gte: addDays(input.day, -7), $lte: addDays(input.day, 7) } }) }).sort({ day: -1 }).session(session || null).lean();
  const merchant = await require('./bankMerchants').matcher(bank._id, session);
  const eligible = rows.filter(line => line.lineStatus === 'created_entry' || line.movementKind === 'purchase_refund'
    || (Number(line.originalAmount) > 0 && line.originalCurrency) || merchant(line));
  const valued = eligible.map(line => ({ ...line, valuationUsd: line.lineStatus === 'created_entry' ? line.valuationUsd
    : currencyOf(bank) === 'USD' ? line.amount / scale : Number(line.settlementUsd) > 0 ? Number(line.settlementUsd)
      : line.originalCurrency === 'USD' && Number(line.originalAmount) > 0 ? Number(line.originalAmount) : undefined }));
  return valued.filter(line => line.amount === amount || (usd && Math.round(line.valuationUsd * 100) === usd)
    || (suggestFractions && ((amount && Math.floor(line.amount / scale) === Math.floor(amount / scale))
      || (usd && Math.floor(Number(line.valuationUsd)) === dollarFloor)))).map(line => ({
    _id: line._id, day: line.day, description: line.description, amount: line.amount / 10 ** (currencies.get(currencyOf(bank))?.decimals ?? 2),
    currency: currencyOf(bank), usdValue: line.valuationUsd, nativeMatch: line.amount === amount, dollarMatch: !!usd && Math.round(line.valuationUsd * 100) === usd,
    unposted: line.lineStatus === 'unmatched',
    nativeIntegerMatch: !!amount && Math.floor(line.amount / scale) === Math.floor(amount / scale),
    dollarIntegerMatch: !!usd && Math.floor(Number(line.valuationUsd)) === dollarFloor,
    amountDifference: amount ? (line.amount - amount) / scale : null,
    usdDifference: usd && Number(line.valuationUsd) > 0 ? (Math.round(line.valuationUsd * 100) - usd) / 100 : null,
  })).sort((a, b) => Number(b.nativeMatch || b.dollarMatch) - Number(a.nativeMatch || a.dollarMatch)
    || b.day.localeCompare(a.day));
}
async function select(input, session, req) {
  const possible = await candidates(input, session);
  if (!input.pendingBankLineId) {
    if (possible.length) throw fail('يوجد استرداد في الكشف يطابق المبلغ؛ اختره واعتمد الربط بدلاً من تكرار استلام البنك');
    return null;
  }
  if (!possible.some(line => String(line._id) === String(input.pendingBankLineId))) throw fail('الاسترداد المعلق لا يطابق البنك والمبلغ والفترة');
  const line = await BankStatementLine.findOneAndUpdate({ _id: input.pendingBankLineId, customerRefundId: null, receiptId: null,
    $or: [{ pendingRefund: true, lineStatus: 'created_entry' }, { lineStatus: 'unmatched', entryId: null, amount: { $gt: 0 }, movementKind: { $ne: 'card_payment' } }] },
    { $inc: { pendingClaimVersion: 1 } }, { session, new: true });
  if (!line) throw fail('تم ربط الاسترداد بطلبية أخرى؛ حدّث القائمة');
  if (line.lineStatus === 'unmatched') await post(line, { session, req });
  return line;
}
module.exports = { post, candidates, select };
