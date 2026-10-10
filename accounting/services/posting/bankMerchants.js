const { Vendor } = require('../../models/documents');
const { Account } = require('../../models');
const normalize = text => String(text || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Remove only trailing monetary information, keeping the actual submerchant after MF*/TAP*.
const merchantKey = text => normalize(String(text || '').replace(/\([^)]*\)\s*$/, '')
  .replace(/(?:orijinal\s*işlem\s*tutarı\s*:?\s*)?[\d.,]+\s*[A-Z]{3}(?:\s*\([^)]*\))?\s*$/i, '').trim());
const prefix = (text, alias) => {
  const key = normalize(alias);
  return key.length >= 3 && (` ${text}`.includes(` ${key}`));
};
// Wasl's generic Alipay remittance description names a payment channel, not
// the shop that sold the goods. Keep real shop names in longer descriptions
// eligible for the normal supplier check, and never learn this generic text.
function isPaymentChannel(line, account) {
  if (account?.cashKind !== 'current') return false;
  const text = normalize(line.description);
  if (!/^حوال[ةه] عبر alipay(?: |$)/u.test(text)) return false;
  const neutral = new Set(['حوالة', 'حواله', 'عبر', 'alipay', 'بقيمة', 'تم', 'الحساب', 'بسعر', 'صرف', 'usd', 'cny', 'دولار', 'يوان']);
  return text.split(' ').every(word => neutral.has(word) || /^\d+$/.test(word));
}
async function matcher(accountId, session) {
  const account = await Account.findById(accountId).select('cashKind').session(session || null).lean();
  const vendors = await Vendor.find({ isActive: true, type: { $in: ['supplier', 'service'] } }).session(session || null).lean();
  const details = v => ({ vendorType: v.type, bankPurpose: v.bankPurpose, bankAccountCode: v.bankAccountCode, bankOffice: v.bankOffice });
  return line => {
    const text = merchantKey(line.description);
    if (!text || line.movementKind === 'card_payment' || isPaymentChannel(line, account)) return null;
    const channelDescription = account?.cashKind === 'current' && /^حوال[ةه] عبر alipay(?: |$)/u.test(normalize(line.description));
    const genericIdentity = alias => /^(?:حوال[ةه] عبر )?alipay$/u.test(normalize(alias));
    const eligibleVendors = channelDescription ? vendors.filter(v => !genericIdentity(v.name)) : vendors;
    const mapped = eligibleVendors.flatMap(v => (v.bankMappings || []).filter(m => String(m.accountId) === String(accountId) && m.merchant === text)
      .map(m => ({ vendorId: v._id, vendorName: v.name, counterAccountId: m.counterAccountId, learned: true, ...details(v) })));
    if (mapped.length) return mapped.length === 1 ? mapped[0] : null;
    const found = eligibleVendors.map(v => ({ v, length: Math.max(0, ...[v.name, ...(v.bankAliases || [])]
      .filter(alias => (!channelDescription || !genericIdentity(alias)) && prefix(text, alias)).map(alias => normalize(alias).length)) })).filter(m => m.length);
    const best = found.sort((a, b) => b.length - a.length);
    if (!best.length || (best[1] && best[0].length === best[1].length)) return null;
    return { vendorId: best[0].v._id, vendorName: best[0].v.name, learned: false, ...details(best[0].v) };
  };
}
async function learn(line, vendorId, counterAccountId, session) {
  const merchant = merchantKey(line.description);
  // A gateway name alone cannot identify its many independent shops.
  if (!vendorId || merchant.length < 3 || /^(mf|tap|salla|myfatoorah|amwal pay)$/.test(merchant)) return;
  const account = await Account.findById(line.accountId).select('cashKind').session(session || null).lean();
  if (isPaymentChannel(line, account)) return;
  // A generic vendor (historical purchases, cash expenses) stands for many suppliers: never a merchant's identity
  const vendor = await Vendor.findById(vendorId).select('seedKey').session(session || null).lean();
  if (['historical_supplier', 'historical_carrier', 'cash_expenses'].includes(vendor?.seedKey)) return;
  const mapping = { accountId: line.accountId, merchant, ...(counterAccountId && { counterAccountId }) };
  await Vendor.updateMany({ 'bankMappings': { $elemMatch: { accountId: line.accountId, merchant } } },
    { $pull: { bankMappings: { accountId: line.accountId, merchant } } }, { session });
  await Vendor.updateOne({ _id: vendorId, isActive: true }, { $push: { bankMappings: mapping } }, { session });
}
module.exports = { matcher, learn, merchantKey, isPaymentChannel };
