const moment = require('moment-timezone');
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { RateBook, decimalsOf, moneyLine } = require('./posting/common');
const { roundHalfAway } = require('./money');
const { TZ, isDay } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');

const METHODS = ['legacy', 'receipts_1m', 'receipts_2m', 'receipts_12m', 'receipts_all'];
function validateMethod(method) {
  if (!METHODS.includes(method)) throw new ErrorHandler(400, 'اختر مدة احتساب متوسط افتتاح الخزائن');
  return method;
}

// A weighted estimate of this account's incoming money, not an arithmetic mean
// of rates and not a recalculation of live payments or closed reporting periods.
async function estimate(account, day, method, { session, rates = new RateBook(session) } = {}) {
  validateMethod(method);
  if (!isDay(day)) throw new ErrorHandler(400, 'تاريخ تقييم الافتتاحي غير صالح');
  if (method === 'legacy') return { method, source: 'legacy' };
  const currency = account.currency || 'USD';
  if (currency === 'USD') return { method, rate: 1, source: 'usd', sampleCount: 0, sampleForeign: 0, sampleUsd: 0, to: day };
  const months = { receipts_1m: 1, receipts_2m: 2, receipts_12m: 12 }[method];
  const from = months ? moment.tz(day, 'YYYY-MM-DD', TZ).subtract(months, 'months').add(1, 'day').format('YYYY-MM-DD') : undefined;
  const match = { status: 'posted', reversalOf: null,
    eventType: { $nin: ['OPENING_CASH', 'CASHCOUNT', 'MANUAL', 'CANCEL', 'REVERSAL', 'FX_REVALUATION', 'YEAR_CLOSE'] },
    day: { ...(from ? { $gte: from } : {}), $lte: day }, 'lines.accountId': new mongoose.Types.ObjectId(String(account._id)) };
  const [sample] = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': match['lines.accountId'], 'lines.currency': currency,
      'lines.amountCurrency': { $gt: 0 }, 'lines.debit': { $gt: 0 }, 'lines.credit': 0 } },
    { $group: { _id: null, foreign: { $sum: '$lines.amountCurrency' }, usd: { $sum: '$lines.debit' }, count: { $sum: 1 } } },
  ]).session(session || null);
  const decimals = await decimalsOf(currency);
  if (sample?.foreign > 0 && sample.usd > 0) {
    return { method, from, to: day, source: 'receipts', rate: (sample.foreign / 10 ** decimals) / (sample.usd / 100),
      sampleCount: sample.count, sampleForeign: sample.foreign, sampleUsd: sample.usd };
  }
  return { method, from, to: day, source: 'count_day_fallback', rate: await rates.rate(currency, day),
    sampleCount: 0, sampleForeign: 0, sampleUsd: 0 };
}

function targetUsd(counted, decimals, rate) {
  return roundHalfAway((counted / 10 ** decimals / rate) * 100);
}

// Quantity and USD valuation can move in opposite directions. Separate them so
// the cash quantity remains exact, including USD-only valuation corrections.
function adjustmentLines(account, counterpart, booked, counted, valuation, decimals) {
  const desiredUsd = targetUsd(counted, decimals, valuation.rate);
  const foreignDelta = counted - booked.foreign;
  const usdDelta = desiredUsd - booked.usd;
  const lines = [];
  let quantityUsd = 0;
  if (foreignDelta) {
    quantityUsd = targetUsd(foreignDelta, decimals, valuation.rate);
    if (!quantityUsd) throw new ErrorHandler(400, 'فرق الجرد أصغر من دقة الدولار؛ راجع المبلغ والسعر');
    lines.push(moneyLine(account, foreignDelta > 0 ? 'debit' : 'credit', Math.abs(foreignDelta), Math.abs(quantityUsd), { label: 'تصحيح كمية الجرد' }));
    lines.push({ accountId: counterpart._id, [quantityUsd > 0 ? 'credit' : 'debit']: Math.abs(quantityUsd), label: account.name });
  }
  const revaluation = usdDelta - quantityUsd;
  if (revaluation) {
    const cashLine = moneyLine(account, revaluation > 0 ? 'debit' : 'credit', 0, Math.abs(revaluation), { label: 'تقييم افتتاحي بمتوسط الوارد المختار' });
    cashLine.amountCurrency = 0;
    lines.push(cashLine);
    lines.push({ accountId: counterpart._id, [revaluation > 0 ? 'credit' : 'debit']: Math.abs(revaluation), label: account.name });
  }
  return { lines, desiredUsd, usdDelta, foreignDelta };
}

module.exports = { METHODS, validateMethod, estimate, targetUsd, adjustmentLines };
