const crypto = require('crypto');
const mongoose = require('mongoose');
const { Account, JournalEntry } = require('../models');
const { getConfig } = require('./config');
const { getBalance, carryingRate } = require('./carrying');
const { decimalsOf, lockPostingAccounts, moneyLine } = require('./posting/common');
const { lockPeriod } = require('./periodLock');
const { resolveAccount } = require('./roles');
const { today } = require('./dates');
const valuation = require('./openingCashValuation');
const ErrorHandler = require('../../utils/errorHandler');
const fail = message => new ErrorHandler(400, message);
const hash = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

async function prepare(account, method, { session, settings } = {}) {
  valuation.validateMethod(method);
  if (method === 'legacy') throw fail('اختر مدة متوسط الوارد أولًا');
  const day = today();
  if (!account?.isCash || account.isGroup || !account.isActive || !account.currency || account.currency === 'USD') throw fail('اختر خزينة فعّالة بعملة غير الدولار');
  if (settings?.lockDate && day <= settings.lockDate) throw fail('اليوم ضمن فترة مقفلة؛ لا يمكن تطبيق تقييم الخزينة');
  if (settings?.migrationGuardDay && day <= settings.migrationGuardDay) throw fail('أكمل مراجعة الترحيل التاريخي قبل تقييم الخزينة');
  if (await JournalEntry.exists({ 'lines.accountId': account._id, day: { $gt: day } }).session(session || null)) throw fail('الخزينة لديها قيود بتاريخ مستقبلي؛ راجعها قبل تطبيق المتوسط الحالي');
  const booked = await getBalance(account._id, { session });
  if (!(booked.foreign > 0) || !(booked.usd > 0)) throw fail('تقييم المتوسط يحتاج رصيدًا موجبًا بالعملة وبالدولار؛ راجع الأرصدة الصفرية أو السالبة مستقلاً');
  const sampled = await valuation.estimate(account, day, method, { session });
  if (sampled.source !== 'receipts') throw fail('لا يوجد وارد صالح في المدة المختارة؛ وسّع المدة للحصول على متوسط فعلي');
  const decimals = await decimalsOf(account.currency);
  const desiredUsd = valuation.targetUsd(booked.foreign, decimals, sampled.rate);
  if (!Number.isSafeInteger(desiredUsd) || desiredUsd <= 0) throw fail('القيمة المقترحة بالدولار غير صالحة');
  const differenceUsd = desiredUsd - booked.usd;
  const role = differenceUsd >= 0 ? 'fx_unrealized_gain' : 'fx_unrealized_loss';
  const counterpart = await resolveAccount(settings?.accountRoles?.[role] ? role : 'fx_gain_loss');
  if (counterpart.isCash || counterpart.isGroup || !counterpart.isActive || (counterpart.currency && counterpart.currency !== 'USD')) throw fail('حساب فروقات إعادة التقييم غير صالح');
  const summary = { accountId: account._id, code: account.code, name: account.name, currency: account.currency,
    day, method, amount: booked.foreign / 10 ** decimals, currentUsd: booked.usd, currentRate: carryingRate(booked, decimals),
    proposedUsd: desiredUsd, differenceUsd, valuation: sampled, counterpart: { code: counterpart.code, name: counterpart.name }, canApply: differenceUsd !== 0 };
  const fingerprint = hash({ summary, foreign: booked.foreign, counterpartId: counterpart._id,
    lockDate: settings?.lockDate, migrationGuardDay: settings?.migrationGuardDay });
  return { summary: { ...summary, fingerprint }, account, booked, counterpart };
}

async function preview(method) {
  const { settings, accountsById } = await getConfig();
  method = valuation.validateMethod(method || settings?.openingCashRateMethod || 'legacy');
  if (method === 'legacy') throw fail('اختر شهرًا أو شهرين أو سنة أو كامل الفترة لحساب متوسط الوارد');
  const results = [];
  for (const account of accountsById.values()) {
    if (!account.isCash || account.isGroup || !account.isActive || !account.currency || account.currency === 'USD') continue;
    try { results.push((await prepare(account, method, { settings })).summary); }
    catch (error) {
      if (error.statusCode !== 400) throw error;
      results.push({ accountId: account._id, code: account.code, name: account.name, currency: account.currency, canApply: false, blockedReason: error.message });
    }
  }
  return { scope: 'current', method, day: today(), readOnly: true, results };
}

async function apply(input, { session, req }) {
  if (!mongoose.isValidObjectId(input.accountId)) throw fail('اختر الخزينة');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey || '')) throw fail('معرّف العملية مطلوب');
  if (!String(input.reason || '').trim() || String(input.reason).length > 1000) throw fail('اكتب سبب تصحيح التقييم، حتى 1000 حرف');
  const eventKey = `CURRENT_CASH_VALUATION:${input.accountId}:${input.idempotencyKey}`;
  const existing = await JournalEntry.findOne({ eventKey }).session(session);
  if (existing) return { entryId: existing._id, number: existing.number, alreadyApplied: true };
  const settings = await lockPeriod(session);
  const account = await Account.findById(input.accountId).session(session).lean();
  if (!account) throw fail('الخزينة غير موجودة');
  await lockPostingAccounts([account], session);
  const prepared = await prepare(account, input.method, { session, settings });
  const { summary, booked, counterpart } = prepared;
  if (!input.fingerprint || input.fingerprint !== summary.fingerprint) throw new ErrorHandler(409, 'تغيّر الرصيد أو الوارد أو اليوم؛ حدّث المعاينة قبل الاعتماد');
  if (!summary.canApply) throw fail('الخزينة مطابقة بالفعل للمتوسط المختار؛ لا حاجة إلى قيد');
  const cashLine = moneyLine(account, summary.differenceUsd > 0 ? 'debit' : 'credit', 0, Math.abs(summary.differenceUsd), { label: 'تطبيق متوسط الوارد على القيمة الدفترية الحالية' });
  cashLine.amountCurrency = 0;
  const entry = await require('./ledger').postEntry({ eventType: 'FX_REVALUATION', eventKey, date: summary.day, countRule: 'skip',
    source: { model: 'AccountingAccount', id: account._id }, description: `تقييم الخزينة الحالية ${account.name}: ${input.reason}`,
    notes: [`تقدير بمتوسط الوارد ${summary.method}؛ عدد الحركات ${summary.valuation.sampleCount}؛ السعر ${summary.currentRate} ← ${summary.valuation.rate}. لا تعديل للدفعات السابقة.`],
    lines: [cashLine, { accountId: counterpart._id, [summary.differenceUsd > 0 ? 'credit' : 'debit']: Math.abs(summary.differenceUsd), office: account.office || undefined, label: String(input.reason).trim() }],
  }, { session, user: req.user, onLocked: 'reject' });
  const after = await getBalance(account._id, { session });
  if (after.foreign !== booked.foreign || after.usd !== summary.proposedUsd) throw fail('لم يطابق أثر القيد المعاينة؛ أُلغيت العملية');
  await require('./audit').logAudit({ req, action: 'cash.currentValuation', model: 'AccountingAccount', docId: account._id,
    before: booked, after: { balance: after, preview: summary, reason: input.reason, entryId: entry._id } }, session);
  return { entryId: entry._id, number: entry.number, preview: summary };
}

module.exports = { preview, apply };
