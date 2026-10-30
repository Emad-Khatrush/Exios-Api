// The exact accounts requested in the chart screenshots. Preview by default; --apply deletes.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const { removedAccountCodes, currencies } = require('../seed/expandedChart');

function accountPaths(schema, prefix = '') {
  const found = [];
  schema.eachPath((key, field) => {
    const full = prefix + key;
    if (field.schema) found.push(...accountPaths(field.schema, `${full}.`));
    else if (field.options?.ref === 'AccountingAccount' || field.caster?.options?.ref === 'AccountingAccount' || /accountIds?$/i.test(key)) found.push(full);
  });
  return found;
}
function references(value, ids) {
  if (value == null) return false;
  if (typeof value === 'string' || value instanceof mongoose.Types.ObjectId) return ids.has(String(value));
  if (Array.isArray(value)) return value.some(item => references(item, ids));
  if (typeof value === 'object') return Object.values(value).some(item => references(item, ids));
  return false;
}
async function main() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!uri || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(uri).hostname) || process.env.NODE_ENV === 'production' || process.env.EXIOS_QA === '1') throw new Error('Local database only.');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  if (mongoose.connection.name !== 'exios-prod-copy') throw new Error('Unexpected local database; no changes made.');
  for (const file of fs.readdirSync(path.join(__dirname, '../models'))) if (file.endsWith('.js')) require(path.join(__dirname, '../models', file));
  require('../../models/userStatement');
  const { Account, AccountingSettings } = require('../models');
  const rolesByPrefix = { '1106': 'transfer_in_transit', '1293': 'mistaken_transfer', '1702': 'refundable_deposit', '2402': 'salary_payable', '2403': 'commission_payable' };
  async function inspect(session) {
    const accounts = await Account.find({ code: { $in: removedAccountCodes } }).session(session || null).lean();
    const ids = accounts.map(account => account._id);
    const idSet = new Set(ids.map(String));
    const settings = await AccountingSettings.findOne({ key: 'main' }).session(session || null).lean();
    if (!settings) throw new Error('Accounting settings missing.');
    const removedRoles = {};
    for (const account of accounts) {
      const expectedCurrency = currencies[Number(account.code.slice(-2)) - 1];
      if (account.seedKey !== `expanded:${account.code}` || account.isGroup || account.currency !== expectedCurrency) throw new Error(`Unexpected account definition: ${account.code}`);
    }
    for (const [role, id] of Object.entries(settings.accountRoles || {})) if (idSet.has(String(id))) {
      const account = accounts.find(item => String(item._id) === String(id));
      if (role !== `${rolesByPrefix[account.code.slice(0, 4)]}_${account.currency.toLowerCase()}`) throw new Error(`Unexpected role reference: ${role}`);
      removedRoles[role] = id;
    }
    const { accountRoles, ...otherSettings } = settings;
    if (references(otherSettings, idSet)) throw new Error('An account is referenced by other accounting settings.');
    const blocking = [];
    if (ids.length) for (const Model of Object.values(mongoose.models)) {
      if (['AccountingSettings', 'AccountingAuditLog'].includes(Model.modelName)) continue;
      const fields = accountPaths(Model.schema);
      if (!fields.length) continue;
      const count = await Model.countDocuments({ $or: fields.map(field => ({ [field]: { $in: ids } })) }).session(session || null);
      if (count) blocking.push({ model: Model.modelName, count });
    }
    if (blocking.length) throw new Error(`Accounts are used; nothing deleted: ${JSON.stringify(blocking)}`);
    return { accounts, settings, removedRoles };
  }
  const preview = await inspect();
  console.log(JSON.stringify({ database: mongoose.connection.name, mode: process.argv.includes('--apply') ? 'apply' : 'preview', accounts: preview.accounts.map(a => ({ code: a.code, currency: a.currency, name: a.name })), roles: Object.keys(preview.removedRoles) }));
  if (process.argv.includes('--apply') && preview.accounts.length) {
    const backup = path.join(os.tmpdir(), `exios-removed-currency-accounts-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify({ database: mongoose.connection.name, accounts: preview.accounts, removedRoles: preview.removedRoles }, null, 2), { flag: 'wx' });
    const deleted = await require('../services/transaction').runInTransaction(async session => {
      await AccountingSettings.updateOne({ key: 'main' }, { $inc: { periodVersion: 1 } }, { session });
      const current = await inspect(session);
      const roleUnset = Object.fromEntries(Object.keys(current.removedRoles).map(role => [`accountRoles.${role}`, 1]));
      if (Object.keys(roleUnset).length) await AccountingSettings.updateOne({ key: 'main' }, { $unset: roleUnset }, { session });
      for (const account of current.accounts) await require('../services/audit').logAudit({ action: 'account.delete', model: 'AccountingAccount', docId: account._id, before: account, after: { reason: 'Removed unused currency accounts requested by owner', backup } }, session);
      return (await Account.deleteMany({ _id: { $in: current.accounts.map(a => a._id) } }, { session })).deletedCount;
    });
    require('../services/config').invalidateConfig();
    console.log(JSON.stringify({ deleted, backup }));
  }
  await mongoose.disconnect();
}
main().catch(async error => { console.error(error.message); await mongoose.disconnect(); process.exitCode = 1; });
