const { fail } = require('./common');
const { matcher } = require('./bankMerchants');
function assertDirection(line, refund) {
  if (!Number.isFinite(Number(line.amount)) || !Number(line.amount)) throw fail('مبلغ سطر الكشف غير صالح');
  if (refund && (Number(line.amount) <= 0 || line.movementKind === 'card_payment')) throw fail('هذه الحركة شراء أو سداد بطاقة وليست استرداداً وارداً؛ صحح اتجاه السطر أو اختر سداد المشتريات');
  if (!refund && Number(line.amount) >= 0) throw fail('سداد المشتريات يتطلب مبلغاً خارجاً من الحساب');
}
async function assertMerchant(line, bank, vendorId, session) {
  const merchant = (await matcher(bank._id, session))(line);
  if (merchant && String(merchant.vendorId) !== String(vendorId?._id || vendorId)) throw fail(`المورد المختار مختلف عن تاجر الكشف (${merchant.vendorName})؛ اختر الفاتورة الأصلية للمورد الصحيح`);
  return merchant;
}
module.exports = { assertDirection, assertMerchant };
