const { Vendor, BankRule } = require('../models/documents');
const { Account } = require('../models');
const catalogue = require('./merchants');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ensureVendor(input) {
  const existing = await Vendor.findOne({ $or: [{ seedKey: input.seedKey },
    { name: { $in: [input.name, ...(input.bankAliases || [])].map(name => new RegExp(`^${escape(name)}$`, 'i')) } }] });
  if (!existing) return { vendor: await Vendor.create(input), created: true };
  const aliases = [...new Set([...(existing.bankAliases || []), ...(input.bankAliases || [])])];
  let enriched = false;
  for (const key of ['bankPurpose', 'bankAccountCode', 'bankOffice']) {
    if (input[key] && !existing[key]) { existing[key] = input[key]; enriched = true; }
  }
  if (input.bankPurpose && existing.type === 'supplier') { existing.type = input.type; enriched = true; }
  if (!existing.seedKey || aliases.length !== (existing.bankAliases || []).length || enriched) {
    if (!existing.seedKey) existing.seedKey = input.seedKey;
    existing.bankAliases = aliases; await existing.save();
  }
  return { vendor: existing, created: false };
}

// Existing installations also receive new merchants on startup, without rerunning
// accounting migration, changing balances, or replacing operator-edited rules.
async function ensureMerchantSetup() {
  await require('./bankFundingSetup').ensureBankFundingSetup();
  if (!await Account.exists({ $or: [{ seedKey: '219100' }, { code: '219100' }] })) {
    const parent = await Account.findOne({ code: '21' }).lean();
    await Account.create({ code: '219100', seedKey: '219100', name: 'استردادات موردين قيد التحديد', nameEn: 'Unidentified supplier refunds', type: 'liability', parentId: parent?._id });
    require('../services/config').invalidateConfig();
  }
  const account = await Account.findOne({ code: '510400', isActive: true }).lean();
  for (const input of catalogue) {
    const { vendor } = await ensureVendor(input);
    if (input.bankPurpose === 'yuan_purchase') continue;
    const target = input.bankAccountCode ? await Account.findOne({ code: input.bankAccountCode, isActive: true }).lean() : account;
    if (!target) continue;
    for (const keyword of input.bankAliases) {
      const seedKey = `bank-rule:${keyword}`;
      if (await BankRule.exists({ $or: [{ seedKey }, { keyword, accountId: null }] })) continue;
      await BankRule.create({ seedKey, keyword, accountId: null, direction: 'any', counterAccountId: target._id, vendorName: vendor.name, office: input.bankOffice, priority: 0 });
    }
  }
}
module.exports = { ensureMerchantSetup, ensureVendor };
