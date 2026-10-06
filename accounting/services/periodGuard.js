// No staff change in a closed period (owner's decision, spec 19.12): the operations screens
// (statements, order payments, debts) refuse to add, edit or delete a record dated on or before
// the lock date, unless the user is an owner. Owners' changes are reversed on the first open day
// as usual.
const ErrorHandler = require('../../utils/errorHandler');
const { AccountingSettings } = require('../models');
const { lockPeriod } = require('./periodLock');
const { isOwner } = require('./access');
const { toDay } = require('./dates');

async function assertOpenPeriod(user, date, { session } = {}) {
  const lockDate = (session ? await lockPeriod(session) : await AccountingSettings.findOne({ key: 'main' }).lean())?.lockDate;
  if (!lockDate || !date) return;
  let day;
  try {
    day = toDay(date);
  } catch {
    return;
  }
  if (day > lockDate) return;
  if (await isOwner(user)) return;
  throw new ErrorHandler(403, `The period up to ${lockDate} is closed in accounting. Only the owner can change records dated ${day}.`);
}

// Cancelling a posted accounting document dated in a closed period: the owner only
async function assertOwnerIfLocked(user, day, { session } = {}) {
  const settings = session ? await lockPeriod(session) : await AccountingSettings.findOne({ key: 'main' }).lean();
  if (!settings?.lockDate || !day || day > settings.lockDate) return;
  if (await isOwner(user)) return;
  throw new ErrorHandler(403, `المستند بتاريخ ${day} في فترة مقفلة (حتى ${settings.lockDate}). إلغاؤه للمالك فقط.`);
}

module.exports = { assertOpenPeriod, assertOwnerIfLocked };
