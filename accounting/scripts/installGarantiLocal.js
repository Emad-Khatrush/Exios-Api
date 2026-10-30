// Add only the requested Garanti accounts locally; do not reseed deleted accounts
// or create opening balances. Defaults also include these accounts for new setups.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { Account, Journal, JournalEntry } = require('../models');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');

async function main() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!uri || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname)
    || process.env.EXIOS_QA === '1' || process.env.NODE_ENV === 'production') {
    throw new Error('This installer is restricted to local MongoDB.');
  }
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const before = await JournalEntry.countDocuments();
  const result = await runInTransaction(async session => {
    const created = [], accounts = [];
    const definitions = require('../seed/defaults').ACCOUNTS.filter(a => a.nameEn?.startsWith('Garanti '));
    if (definitions.length !== 3) throw new Error('Expected exactly three Garanti definitions.');
    for (const { parent, ...definition } of definitions) {
      const group = await Account.findOne({ isGroup: true, $or: [{ seedKey: parent }, { code: parent }] }).session(session);
      if (!group || group.type !== definition.type) throw new Error(`Missing or incompatible parent ${parent}`);
      let account = await Account.findOne({ seedKey: definition.code }).session(session);
      if (!account) {
        if (await Account.exists({ code: definition.code }).session(session)) throw new Error(`Account code ${definition.code} is already in use; no account changed.`);
        [account] = await Account.create([{ ...definition, seedKey: definition.code, parentId: group._id }], { session });
        created.push(definition.code);
      }
      if (account.type !== definition.type || account.currency !== definition.currency
        || !account.isCash || account.cashKind !== 'bank' || account.office !== 'turkey'
        || account.isGroup || !account.isActive || String(account.parentId) !== String(group._id)) {
        throw new Error(`Existing Garanti account ${account.code} has incompatible settings; review it manually.`);
      }
      if (!await Journal.exists({ defaultAccountId: account._id }).session(session)) {
        const code = `${definition.type === 'liability' ? 'CARD' : 'BANK'}-GARANTI-${definition.currency}`;
        if (await Journal.exists({ code }).session(session)) throw new Error(`Journal code ${code} is already in use.`);
        await Journal.create([{ code, name: account.name, type: 'bank', defaultAccountId: account._id,
          office: 'turkey', sequencePrefix: code }], { session });
      }
      accounts.push({ code: account.code, name: account.name, currency: account.currency, type: account.type });
    }
    return { created, accounts };
  });
  invalidateConfig();
  console.log(JSON.stringify({ database: mongoose.connection.name, ...result,
    entriesBefore: before, entriesAfter: await JournalEntry.countDocuments() }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
