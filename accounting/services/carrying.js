const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { roundHalfAway } = require('./money');

const toId = (value) => (value ? new mongoose.Types.ObjectId(String(value)) : null);

// Balance of an account (optionally for one customer): usd = debit - credit in cents,
// foreign = sum of amountCurrency in the account's currency. Read inside the caller's
// transaction so two operations on the same wallet never both use a stale balance.
// `upToDay` gives the balance at the end of that accounting day instead of now; `employeeId` the
// part one staff member holds (custody, loans).
async function getBalance(accountId, { partnerId, employeeId, session, upToDay } = {}) {
  const lineMatch = { 'lines.accountId': toId(accountId) };
  if (partnerId) lineMatch['lines.partnerId'] = toId(partnerId);
  if (employeeId) lineMatch['lines.employeeId'] = toId(employeeId);

  const [result] = await JournalEntry.aggregate([
    { $match: { ...lineMatch, ...(upToDay && { day: { $lte: upToDay } }) } },
    { $unwind: '$lines' },
    { $match: lineMatch },
    {
      $group: {
        _id: null,
        usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } },
      },
    },
  ]).session(session || null);

  return { usd: result?.usd || 0, foreign: result?.foreign || 0 };
}

// USD value (cents, positive) of `foreignOut` (positive, minor units) leaving an account whose
// balance is `balance`, at the account's average carrying rate. Taking out the whole foreign
// balance takes out the whole USD balance, so a wallet at 0 LYD is also at 0 USD.
// Returns null when there is no usable average (empty or mixed-sign balance); the caller then
// values the line at the operation's own rate.
function valueOutflow(balance, foreignOut) {
  const foreign = Math.abs(balance.foreign);
  const usd = Math.abs(balance.usd);
  const sameSign = Math.sign(balance.foreign) === Math.sign(balance.usd);
  if (!foreign || !usd || !sameSign) return null;
  if (foreignOut === foreign) return usd;
  return roundHalfAway((foreignOut * usd) / foreign);
}

const carryingRate = (balance, decimals) => {
  if (!balance.foreign || !balance.usd) return null;
  return (Math.abs(balance.foreign) / 10 ** decimals) / (Math.abs(balance.usd) / 100);
};

module.exports = { getBalance, valueOutflow, carryingRate };
