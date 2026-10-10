// Preserve the supplier's currency independently of the bank's USD equivalent and settlement.
const NAMES = {
  'us dollar': 'USD', usd: 'USD', euro: 'EUR', eur: 'EUR', 'kuwaiti dinar': 'KWD', 'saudi riyal': 'SAR',
  'uae dirham': 'AED', 'pound sterling': 'GBP', 'rial omani': 'OMR', 'bahraini dinar': 'BHD', 'qatari riyal': 'QAR',
  'türk lirası': 'TRY', 'turk lirasi': 'TRY', try: 'TRY', 'chinese yuan': 'CNY', 'yuan renminbi': 'CNY', cny: 'CNY',
};
const currencyName = name => NAMES[String(name).trim().toLowerCase()] || (/^[A-Z]{3}$/.test(String(name)) ? name : null);

function originalOf(line, currency, decimals = currency === 'LYD' ? 3 : 2) {
  if (Number(line.originalAmount) > 0 && line.originalCurrency) return { amount: Number(line.originalAmount), currency: line.originalCurrency };
  // Older imported Albaraka rows carry "17.30 KWD (564.38 USD)". Keep the first currency.
  const text = String(line.description || '');
  const original = text.match(/([\d,]+\.\d{2,3})\s+(KWD|OMR|BHD|SAR|EUR|AED|GBP|QAR|CNY)\s*\(/);
  if (original) return { amount: Number(original[1].replace(/,/g, '')), currency: original[2] };
  const foreign = text.match(/\((-?[\d,]+\.\d{2,3})\s+([^)]+)\)\s*$/);
  const code = foreign && currencyName(foreign[2]);
  if (code) return { amount: Math.abs(Number(foreign[1].replace(/,/g, ''))), currency: code };
  return { amount: Math.abs(line.amount) / 10 ** decimals, currency };
}

function dollarsOf(line, original, input = {}) {
  const printed = Number(line.settlementUsd) || (original.currency === 'USD' ? original.amount : 0);
  const manual = Number(input.settlementUsd);
  if (input.settlementUsd !== undefined && (!Number.isFinite(manual) || manual <= 0)) throw new Error('مقابل العملية بالدولار يجب أن يكون أكبر من صفر');
  if (printed > 0 && manual > 0 && Math.abs(printed - manual) > 0.005) throw new Error('مقابل الدولار المدخل يختلف عن المبلغ المكتوب في كشف البنك');
  if (printed > 0) return printed;
  if (manual > 0) return manual;
  const legacy = String(line.description || '').match(/\(([\d,]+\.\d{2,3})\s+(?:USD|US Dollar)\)\s*$/i);
  return legacy ? Number(legacy[1].replace(/,/g, '')) : null;
}

async function paymentValue(line, bank, input, session) {
  const { getConfig } = require('../config');
  const { RateBook, valueOut } = require('./common');
  const currency = bank.currency || 'USD';
  const { currencies } = await getConfig();
  const decimals = currencies.get(currency)?.decimals ?? 2;
  const paid = Math.abs(line.amount) / 10 ** decimals;
  const original = originalOf(line, currency, decimals);
  let usd = dollarsOf(line, original, input);
  if (currency === 'USD') usd = paid;
  const rates = new RateBook(session, { nearest: true });
  const directCross = !usd && original.currency !== currency && original.currency !== 'USD';
  const valuationSource = directCross ? 'direct_cross' : usd ? 'statement' : 'account_value';
  // No USD quote is fabricated for a direct SAR/TRY (or other) purchase. USD remains only
  // the ledger's reporting unit: carry the bank's actual debit at its book value.
  if (!usd) {
    usd = (await valueOut(bank, Math.abs(line.amount), { day: line.day, rates })) / 100;
  }
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error('تعذّر تحديد قيمة العملية بالدولار');
  return { paid, usd, original, rate: currency === 'USD' ? undefined : paid / usd, rates, valuationSource, directCross,
    crossRate: paid / original.amount, baseCurrency: original.currency, quoteCurrency: currency };
}

module.exports = { originalOf, dollarsOf, paymentValue, currencyName };
