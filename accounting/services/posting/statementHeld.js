// Money the bank holds inside an account's balance that the books keep in its own account: the
// Kuveyt Turk card guarantee (25,000 TRY) shows in the bank's balance, while the books keep it in
// 170100 "ضمان بطاقة كويت ترك" because it cannot be spent (owner, 2026-11-12). Linking the two
// makes the statements screen compare the statement with the bank plus the guarantee, so the
// guarantee is not a lasting difference. It changes no entry and no balance.
const { Account } = require('../../models');
const { getBalance } = require('../carrying');
const { invalidateConfig } = require('../config');
const { logAudit } = require('../audit');
const { fail } = require('./common');

// Accounts that can be held inside a bank's statement: an asset of the same currency that is not
// itself a money account (a guarantee, a blocked deposit)
async function options(accountId) {
  const bank = await Account.findById(accountId).lean();
  if (!bank?.isCash) throw fail('اختر حساب بنك');
  const accounts = await Account.find({ isActive: true, isGroup: false, isCash: { $ne: true }, type: 'asset', currency: bank.currency || null, _id: { $ne: bank._id } })
    .select('code name currency').sort({ code: 1 }).lean();
  return { accounts, current: bank.statementHeldAccountId || null };
}

async function set(accountId, heldAccountId, { session, req }) {
  const bank = await Account.findById(accountId).session(session);
  if (!bank?.isCash) throw fail('اختر حساب بنك');
  let held = null;
  if (heldAccountId) {
    held = await Account.findById(heldAccountId).session(session);
    if (!held || !held.isActive || held.isGroup || held.isCash || held.type !== 'asset') throw fail('اختر حساب ضمان أو تأمين (أصل، ليس خزينة)');
    if ((held.currency || null) !== (bank.currency || null)) throw fail(`حساب الضمان يجب أن يكون بعملة الحساب (${bank.currency || 'USD'})`);
  }
  const before = bank.statementHeldAccountId || null;
  bank.statementHeldAccountId = held ? held._id : null;
  await bank.save({ session });
  invalidateConfig();
  await logAudit({ req, action: 'bank.statementHeldAccount', model: 'AccountingAccount', docId: bank._id,
    before: { statementHeldAccountId: before }, after: { statementHeldAccountId: bank.statementHeldAccountId } }, session);
  return { current: bank.statementHeldAccountId };
}

// What the statements screen shows for the held account: its balance now and on the statement's day
async function balances(bank, statementDay) {
  if (!bank?.statementHeldAccountId) return null;
  const held = await Account.findById(bank.statementHeldAccountId).select('code name currency isActive').lean();
  if (!held) return null;
  return {
    _id: held._id, code: held.code, name: held.name,
    balance: await getBalance(held._id),
    atStatement: statementDay ? await getBalance(held._id, { upToDay: statementDay }) : null,
  };
}

module.exports = { options, set, balances };
