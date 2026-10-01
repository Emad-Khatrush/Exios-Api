// Building blocks shared by every posting function: currency conversion, valuing money that
// leaves an account at its average carrying rate (spec 2.4), the FX line, document numbers.
const ErrorHandler = require('../../../utils/errorHandler');
const { getConfig } = require('../config');
const { resolveAccount } = require('../roles');
const { getRate, markRateUsed } = require('../rates');
const { getBalance, valueOutflow } = require('../carrying');
const { toMinor, convertToUsdMinor, USD } = require('../money');
const { nextSeq } = require('../counter');
const { yearOf, toDay } = require('../dates');

const fail = (message) => new ErrorHandler(400, message);

// Accounts with no currency are kept in USD only
const currencyOf = (account) => account.currency || USD;
const isForeign = (account) => currencyOf(account) !== USD;

async function getAccount(id, what = 'الحساب') {
  const { accountsById } = await getConfig();
  const account = id && accountsById.get(String(id));
  if (!account) throw fail(`${what} غير موجود`);
  if (account.isGroup) throw fail(`${what}: لا يمكن استخدام حساب مجموعة`);
  if (!account.isActive) throw fail(`${what} (${account.code}) مؤرشف`);
  return account;
}

async function decimalsOf(currency) {
  const { currencies } = await getConfig();
  const found = currencies.get(currency);
  if (!found) throw fail(`العملة ${currency} غير معرّفة`);
  if (!found.isActive) throw fail(`العملة ${currency} مؤرشفة`);
  return found.decimals;
}

async function toCurrencyMinor(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw fail('المبلغ غير صالح');
  return toMinor(value, await decimalsOf(currency));
}

// Collects the daily rates used, so they are locked once the entry is saved
class RateBook {
  constructor(session) {
    this.session = session;
    this.ids = [];
    this.fallbacks = [];
  }

  async rate(currency, day, docRate) {
    const found = await getRate(currency, day, { docRate, session: this.session });
    if (found.rateId) this.ids.push(found.rateId);
    if (found.source === 'previous') this.fallbacks.push(`سعر ${currency} ليوم ${found.day} (لا يوجد سعر ليوم ${toDay(day)})`);
    return found.rate;
  }

  async toUsd(foreignMinor, currency, day, docRate) {
    if (currency === USD) return foreignMinor;
    const rate = await this.rate(currency, day, docRate);
    return convertToUsdMinor(foreignMinor, await decimalsOf(currency), rate);
  }

  async lock() {
    for (const id of this.ids) await markRateUsed(id, this.session);
  }
}

// USD value of money leaving `account`: the account's average rate while it has a balance in
// that currency, otherwise the operation's rate. For a wallet pass partnerId (average per customer).
async function valueOut(account, foreignMinor, { day, docRate, rates, partnerId }) {
  if (!isForeign(account)) return foreignMinor;
  const balance = await getBalance(account._id, { partnerId, session: rates.session });
  const carried = valueOutflow(balance, foreignMinor);
  if (carried !== null) return carried;
  return rates.toUsd(foreignMinor, currencyOf(account), day, docRate);
}

// A line on `account` for `foreignMinor` (its own currency) worth `usd` cents
function moneyLine(account, side, foreignMinor, usd, extra = {}) {
  const line = {
    accountId: account._id,
    debit: side === 'debit' ? usd : 0,
    credit: side === 'credit' ? usd : 0,
    ...extra,
  };
  if (isForeign(account)) {
    line.currency = currencyOf(account);
    line.amountCurrency = side === 'debit' ? foreignMinor : -foreignMinor;
  }
  if (account.office && !line.office) line.office = account.office;
  return line;
}

// Whatever does not balance after valuing each side at its own rate is an exchange gain/loss
async function addFxLine(lines, office, label = 'فرق صرف') {
  const debit = lines.reduce((sum, line) => sum + (line.debit || 0), 0);
  const credit = lines.reduce((sum, line) => sum + (line.credit || 0), 0);
  const difference = debit - credit;
  if (difference === 0) return lines;
  const fx = await resolveAccount('fx_gain_loss');
  lines.push({
    accountId: fx._id,
    debit: difference < 0 ? -difference : 0,
    credit: difference > 0 ? difference : 0,
    label,
    ...(office && { office }),
  });
  return lines;
}

// BILL/2026/0001 - from the counters, inside the transaction: no gaps, no duplicates
async function nextDocNumber(prefix, day, session) {
  const year = yearOf(day);
  const seq = await nextSeq(`DOC:${prefix}:${year}`, session);
  return `${prefix}/${year}/${String(seq).padStart(4, '0')}`;
}

async function findExisting(Model, idempotencyKey, session) {
  if (!idempotencyKey) return null;
  return Model.findOne({ idempotencyKey }).session(session);
}

async function officeExists(office) {
  const { offices } = await getConfig();
  return !!office && offices.has(office);
}

module.exports = {
  fail,
  currencyOf,
  isForeign,
  getAccount,
  decimalsOf,
  toCurrencyMinor,
  RateBook,
  valueOut,
  moneyLine,
  addFxLine,
  nextDocNumber,
  findExisting,
  officeExists,
  resolveAccount,
};
