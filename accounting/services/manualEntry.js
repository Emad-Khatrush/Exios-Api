const crypto = require('crypto');
const mongoose = require('mongoose');
const { resolveAccount } = require('./roles');
const ErrorHandler = require('../../utils/errorHandler');
const { postEntry, reverseEntry } = require('./ledger');
const { getConfig } = require('./config');
const { getRate, markRateUsed } = require('./rates');
const { toMinor, convertToUsdMinor, USD, USD_DECIMALS } = require('./money');
const { isDay } = require('./dates');
const { logAudit } = require('./audit');
const { JournalEntry } = require('../models');

const DIMENSION_INPUTS = ['partnerId', 'vendorId', 'employeeId', 'tripId', 'orderId', 'packageId', 'office', 'label'];

// A manual entry (E18) typed by the admin: each line has a side and an amount in the account's
// currency. Foreign amounts are converted with the line's rate or that day's rate.
// Locked dates are refused (the admin picks the date, it is never moved silently), except for the
// owner who says so (`inLockedPeriod`, spec 19.12): the entry goes on its date, and if its year was
// already closed a supplementary closing entry carries its result into retained earnings.
async function createManualEntry({ date, description, lines, idempotencyKey, inLockedPeriod }, { session, req }) {
  if (!isDay(date)) throw new ErrorHandler(400, 'التاريخ غير صالح');
  const { settings: { lockDate } } = await getConfig();
  const locked = !!lockDate && date <= lockDate;
  if (locked && !inLockedPeriod) throw new ErrorHandler(400, `الفترة مقفلة حتى ${lockDate}`);
  if (locked && !(await require('./access').isOwner(req?.user))) throw new ErrorHandler(403, 'الترحيل في فترة مقفلة للمالك فقط');
  if (!String(description || '').trim()) throw new ErrorHandler(400, 'البيان مطلوب');
  if (!Array.isArray(lines) || lines.length < 2) throw new ErrorHandler(400, 'القيد يحتاج سطرين على الأقل');

  const { accountsById, currencies } = await getConfig();
  const usedRates = [];
  const built = [];
  const receivable = await resolveAccount('customer_receivable');
  const claimOrders = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const account = accountsById.get(String(line.accountId || ''));
    if (!account) throw new ErrorHandler(400, `السطر ${i + 1}: اختر الحساب`);
    if (!account.allowManualEntry) throw new ErrorHandler(400, `السطر ${i + 1}: الحساب ${account.code} لا يقبل القيود اليدوية`);
    if (!['debit', 'credit'].includes(line.side)) throw new ErrorHandler(400, `السطر ${i + 1}: اختر مدين أو دائن`);
    const amount = Number(line.amount);
    if (!(amount > 0)) throw new ErrorHandler(400, `السطر ${i + 1}: المبلغ يجب أن يكون أكبر من صفر`);

    const out = {};
    DIMENSION_INPUTS.forEach((field) => { if (line[field]) out[field] = line[field]; });
    // A line on customer receivables can settle (or add to) one specific claim
    if (line.arKey && String(account._id) === String(receivable._id)) {
      const [kind, first, second] = String(line.arKey).split(':');
      if (!['PUR', 'SHP', 'GEN'].includes(kind) || !mongoose.isValidObjectId(first)) throw new ErrorHandler(400, `السطر ${i + 1}: المطالبة غير صالحة`);
      if (!line.partnerId) throw new ErrorHandler(400, `السطر ${i + 1}: اختر العميل صاحب المطالبة`);
      out.arKey = line.arKey;
      if (kind !== 'GEN') { out.orderId = first; claimOrders.add(first); }
      if (kind === 'SHP' && mongoose.isValidObjectId(second)) out.packageId = second;
    }

    let usd;
    if (account.currency && account.currency !== USD) {
      const decimals = currencies.get(account.currency)?.decimals ?? 2;
      const foreign = toMinor(amount, decimals);
      const rate = await getRate(account.currency, date, { docRate: line.rate, session });
      if (rate.rateId) usedRates.push(rate.rateId);
      usd = convertToUsdMinor(foreign, decimals, rate.rate);
      out.currency = account.currency;
      out.amountCurrency = line.side === 'debit' ? foreign : -foreign;
      out.rate = rate.rate;
    } else {
      usd = toMinor(amount, USD_DECIMALS);
    }
    if (line.side === 'debit') out.debit = usd; else out.credit = usd;
    built.push({ accountId: account._id, ...out });
  }

  const entry = await postEntry({
    eventType: 'MANUAL',
    eventKey: `MANUAL:${idempotencyKey || crypto.randomUUID()}`,
    date,
    description: String(description).trim(),
    source: { model: 'Manual' },
    lines: built,
  }, { session, user: req?.user, onLocked: locked ? 'allow' : 'reject' });
  if (locked) {
    entry.notes = [...(entry.notes || []), `رُحِّل في فترة مقفلة بقرار المالك (حتى ${lockDate})`];
    await entry.save({ session });
    await closeIntoRetained(entry, { session, req });
  }

  for (const rateId of usedRates) await markRateUsed(rateId, session);
  // A claim settled by hand may now be fully paid: its revenue is recognised like any payment
  for (const orderId of claimOrders) await require('./claims/sync').syncOrder(orderId, { session, user: req?.user, date });
  await require('./claims/serviceDebt').syncServiceDebts(built.map(l => l.arKey).filter(Boolean), { session, user: req?.user, date });
  await logAudit({ req, action: 'entry.manual', model: 'AccountingJournalEntry', docId: entry._id, after: entry }, session);
  return entry;
}

// Automatic entries are cancelled from their document; only manual ones are cancelled directly
async function cancelManualEntry(entryId, { reason, session, req }) {
  if (!String(reason || '').trim()) throw new ErrorHandler(400, 'سبب الإلغاء مطلوب');
  const entry = await JournalEntry.findById(entryId).session(session);
  if (!entry) throw new ErrorHandler(404, 'القيد غير موجود');
  if (entry.eventType !== 'MANUAL') throw new ErrorHandler(400, 'هذا قيد تلقائي؛ يُلغى بإلغاء مستنده');
  await require('./periodGuard').assertOwnerIfLocked(req?.user, entry.day);
  // The owner undoing an entry in a closed period undoes it on its own date, with the closing it got
  const { settings: { lockDate } } = await getConfig();
  const onLocked = lockDate && entry.day <= lockDate ? 'allow' : 'shift';
  const reversal = await reverseEntry(entry._id, {
    session, user: req?.user, reason, eventKey: `CANCEL:JournalEntry:${entry._id}`, eventType: 'CANCEL', onLocked,
  });
  const supplement = await JournalEntry.findOne({ eventKey: new RegExp(`^YEAR_CLOSE_SUPP:\\d{4}:${entry._id}$`), status: 'posted' }).session(session);
  if (supplement) {
    await reverseEntry(supplement._id, { session, user: req?.user, reason, eventKey: `CANCEL:JournalEntry:${supplement._id}`, eventType: 'YEAR_CLOSE', onLocked: 'allow' });
  }
  const receivable = await resolveAccount('customer_receivable');
  const orders = new Set(entry.lines.filter((l) => l.arKey && l.orderId && String(l.accountId) === String(receivable._id)).map((l) => String(l.orderId)));
  for (const orderId of orders) await require('./claims/sync').syncOrder(orderId, { session, user: req?.user });
  await require('./claims/serviceDebt').syncServiceDebts(entry.lines.map(l => l.arKey).filter(Boolean), { session, user: req?.user });
  await logAudit({ req, action: 'entry.cancel', model: 'AccountingJournalEntry', docId: entry._id, after: { reason, reversalId: reversal._id } }, session);
  return reversal;
}

// An entry posted into a year already closed: its income, expense and withdrawal lines are carried
// into retained earnings on the year end, like the year closing did for the rest
async function closeIntoRetained(entry, { session, req }) {
  const { fiscalYear } = require('./closing');
  const { accountsById } = await getConfig();
  let year = Number(entry.day.slice(0, 4));
  let range = await fiscalYear(String(year));
  if (entry.day > range.end) range = await fiscalYear(String(++year));
  if (entry.day < range.start) range = await fiscalYear(String(--year));
  const closed = await JournalEntry.exists({ eventKey: new RegExp(`^YEAR_CLOSE:${year}(:|$)`), status: 'posted' }).session(session);
  if (!closed) return null;
  const withdrawals = await resolveAccount('partner_withdrawals');
  const result = entry.lines.filter((line) => {
    const account = accountsById.get(String(line.accountId));
    return account && (['income', 'expense'].includes(account.type) || String(account._id) === String(withdrawals._id));
  });
  if (!result.length) return null;
  const lines = result.map((line) => ({ accountId: line.accountId, debit: line.credit, credit: line.debit, ...(line.office && { office: line.office }), label: `إقفال تكميلي ${year}` }));
  const net = result.reduce((sum, line) => sum + line.debit - line.credit, 0);
  if (net) lines.push({ accountId: (await resolveAccount('retained_earnings'))._id, [net > 0 ? 'debit' : 'credit']: Math.abs(net), label: `نتيجة القيد ${entry.number}` });
  return postEntry({
    eventType: 'YEAR_CLOSE', eventKey: `YEAR_CLOSE_SUPP:${year}:${entry._id}`, date: range.end,
    description: `إقفال تكميلي للسنة ${year}: أثر القيد ${entry.number} المرحَّل بعد إقفالها`,
    source: { model: 'AccountingJournalEntry', id: entry._id }, lines,
  }, { session, user: req?.user, onLocked: 'allow' });
}

module.exports = { createManualEntry, cancelManualEntry };
