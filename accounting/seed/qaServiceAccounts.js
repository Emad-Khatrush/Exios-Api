// QA-only deployment setup. Adds missing service roles; never edits balances or entries.
const mongoose = require('mongoose');
const { Account, AccountingSettings } = require('../models');
const defaults = require('./defaults');
const { invalidateConfig } = require('../services/config');

async function ensureQaServiceAccounts() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL || '';
  if (process.env.EXIOS_QA !== '1' || new URL(uri).hostname !== 'exios-api-qa.ian5mmn.mongodb.net') {
    throw new Error('QA service setup requires the dedicated QA database.');
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const settings = await AccountingSettings.findOne({ key: 'main' }).session(session);
      if (!settings) throw new Error('Accounting setup is missing.');
      for (const role of ['deferred_service_revenue', 'revenue_services', 'cost_services']) {
        const code = defaults.ROLE_DEFAULTS[role][0];
        const spec = defaults.ACCOUNTS.find((item) => item.code === code);
        let account = settings.accountRoles?.[role] && await Account.findById(settings.accountRoles[role]).session(session);
        if (!account) account = await Account.findOne({ $or: [{ seedKey: code }, { code }] }).session(session);
        if (!account) {
          const parent = await Account.findOne({ $or: [{ seedKey: spec.parent }, { code: spec.parent }] }).session(session);
          if (!parent?.isGroup || parent.type !== spec.type) throw new Error(`Invalid parent for ${role}`);
          const { parent: unused, ...fields } = spec;
          [account] = await Account.create([{ ...fields, parentId: parent._id, seedKey: code }], { session });
        }
        if (account.isGroup || !account.isActive || account.type !== spec.type || account.isCash || account.currency) {
          throw new Error(`Invalid service role: ${role}`);
        }
        // Preserve a valid existing mapping. Only fill roles that are absent.
        if (!settings.accountRoles?.[role]) {
          await AccountingSettings.updateOne({ _id: settings._id }, { $set: { [`accountRoles.${role}`]: account._id } }).session(session);
        } else if (String(settings.accountRoles[role]) !== String(account._id)) {
          throw new Error(`Missing mapped account for ${role}`);
        }
      }
    });
    invalidateConfig();
    console.log('QA service accounts ready; no journal entries or balances changed.');
  } finally { await session.endSession(); }
}

module.exports = { ensureQaServiceAccounts };
