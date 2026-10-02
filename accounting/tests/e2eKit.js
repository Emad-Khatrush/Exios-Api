// Shared by the end-to-end suites: call a controller as Express does, read an account's balance on
// any line filter, and check after each step everything that must hold between the books and the
// system (books balanced, wallets equal, every order's claims equal what the system says is left,
// nothing failed, nothing from live operations on the suspense account, the balance sheet balances).
const mongoose = require('mongoose');
const { account } = require('./helpers');
const { JournalEntry } = require('../models');
const { processQueue } = require('../services/events');
const { CHECKS } = require('../services/reports/exceptions');
const { balanceSheet } = require('../services/reports/statements');

const OWNER_ID = '69deb74c4b5e921e7416ea11';

const call = (handler, { params = {}, body = {}, query = {}, user } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    send(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
  };
  Promise.resolve(handler({ params, body, query, user, files: undefined, ip: '127.0.0.1' }, res, (error) => (error ? reject(error) : resolve({ status: 200 })))).catch(reject);
});

async function net(code, filter = {}) {
  const id = (await account(code))._id;
  const match = { 'lines.accountId': id, ...Object.fromEntries(Object.entries(filter).map(([k, v]) => [`lines.${k}`, v])) };
  const [row] = await JournalEntry.aggregate([{ $match: match }, { $unwind: '$lines' }, { $match: match }, { $group: { _id: null, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, fc: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } } } }]);
  return { usd: row?.usd || 0, foreign: row?.fc || 0 };
}
const usd = async (code, filter) => (await net(code, filter)).usd;

async function expectConsistent(step, { allow = [] } = {}) {
  await processQueue();
  const problems = [];
  for (const key of ['balanced', 'wallets', 'failedEvents', 'walletDeductions', 'claimsVsSystem', 'unrecognized', 'overpaid'].filter((k) => !allow.includes(k))) {
    const result = await CHECKS[key]();
    if (result.count) problems.push(`${key}: ${JSON.stringify(result.items.slice(0, 3))}`);
  }
  const suspense = await JournalEntry.countDocuments({ isHistorical: { $ne: true }, 'lines.accountCode': '399000' });
  if (suspense) problems.push(`suspense: ${suspense} live entries`);
  const sheet = await balanceSheet({ asOf: '2099-12-31' });
  if (!sheet.balanced) problems.push(`balance sheet off by ${sheet.difference}`);
  if (problems.length) throw new Error(`${step}:\n${problems.join('\n')}`);
}

const oidOf = (value) => new mongoose.Types.ObjectId(String(value));

module.exports = { OWNER_ID, call, net, usd, expectConsistent, oidOf };
