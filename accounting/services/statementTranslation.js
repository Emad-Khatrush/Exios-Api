const crypto = require('crypto');
const mongoose = require('mongoose');
const { BankStatementLine } = require('../models/documents');
const Cache = require('../models/StatementTranslation');
const { fail } = require('./posting/common');
const ErrorHandler = require('../../utils/errorHandler');

// Translation is display metadata. Original evidence, fingerprints and posting stay untouched.
const dictionary = new Map([
  ['Kredi Kartı Borç Ödemesi', 'سداد دين البطاقة الائتمانية'],
  ['账户余额', 'رصيد الحساب'], ['转账红包', 'تحويل عبر ظرف نقدي'], ['收款', 'استلام مبلغ'],
  ['付款', 'دفع مبلغ'], ['退款', 'استرداد مبلغ'], ['交易成功', 'عملية ناجحة'], ['服务费', 'رسوم خدمة'],
]);
const inFlight = new Map();
let active = 0;
const waiting = [];
const LIMIT = 2;
const sourceHash = text => crypto.createHash('sha256').update(`ar:v1:${text}`).digest('hex');
const configuredUrl = () => process.env.LIBRETRANSLATE_URL
  || (process.env.NODE_ENV !== 'production' && process.env.EXIOS_QA !== '1' ? 'http://127.0.0.1:5005' : '');

async function withSlot(fn) {
  if (active >= LIMIT) {
    if (waiting.length >= 30) throw new ErrorHandler(429, 'الترجمة مشغولة؛ حاول مجددًا بعد قليل');
    await new Promise(resolve => waiting.push(resolve));
  } else active++;
  try { return await fn(); }
  finally { if (waiting.length) waiting.shift()(); else active--; }
}

async function engine(text) {
  if (dictionary.has(text.trim())) return { text: dictionary.get(text.trim()), sourceLanguage: 'dictionary', provider: 'dictionary' };
  const url = configuredUrl();
  if (!url) throw new ErrorHandler(503, 'خدمة الترجمة غير مفعّلة على هذه النسخة');
  // Long transaction identifiers remain literal and do not go to the translation engine.
  const pieces = text.split(/(\b\d{6,}\b)/g);
  const positions = pieces.map((piece, index) => ({ piece, index }))
    .filter(({ piece }) => !/^\d{6,}$/.test(piece) && /[\p{L}]/u.test(piece));
  if (!positions.length) return { text, sourceLanguage: 'und', provider: 'dictionary' };
  const source = /[\u3400-\u9fff]/.test(text) ? 'zh-Hans' : /[ğĞıİşŞ]/.test(text) ? 'tr' : 'auto';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ q: positions.map(({ piece }) => piece), source, target: 'ar', format: 'text',
        ...(process.env.LIBRETRANSLATE_API_KEY && { api_key: process.env.LIBRETRANSLATE_API_KEY }) }),
    });
    if (!response.ok) throw new ErrorHandler(503, 'تعذّرت الترجمة من المحرك؛ تأكد من تشغيل الخدمة وتوفر نماذج اللغات');
    const result = await response.json();
    const output = result.translatedText;
    if (!Array.isArray(output) || output.length !== positions.length || output.some(value => typeof value !== 'string' || !value.trim()))
      throw new ErrorHandler(502, 'لم يرجع المحرك ترجمة صالحة');
    positions.forEach(({ piece, index }, position) => {
      const leading = piece.match(/^\s*/)[0], trailing = piece.match(/\s*$/)[0];
      pieces[index] = leading + output[position].trim() + trailing;
    });
    const translated = pieces.join('');
    if (translated.length > 12000) throw new ErrorHandler(502, 'الترجمة أطول من الحجم المسموح');
    const detected = Array.isArray(result.detectedLanguage) ? result.detectedLanguage[0] : result.detectedLanguage;
    return { text: translated.trim(), sourceLanguage: detected?.language || source, provider: 'libretranslate' };
  } catch (error) {
    if (error.statusCode) throw error;
    throw new ErrorHandler(503, error.name === 'AbortError' ? 'استغرقت الترجمة وقتًا طويلًا؛ حاول مجددًا' : 'محرك الترجمة غير متصل؛ شغّل خدمة الترجمة المحلية ثم حاول مجددًا');
  } finally { clearTimeout(timer); }
}

async function cached(text, hash) {
  const existing = await Cache.findOne({ sourceHash: hash }).lean();
  if (existing) return existing;
  if (inFlight.has(hash)) return inFlight.get(hash);
  const promise = withSlot(async () => {
    const translation = await engine(text);
    try {
      return await Cache.findOneAndUpdate({ sourceHash: hash }, { $setOnInsert: { sourceHash: hash, original: text, targetLanguage: 'ar', ...translation } },
        { upsert: true, new: true, runValidators: true }).lean();
    } catch (error) {
      if (error.code === 11000) return Cache.findOne({ sourceHash: hash }).lean();
      throw error;
    }
  });
  inFlight.set(hash, promise);
  try { return await promise; } finally { inFlight.delete(hash); }
}

async function translateLine(id, req) {
  if (!mongoose.isValidObjectId(id)) throw fail('سطر الكشف غير صالح');
  const line = await BankStatementLine.findById(id).select('description descriptionTranslation').lean();
  if (!line) throw new ErrorHandler(404, 'سطر الكشف غير موجود');
  const text = line.description || '';
  if (!text.trim()) throw fail('لا يوجد بيان لترجمته');
  if (text.length > 4000) throw fail('البيان أطول من الحد المسموح للترجمة؛ افتح التفاصيل لمراجعته');
  const hash = sourceHash(text);
  if (line.descriptionTranslation?.sourceHash === hash) return { translation: line.descriptionTranslation, cached: true };
  const result = await cached(text, hash);
  const translation = { text: result.text, original: text, sourceHash: hash, sourceLanguage: result.sourceLanguage,
    targetLanguage: 'ar', provider: result.provider, translatedAt: new Date(), translatedBy: req?.user?._id };
  // A source edit while translating must not attach stale text to the new statement.
  const saved = await BankStatementLine.findOneAndUpdate({ _id: id, description: line.description },
    { $set: { descriptionTranslation: translation } }, { new: true, runValidators: true }).select('_id').lean();
  if (!saved) throw new ErrorHandler(409, 'تغير البيان أثناء الترجمة؛ حدّث السطر ثم حاول مجددًا');
  return { translation, cached: false };
}

module.exports = { translateLine };
