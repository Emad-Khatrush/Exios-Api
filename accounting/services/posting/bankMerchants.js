const { Vendor } = require('../../models/documents');
const normalize = text => String(text || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Remove only trailing monetary information, keeping the actual submerchant after MF*/TAP*.
const merchantKey = text => normalize(String(text || '').replace(/\([^)]*\)\s*$/, '')
  .replace(/(?:orijinal\s*işlem\s*tutarı\s*:?\s*)?[\d.,]+\s*[A-Z]{3}(?:\s*\([^)]*\))?\s*$/i, '').trim());
const prefix = (text, alias) => {
  const key = normalize(alias);
  return key.length >= 3 && (` ${text}`.includes(` ${key}`));
};
async function matcher(accountId, session) {
  const vendors = await Vendor.find({ isActive: true, type: 'supplier' }).session(session || null).lean();
  return line => {
    const text = merchantKey(line.description);
    if (!text || line.movementKind === 'card_payment') return null;
    const mapped = vendors.flatMap(v => (v.bankMappings || []).filter(m => String(m.accountId) === String(accountId) && m.merchant === text)
      .map(m => ({ vendorId: v._id, vendorName: v.name, counterAccountId: m.counterAccountId, learned: true })));
    if (mapped.length) return mapped.length === 1 ? mapped[0] : null;
    const found = vendors.map(v => ({ v, length: Math.max(0, ...[v.name, ...(v.bankAliases || [])]
      .filter(alias => prefix(text, alias)).map(alias => normalize(alias).length)) })).filter(m => m.length);
    const best = found.sort((a, b) => b.length - a.length);
    if (!best.length || (best[1] && best[0].length === best[1].length)) return null;
    return { vendorId: best[0].v._id, vendorName: best[0].v.name, learned: false };
  };
}
async function learn(line, vendorId, counterAccountId, session) {
  const merchant = merchantKey(line.description);
  // A gateway name alone cannot identify its many independent shops.
  if (!vendorId || merchant.length < 3 || /^(mf|tap|salla|myfatoorah|amwal pay)$/.test(merchant)) return;
  const mapping = { accountId: line.accountId, merchant, ...(counterAccountId && { counterAccountId }) };
  await Vendor.updateMany({ 'bankMappings': { $elemMatch: { accountId: line.accountId, merchant } } },
    { $pull: { bankMappings: { accountId: line.accountId, merchant } } }, { session });
  await Vendor.updateOne({ _id: vendorId, isActive: true }, { $push: { bankMappings: mapping } }, { session });
}
module.exports = { matcher, learn, merchantKey };
