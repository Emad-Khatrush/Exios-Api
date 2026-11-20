// The passport number at sign-up (owner, 2026-11-20): read from the photo, confirmed by the customer,
// unique among accounts, and editable by staff when they approve the passport.
//
// A passport's two machine-readable lines at the bottom (MRZ, ICAO 9303 "TD3": 2 lines of 44
// characters) carry the number in the first 9 characters of the second line, followed by a check
// digit. Reading it from there, with the check digit, is far more reliable than the printed field.

// What is stored and compared: letters and digits only, upper case
const normalize = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// A plausible passport number (Libyan and most others: 6 to 12 letters and digits)
const isValid = (value) => /^[A-Z0-9]{6,12}$/.test(normalize(value));

// ICAO 9303 check digit: weights 7, 3, 1; digits as themselves, A-Z as 10-35, '<' as 0
function checkDigit(text) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const v = c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

// The passport number in OCR text, or null. `checked`: its check digit matched.
function fromMrz(text) {
  const lines = String(text || '').split(/\r?\n/)
    .map((l) => l.toUpperCase().replace(/\s+/g, '').replace(/[«‹]/g, '<'))
    .filter((l) => /^[A-Z0-9<]{30,46}$/.test(l) && l.includes('<'));
  // The second line starts with the number; the first starts with "P<" (or "P" and a type letter)
  const candidates = lines.filter((l) => !/^P[A-Z<]/.test(l));
  for (const line of candidates) {
    const raw = line.slice(0, 9);
    const digit = line[9];
    if (!/^[0-9]$/.test(digit || '')) continue;
    // OCR often reads the letter O for the digit 0 here
    for (const field of [raw, raw.replace(/O/g, '0')]) {
      const number = normalize(field.replace(/</g, ''));
      if (isValid(number) && checkDigit(field) === Number(digit)) return { number, checked: true };
    }
  }
  const any = candidates.map((l) => normalize(l.slice(0, 9).replace(/</g, ''))).find(isValid);
  return any ? { number: any, checked: false } : null;
}

// The number read from a passport photo (Google Cloud Vision), or null when it cannot be read or the
// service is not set up (QA, no keys, Vision not enabled): the customer then types it.
async function readFromImage(buffer) {
  if (!buffer?.length) return null;
  try {
    const { googleAuthClient } = require('./googleClould');
    const client = googleAuthClient();
    if (!client) return null;
    const res = await client.request({
      url: 'https://vision.googleapis.com/v1/images:annotate',
      method: 'POST',
      timeout: 15000,
      data: { requests: [{ image: { content: buffer.toString('base64') }, features: [{ type: 'TEXT_DETECTION' }] }] },
    });
    const answer = res?.data?.responses?.[0];
    if (answer?.error) throw new Error(answer.error.message);
    return fromMrz(answer?.fullTextAnnotation?.text || answer?.textAnnotations?.[0]?.description || '');
  } catch (error) {
    console.error('[passport] read:', error?.response?.data?.error?.message || error.message);
    return null;
  }
}

module.exports = { normalize, isValid, checkDigit, fromMrz, readFromImage };
