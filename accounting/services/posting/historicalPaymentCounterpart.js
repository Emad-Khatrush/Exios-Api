const { JournalEntry } = require('../../models');
const { resolveAccount } = require('../roles');
const { fail } = require('./common');

// A payment already included in SUSPENSE_CLOSE belongs to opening equity. Its
// subsequent bank identification must not reopen suspense or recognise another cost.
async function counterpartFor(payment, paymentEntry, suspense, { session } = {}) {
  const run = payment.migrationRunId;
  if (!run || paymentEntry.migrationRunId !== run) return { account: suspense, closure: null };
  const closure = await JournalEntry.findOne({ eventKey: `SUSPENSE_CLOSE:${run}`, status: 'posted' }).session(session || null).lean();
  if (!closure) return { account: suspense, closure: null };
  if (!Number.isFinite(new Date(paymentEntry.createdAt).getTime()) || !Number.isFinite(new Date(closure.createdAt).getTime())) {
    throw fail('تاريخ السداد أو الإقفال غير صالح؛ لا يمكن تحديد ما إذا كان السداد ضمن الإقفال');
  }
  // A payment inserted after the close was not part of that close.
  if (new Date(paymentEntry.createdAt) > new Date(closure.createdAt)) return { account: suspense, closure: null };
  const opening = await resolveAccount('opening_balance');
  const suspenseLine = closure.lines.find(line => String(line.accountId) === String(suspense._id));
  const openingLine = closure.lines.find(line => String(line.accountId) === String(opening._id));
  if (closure.reversalOf || !closure.isHistorical || closure.migrationRunId !== run || closure.lines.length !== 2 ||
    !suspenseLine || !openingLine || closure.lines.some(line => line.currency !== 'USD' ||
      !Number.isSafeInteger(line.debit) || !Number.isSafeInteger(line.credit) || line.debit < 0 || line.credit < 0) ||
    !Number.isSafeInteger(suspenseLine.debit - suspenseLine.credit) ||
    suspenseLine.debit - suspenseLine.credit === 0 ||
    suspenseLine.debit - suspenseLine.credit + openingLine.debit - openingLine.credit !== 0 ||
    opening.isCash || suspense.isCash || (opening.currency && opening.currency !== 'USD') || opening.requires?.length) {
    throw fail('إقفال المعلّق التاريخي غير صالح لهذه التسوية؛ راجع قيد الإقفال وإعداد حساب الرصيد الافتتاحي');
  }
  return { account: opening, closure };
}

module.exports = { counterpartFor };
