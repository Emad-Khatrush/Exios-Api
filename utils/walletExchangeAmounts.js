const ErrorHandler = require('./errorHandler');
const fail = text => new ErrorHandler(400, text);
const MAX_MINOR = 1000000000000n;
const SCALE = 1000000n;

function decimal(value, digits, label) {
  if (!['string', 'number'].includes(typeof value)) throw fail(`${label} غير صالح`);
  const text = String(value).trim();
  if (!new RegExp(`^\\d{1,13}(?:\\.\\d{1,${digits}})?$`).test(text)) throw fail(`${label} غير صالح؛ استخدم أرقامًا موجبة بحد أقصى ${digits} منازل عشرية`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
}
const roundedDivide = (n, d) => (n + d / 2n) / d;

function quote(input) {
  if (!['USD', 'LYD'].includes(input.fromCurrency)) throw fail('اختر محفظة الدولار أو الدينار');
  const from = decimal(input.amount, 2, 'المبلغ');
  if (from <= 0n || from > MAX_MINOR) throw fail('المبلغ خارج الحد المسموح');
  const pricingMode = input.pricingMode ?? (input.toAmount !== undefined ? 'received' : 'rate');
  if (!['rate', 'received'].includes(pricingMode)) throw fail('طريقة حساب الصرافة غير صالحة');
  let rate, to;
  if (pricingMode === 'received') {
    to = decimal(input.toAmount, 2, 'المبلغ بعد الصرافة');
    if (to <= 0n || to > MAX_MINOR) throw fail('المبلغ بعد الصرافة خارج الحد المسموح');
    const usd = input.fromCurrency === 'USD' ? from : to;
    const lyd = input.fromCurrency === 'USD' ? to : from;
    if (lyd * SCALE < usd || lyd > usd * 1000000n) throw fail('سعر الصرف المحسوب خارج الحد المسموح');
    rate = roundedDivide(lyd * SCALE, usd);
  } else {
    rate = decimal(input.rate, 6, 'سعر الصرف');
    if (rate <= 0n || rate > SCALE * 1000000n) throw fail('سعر الصرف خارج الحد المسموح');
    to = input.fromCurrency === 'USD' ? roundedDivide(from * rate, SCALE) : roundedDivide(from * SCALE, rate);
  }
  if (rate <= 0n || rate > SCALE * 1000000n) throw fail('سعر الصرف خارج الحد المسموح');
  if (to <= 0n || to > MAX_MINOR) throw fail('المبلغ الناتج صغير جدًا أو خارج الحد المسموح');
  return { fromCurrency: input.fromCurrency, toCurrency: input.fromCurrency === 'USD' ? 'LYD' : 'USD',
    fromMinor: Number(from), toMinor: Number(to), rate: (Number(rate) / Number(SCALE)).toFixed(6), pricingMode };
}

function operationDate(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw fail('اختر تاريخ العملية');
  const date = new Date(`${day}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw fail('تاريخ العملية غير صالح');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (day > today) throw fail('لا يمكن تسجيل صرافة بتاريخ مستقبلي');
  return date;
}
module.exports = { quote, operationDate };
