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
// Locked dates are refused (the admin picks the date, it is never moved silently).
async function createManualEntry({ date, description, lines, idempotencyKey }, { session, req }) {
  if (!isDay(date)) throw new ErrorHandler(400, 'التاريخ غير صالح');
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
  }, { session, user: req?.user, onLocked: 'reject' });

  for (const rateId of usedRates) await markRateUsed(rateId, session);
  // A claim settled by hand may now be fully paid: its revenue is recognised like any payment
  for (const orderId of claimOrders) await require('./claims/sync').syncOrder(orderId, { session, user: req?.user, date });
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
  const reversal = await reverseEntry(entry._id, {
    session, user: req?.user, reason, eventKey: `CANCEL:JournalEntry:${entry._id}`, eventType: 'CANCEL',
  });
  const receivable = await resolveAccount('customer_receivable');
  const orders = new Set(entry.lines.filter((l) => l.arKey && l.orderId && String(l.accountId) === String(receivable._id)).map((l) => String(l.orderId)));
  for (const orderId of orders) await require('./claims/sync').syncOrder(orderId, { session, user: req?.user });
  await logAudit({ req, action: 'entry.cancel', model: 'AccountingJournalEntry', docId: entry._id, after: { reason, reversalId: reversal._id } }, session);
  return reversal;
}

module.exports = { createManualEntry, cancelManualEntry };
