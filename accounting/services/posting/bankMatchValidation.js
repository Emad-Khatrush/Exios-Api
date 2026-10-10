const { fail } = require('./common');
const { matcher, learn, merchantKey } = require('./bankMerchants');
// Vendors that stand for many real suppliers: a statement merchant is never learned as one of them
const GENERIC_VENDORS = ['historical_supplier', 'historical_carrier', 'cash_expenses'];
function assertDirection(line, refund) {
  require('./alipayReconciliation').assertWallet(line);
  if (!Number.isFinite(Number(line.amount)) || !Number(line.amount)) throw fail('مبلغ سطر الكشف غير صالح');
  if (refund && (Number(line.amount) <= 0 || line.movementKind === 'card_payment')) throw fail('هذه الحركة شراء أو سداد بطاقة وليست استرداداً وارداً؛ صحح اتجاه السطر أو اختر سداد المشتريات');
  if (!refund && Number(line.amount) >= 0) throw fail('سداد المشتريات يتطلب مبلغاً خارجاً من الحساب');
}
// The statement names a merchant known as another vendor than the bill's. The person may still
// approve after review (owner's request 2026-10-09); the merchant's identification is then corrected:
// the wrong learned link is dropped and the bill's vendor is learned. A generic bill vendor
// (historical purchases, cash expenses) never conflicts with a merchant.
async function assertMerchant(line, bank, vendorId, session, { confirmed = false, req } = {}) {
  const merchant = (await matcher(bank._id, session))(line);
  const billVendor = String(vendorId?._id || vendorId);
  if (!merchant || String(merchant.vendorId) === billVendor) return merchant;
  const { Vendor } = require('../../models/documents');
  const vendor = await Vendor.findById(billVendor).select('seedKey name').session(session).lean();
  // A generic vendor (historical purchases, cash expenses) stands for any supplier: no conflict, and
  // the merchant's real identity is kept
  if (vendor && GENERIC_VENDORS.includes(vendor.seedKey)) return merchant;
  if (!confirmed) throw fail(`المورد في الفاتورة مختلف عن تاجر الكشف (${merchant.vendorName}). راجع الفاتورة، وإن كانت نفس العملية فأكد ذلك ليُصحَّح ربط التاجر.`);
  const key = merchantKey(line.description);
  if (merchant.learned) {
    await Vendor.updateOne({ _id: merchant.vendorId }, { $pull: { bankMappings: { accountId: line.accountId, merchant: key } } }, { session });
  }
  const learned = !!vendor;
  if (learned) await learn(line, vendor._id, null, session);
  await require('../audit').logAudit({ req, action: 'bank.merchantCorrected', model: 'AccountingBankStatementLine', docId: line._id,
    before: { vendorId: merchant.vendorId, vendorName: merchant.vendorName, learned: merchant.learned },
    after: { vendorId: billVendor, vendorName: vendor?.name, learned } }, session);
  return merchant;
}
module.exports = { assertDirection, assertMerchant, GENERIC_VENDORS };
