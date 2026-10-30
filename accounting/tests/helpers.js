const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { invalidateConfig } = require('../services/config');
const { runSetup } = require('../seed/setup');
const { runInTransaction } = require('../services/transaction');
const { postEntry } = require('../services/ledger');
const { Account } = require('../models');

let replSet;

// A one-node replica set, because the ledger only writes inside transactions
async function startDb() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

async function stopDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function resetDb({ setup = true } = {}) {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) await collection.deleteMany({});
  invalidateConfig();
  if (setup) await runSetup();
}

const account = (code) => Account.findOne({ code }).lean();

const post = (input, options = {}) => runInTransaction((session) => postEntry(input, { session, ...options }));

const oid = () => new mongoose.Types.ObjectId();

module.exports = { startDb, stopDb, resetDb, account, post, oid };
