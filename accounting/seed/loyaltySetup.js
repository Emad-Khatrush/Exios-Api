// Adds the loyalty accounts and fills their roles in an existing database. Never edits balances or entries.
const { Account, AccountingSettings } = require('../models');
const defaults = require('./defaults');
const { invalidateConfig } = require('../services/config');

const ROLES = ['loyalty_points', 'loyalty_expense'];

async function ensureLoyaltySetup() {
  const settings = await AccountingSettings.findOne({ key: 'main' });
  if (!settings) return;
  for (const role of ROLES) {
    const seedKey = defaults.ROLE_DEFAULTS[role][0];
    const spec = defaults.ACCOUNTS.find((item) => item.code === seedKey);
    // Found by seedKey only: an unrelated account holding the preferred code is never reused.
    let account = await Account.findOne({ seedKey });
    if (!account) {
      const parent = await Account.findOne({ $or: [{ seedKey: spec.parent }, { code: spec.parent, isGroup: true }] });
      if (!parent?.isGroup || parent.type !== spec.type) throw new Error(`Invalid parent for ${role}`);
      let code = Number(seedKey);
      while (await Account.exists({ code: String(code) })) code++;
      const { parent: unused, ...fields } = spec;
      account = await Account.create({ ...fields, code: String(code), parentId: parent._id, seedKey });
    }
    // Only fill roles that are absent, or point at an account that no longer exists (a database
    // restored without it); a mapping to a live account is kept.
    const mapped = settings.accountRoles?.[role];
    if (!mapped || !(await Account.exists({ _id: mapped }))) {
      await AccountingSettings.updateOne({ _id: settings._id }, { $set: { [`accountRoles.${role}`]: account._id } });
    }
  }
  invalidateConfig();
}

module.exports = { ensureLoyaltySetup };
