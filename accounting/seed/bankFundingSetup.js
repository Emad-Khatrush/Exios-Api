const { Account, Journal } = require('../models');
// Investments and owner loans stay outside payment accounts. Their native TRY balance
// is posted by the bank importer, alongside the USD carrying value.
const BANK_SUPPORT_ACCOUNTS = [
  { seedKey: 'investment:albaraka:RBV:TRY', code: '160100', parent: '16', name: 'استثمار صندوق البركة RBV - ليرة', nameEn: 'Albaraka RBV fund - TRY', type: 'asset', cashFlowCategory: 'investing' },
  { seedKey: 'investment:albaraka:katilim:TRY', code: '160200', parent: '16', name: 'استثمار حساب مشاركة البركة - ليرة', nameEn: 'Albaraka participation deposit - TRY', type: 'asset', cashFlowCategory: 'investing' },
  { seedKey: 'cash:turkey:TRY', code: '110109', parent: '1101', name: 'خزينة تركيا - ليرة', nameEn: 'Turkey cash - TRY', type: 'asset', isCash: true, cashKind: 'cash' },
  { seedKey: 'loan:emad-kaya:TRY', code: '230200', parent: '23', name: 'قرض عماد - EMAD KAYA - ليرة', nameEn: 'EMAD KAYA owner loan - TRY', type: 'liability', cashFlowCategory: 'financing' },
];
async function ensureSupportAccounts() {
  let investmentGroup = await Account.findOne({ seedKey: 'bank-investments' });
  if (!investmentGroup) {
    const root = await Account.findOne({ seedKey: '1' }) || await Account.findOne({ code: '1', isGroup: true });
    if (root) {
      let code = 16;
      while (await Account.exists({ code: String(code) })) code++;
      investmentGroup = await Account.create({ seedKey: 'bank-investments', code: String(code), name: 'الاستثمارات المالية', nameEn: 'Financial investments', type: 'asset', isGroup: true, parentId: root._id, cashFlowCategory: 'investing' });
    }
  }
  for (const definition of BANK_SUPPORT_ACCOUNTS) {
    const { parent, code: preferredCode, ...fields } = definition;
    if (await Account.exists({ seedKey: fields.seedKey })) continue;
    // Reuse the single main Turkey TRY cash box, if one already exists.
    const cash = fields.isCash && await Account.find({ type: 'asset', isCash: true, cashKind: 'cash', currency: 'TRY', office: 'turkey', subBox: false, isActive: true, seedKey: { $exists: false } });
    if (cash && cash.length === 1) { cash[0].seedKey = fields.seedKey; await cash[0].save(); continue; }
    const group = parent === '16' ? investmentGroup : await Account.findOne({ seedKey: parent }) || await Account.findOne({ code: parent, isGroup: true });
    if (!group) continue;
    let code = Number(preferredCode);
    while (await Account.exists({ code: String(code) })) code++;
    await Account.create({ ...fields, code: String(code), currency: 'TRY', office: 'turkey', parentId: group._id });
  }
  const cash = await Account.findOne({ seedKey: 'cash:turkey:TRY' });
  if (cash && !await Journal.exists({ defaultAccountId: cash._id })) {
    let code = 'CASH-TUR-TRY';
    for (let index = 2; await Journal.exists({ code }); index++) code = `CASH-TUR-TRY-${index}`;
    await Journal.create({ code, name: cash.name, type: 'cash', defaultAccountId: cash._id, office: 'turkey', sequencePrefix: code });
  }
}
async function ensureBankFundingSetup() {
  await ensureSupportAccounts();
  const seedKey = 'funding:yusuf:TRY';
  let existing = await Account.findOne({ seedKey });
  if (!existing) existing = await Account.findOne({ name: 'جاري يوسف الأحمر - ليرة', currency: 'TRY', type: 'liability', isCash: true, seedKey: { $exists: false } });
  if (existing && !existing.seedKey) { existing.seedKey = seedKey; await existing.save(); }
  const parent = await Account.findOne({ seedKey: '26' }) || await Account.findOne({ code: '26', isGroup: true });
  if (!existing) {
    if (!parent) return;
    let code = 260200;
    while (await Account.exists({ code: String(code) })) code++;
    existing = await Account.create({ seedKey, code: String(code), name: 'جاري يوسف الأحمر - ليرة', nameEn: 'Yusuf Alahmar purchase funding - TRY',
      type: 'liability', currency: 'TRY', isCash: true, cashKind: 'current', office: 'turkey', parentId: parent._id });
  }
  if (!await Journal.exists({ defaultAccountId: existing._id })) {
    let code = 'CUR-YUSUF-TRY';
    for (let index = 2; await Journal.exists({ code }); index++) code = `CUR-YUSUF-TRY-${index}`;
    await Journal.create({ code, name: existing.name, type: 'bank', defaultAccountId: existing._id, office: existing.office, sequencePrefix: code });
  }
  require('../services/config').invalidateConfig();
}
module.exports = { ensureBankFundingSetup, BANK_SUPPORT_ACCOUNTS };
