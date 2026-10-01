// Monthly schedules: depreciation (E24), asset disposal (E25), prepaid amortisation (E26)
const moment = require('moment-timezone');
const { FixedAsset, PrepaidExpense } = require('../../models/documents');
const { postEntry } = require('../ledger');
const { TZ, today, isDay, monthOf } = require('../dates');
const { logAudit } = require('../audit');
const { fail, getAccount, currencyOf, toCurrencyMinor, RateBook, moneyLine, resolveAccount } = require('./common');

const MONTH = /^\d{4}-\d{2}$/;
const monthEnd = (month) => moment.tz(`${month}-01`, 'YYYY-MM-DD', TZ).endOf('month').format('YYYY-MM-DD');
const nextMonth = (month) => moment.tz(`${month}-01`, 'YYYY-MM-DD', TZ).add(1, 'month').format('YYYY-MM');

// Months from `start` to `end` inclusive
function monthsBetween(start, end) {
  const months = [];
  for (let month = start; month <= end; month = nextMonth(month)) months.push(month);
  return months;
}

// The last month whose end has passed (the current month once its last day arrives)
const lastClosedMonth = () => {
  const day = today();
  return monthEnd(monthOf(day)) === day ? monthOf(day) : moment.tz(day, TZ).subtract(1, 'month').format('YYYY-MM');
};

// Equal instalments; the last one takes whatever is left so the total is exact
function instalment(total, count, postedCount, postedSum) {
  if (postedCount >= count - 1) return total - postedSum;
  return Math.floor(total / count);
}

async function postDepreciationMonth(asset, month, day, { session, user }) {
  const depreciable = asset.cost - asset.salvageValue;
  const postedSum = asset.depreciationPosted.reduce((sum, item) => sum + item.amount, 0);
  if (postedSum >= depreciable) return null;
  const amount = instalment(depreciable, asset.usefulLifeMonths, asset.depreciationPosted.length, postedSum);
  if (amount <= 0) return null;

  const [expense, accumulated] = await Promise.all([resolveAccount('depreciation_expense'), resolveAccount('accumulated_depreciation')]);
  const entry = await postEntry({
    eventType: 'DEPRECIATION',
    eventKey: `DEPRECIATION:${asset._id}:${month}`,
    date: day,
    description: `إهلاك ${asset.name} - ${month}`,
    source: { model: 'AccountingFixedAsset', id: asset._id },
    lines: [
      { accountId: expense._id, debit: amount, office: asset.office, assetId: asset._id },
      { accountId: accumulated._id, credit: amount, assetId: asset._id, office: asset.office },
    ],
  }, { session, user });
  asset.depreciationPosted.push({ month, amount, entryId: entry._id });
  if (postedSum + amount >= depreciable) asset.assetStatus = 'fully_depreciated';
  return entry;
}

// Posts every missing month up to `upToMonth` (never a month that has not ended yet), each dated
// on its last day - so assets bought in the past catch up month by month.
async function runDepreciation({ upToMonth, session, user }) {
  if (upToMonth && !MONTH.test(upToMonth)) throw fail('الشهر غير صالح');
  const limit = [upToMonth || lastClosedMonth(), lastClosedMonth()].sort()[0];
  const assets = await FixedAsset.find({ status: 'posted', assetStatus: 'active' }).session(session);
  let posted = 0;
  for (const asset of assets) {
    const done = new Set(asset.depreciationPosted.map((item) => item.month));
    for (const month of monthsBetween(monthOf(asset.purchaseDay), limit)) {
      if (done.has(month) || asset.assetStatus !== 'active') continue;
      if (await postDepreciationMonth(asset, month, monthEnd(month), { session, user })) posted++;
    }
    await asset.save({ session });
  }
  return { posted, upToMonth: limit };
}

// E25: depreciation up to the sale (the sale month is dated on the sale day), then the asset
// leaves the books: cash received + accumulated depreciation against its cost, the rest is a
// gain or loss.
async function disposeAsset(assetId, input, { session, req }) {
  const asset = await FixedAsset.findById(assetId).session(session);
  if (!asset || asset.status !== 'posted') throw fail('الأصل غير موجود');
  if (asset.assetStatus === 'disposed') throw fail('الأصل مُستبعد مسبقاً');
  if (!isDay(input.day) || input.day < asset.purchaseDay) throw fail('تاريخ البيع غير صالح');

  const saleMonth = monthOf(input.day);
  const done = new Set(asset.depreciationPosted.map((item) => item.month));
  for (const month of monthsBetween(monthOf(asset.purchaseDay), saleMonth)) {
    if (done.has(month) || asset.assetStatus === 'fully_depreciated') continue;
    await postDepreciationMonth(asset, month, month === saleMonth ? input.day : monthEnd(month), { session, user: req?.user });
  }

  const accumulated = asset.depreciationPosted.reduce((sum, item) => sum + item.amount, 0);
  const [accumulatedAccount, disposalAccount, assetAccount] = await Promise.all([
    resolveAccount('accumulated_depreciation'), resolveAccount('asset_disposal'), getAccount(asset.accountId, 'حساب الأصل'),
  ]);
  const rates = new RateBook(session);
  const lines = [];
  let proceedsUsd = 0;
  if (Number(input.proceeds) > 0) {
    const cash = await getAccount(input.toAccountId, 'حساب الاستلام');
    if (!cash.isCash) throw fail('اختر الخزينة التي استلمت ثمن البيع');
    const minor = await toCurrencyMinor(input.proceeds, currencyOf(cash));
    proceedsUsd = await rates.toUsd(minor, currencyOf(cash), input.day, input.rate);
    lines.push(moneyLine(cash, 'debit', minor, proceedsUsd, { label: `ثمن بيع ${asset.name}` }));
    asset.disposal = { toAccountId: cash._id, rate: input.rate };
  }
  if (accumulated) lines.push({ accountId: accumulatedAccount._id, debit: accumulated, assetId: asset._id, office: asset.office });
  lines.push({ accountId: assetAccount._id, credit: asset.cost, assetId: asset._id, office: asset.office });
  const result = proceedsUsd + accumulated - asset.cost;
  if (result !== 0) {
    lines.push({
      accountId: disposalAccount._id, office: asset.office, assetId: asset._id,
      debit: result < 0 ? -result : 0, credit: result > 0 ? result : 0,
      label: result > 0 ? 'ربح بيع أصل' : 'خسارة استبعاد أصل',
    });
  }

  const entry = await postEntry({
    eventType: 'ASSET_DISPOSAL',
    eventKey: `ASSET_DISPOSAL:${asset._id}`,
    date: input.day,
    description: `بيع/استبعاد ${asset.name}`,
    source: { model: 'AccountingFixedAsset', id: asset._id },
    fallbacks: rates.fallbacks,
    lines,
  }, { session, user: req?.user });
  await rates.lock();
  asset.disposal = { ...(asset.disposal || {}), day: input.day, proceeds: Number(input.proceeds || 0), entryId: entry._id };
  asset.assetStatus = 'disposed';
  await asset.save({ session });
  await logAudit({ req, action: 'asset.dispose', model: 'AccountingFixedAsset', docId: asset._id, after: asset.disposal }, session);
  return asset;
}

async function runPrepaidAmortization({ upToMonth, session, user }) {
  if (upToMonth && !MONTH.test(upToMonth)) throw fail('الشهر غير صالح');
  const limit = [upToMonth || lastClosedMonth(), lastClosedMonth()].sort()[0];
  const schedules = await PrepaidExpense.find({ status: 'posted' }).session(session);
  const prepaidAccount = await resolveAccount('prepaid_expenses');
  let posted = 0;
  for (const schedule of schedules) {
    const done = new Set(schedule.amortizationPosted.map((item) => item.month));
    const months = monthsBetween(schedule.startMonth, limit).slice(0, schedule.months);
    for (const month of months) {
      if (done.has(month)) continue;
      const postedSum = schedule.amortizationPosted.reduce((sum, item) => sum + item.amount, 0);
      const amount = instalment(schedule.total, schedule.months, schedule.amortizationPosted.length, postedSum);
      if (amount <= 0) continue;
      const entry = await postEntry({
        eventType: 'PREPAID_AMORT',
        eventKey: `PREPAID_AMORT:${schedule._id}:${month}`,
        date: monthEnd(month),
        description: `قسط ${schedule.description} - ${month}`,
        source: { model: 'AccountingPrepaidExpense', id: schedule._id },
        lines: [
          { accountId: schedule.expenseAccountId, debit: amount, office: schedule.office, prepaidId: schedule._id },
          { accountId: prepaidAccount._id, credit: amount, prepaidId: schedule._id, office: schedule.office },
        ],
      }, { session, user });
      schedule.amortizationPosted.push({ month, amount, entryId: entry._id });
      posted++;
    }
    await schedule.save({ session });
  }
  return { posted, upToMonth: limit };
}

module.exports = { runDepreciation, disposeAsset, runPrepaidAmortization, monthsBetween, monthEnd, lastClosedMonth };
