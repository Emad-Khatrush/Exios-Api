// Explicit local installation: accounts, mappings and document indexes only.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
async function main() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!uri || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname) || process.env.EXIOS_QA === '1' || process.env.NODE_ENV === 'production') throw new Error('This installer is restricted to local MongoDB.');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const { Operation, Action } = require('../models/FinancialOperation');
  for (const Model of [Operation, Action]) { await Model.createCollection(); await Model.createIndexes(); }
  const { JournalEntry, Account } = require('../models');
  const entriesBefore = await JournalEntry.countDocuments();
  const accountsBefore = await Account.countDocuments();
  const result = await require('../seed/expandedChartSetup').install();
  console.log(JSON.stringify({ database: mongoose.connection.name, accountsBefore, accountsAfter: await Account.countDocuments(),
    createdAccounts: result.created.length, entriesBefore, entriesAfter: await JournalEntry.countDocuments(),
    created: result.created }));
  await mongoose.disconnect();
}
main().catch(async error => { console.error(error.message); await mongoose.disconnect(); process.exitCode = 1; });
