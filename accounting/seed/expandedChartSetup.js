const { Account, AccountingSettings } = require('../models');
const { ExpenseType } = require('../models/documents');
const spec = require('./expandedChart');
const { runInTransaction } = require('../services/transaction');
const { invalidateConfig } = require('../services/config');
const { logAudit } = require('../services/audit');

async function install(req) {
  const result = await runInTransaction(async session => {
    const settings = await AccountingSettings.findOneAndUpdate({ key: 'main' }, { $inc: { periodVersion: 1 } }, { new: true, session });
    if (!settings) throw new Error('شغّل إعداد المحاسبة أولًا');
    const byCode = new Map((await Account.find({}).session(session)).map(a => [a.code, a]));
    const bySeed = new Map([...byCode.values()].filter(a => a.seedKey).map(a => [a.seedKey, a]));
    const resolved = new Map(); const created = [];
    for (const item of spec.accounts) {
      const key = `expanded:${item.code}`;
      let account = bySeed.get(key);
      const parent = item.parent && (resolved.get(item.parent) || bySeed.get(item.parent) || byCode.get(item.parent));
      if (!parent?.isGroup || parent.type !== item.type) throw new Error(`مجموعة غير صالحة للحساب ${item.name}`);
      if (!account) {
        let code = Number(item.code);
        while (byCode.has(String(code))) code++;
        const { parent: unused, ...fields } = item;
        [account] = await Account.create([{ ...fields, code: String(code), parentId: parent._id, seedKey: key }], { session });
        byCode.set(account.code, account); bySeed.set(key, account); created.push({ code: account.code, name: account.name });
      }
      if (account.type !== item.type || account.isGroup !== item.isGroup || !account.isActive || (item.currency && account.currency !== item.currency)) throw new Error(`راجع الحساب ${account.name} قبل ربطه`);
      resolved.set(item.code, account);
    }
    const roles = { ...(settings.accountRoles || {}) };
    for (const [role, [code]] of Object.entries(spec.roles)) if (!roles[role]) roles[role] = resolved.get(code)._id;
    settings.accountRoles = roles; await settings.save({ session });
    for (const [code, name] of spec.expenses) {
      if (!await ExpenseType.exists({ seedKey: `expanded:${code}` }).session(session)) await ExpenseType.create([{ seedKey: `expanded:${code}`, name, accountId: resolved.get(code)._id }], { session });
    }
    await logAudit({ req, action: 'chart.expand', model: 'AccountingSettings', docId: settings._id, after: { created } }, session);
    return { created, totalDefinitions: spec.accounts.length };
  });
  invalidateConfig(); return result;
}
module.exports = { install };
