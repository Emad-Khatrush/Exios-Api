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
  // A phone photo: glare can split a machine line in two and the photo's edge can cut its first
  // letters. What is left of the second line still shows the end of the number, its check digit, the
  // nationality and the birth date: "…B123456<4LBY900101". The printed "Passport No." field then
  // gives the whole number, which the check digit confirms.
  const fragments = [];
  for (const line of lines.concat(String(text || '').split(/\r?\n/).map((l) => l.toUpperCase().replace(/\s+/g, '')))) {
    const m = line.match(/([A-Z0-9]+)(<*)([0-9])[A-Z<]{3}[0-9]{6}/);
    if (m) fragments.push({ tail: m[1], field: `${m[1]}${m[2]}`, digit: Number(m[3]) });
  }
  // A fragment that holds the whole number field (9 characters) checks itself
  for (const f of fragments) {
    if (f.field.length === 9 && isValid(f.tail) && checkDigit(f.field) === f.digit) return { number: f.tail, checked: true };
  }
  const printed = printedNumbers(text);
  const pad9 = (n) => `${n}<<<<<<<<<`.slice(0, 9);
  for (const number of printed) {
    if (fragments.some((f) => number.endsWith(f.tail) && checkDigit(pad9(number)) === f.digit)) return { number, checked: true };
  }
  const any = printed[0] || candidates.map((l) => normalize(l.slice(0, 9).replace(/</g, ''))).find(isValid)
    || fragments.map((f) => f.tail).find(isValid);
  return any ? { number: any, checked: false } : null;
}

// Numbers printed on the page, the one right after a "Passport No." label first
function printedNumbers(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim().toUpperCase());
  const looks = (t) => isValid(t) && /[0-9]/.test(t) && /^[A-Z]{0,3}[0-9]+[A-Z0-9]*$/.test(t);
  const found = [];
  lines.forEach((line, i) => {
    if (/PASSPORT\s*N[O0]/.test(line)) {
      const after = `${line.replace(/.*PASSPORT\s*N[O0]\.?/, '')} ${lines[i + 1] || ''}`;
      after.split(/\s+/).map(normalize).filter(looks).forEach((t) => found.push(t));
    }
  });
  lines.forEach((line) => line.split(/\s+/).map(normalize).filter(looks).forEach((t) => found.push(t)));
  return [...new Set(found)];
}

// What a photo's text says: the number (or null), and whether it looks like a passport at all (the
// word PASSPORT or جواز, a machine line, or a passport number was found). Owner, 2026-11-20: a photo
// that is not a passport is pointed out to the customer, who is told it would be rejected.
function analyze(text) {
  const read = fromMrz(text);
  const upper = String(text || '').toUpperCase();
  const compact = upper.replace(/\s+/g, '');
  // Only a passport's own signs count: its name, a machine line ("P<LBY…", "…<9LBY970821"), or a
  // number its check digit confirms. Any other number (a phone, an order, a date on an ID card) is
  // neither a sign nor a number to offer.
  const passport = !!read?.checked || /PASSPORT|PASSEPORT|PASAPORTE|REISEPASS|جواز/.test(upper)
    || /P<[A-Z]{3}/.test(compact) || /<[0-9][A-Z]{3}[0-9]{6}/.test(compact);
  return { number: passport && read ? read.number : null, checked: !!(passport && read?.checked), passport };
}

// What a passport photo says (Google Cloud Vision): { number, checked, passport }; null when the
// service could not be used (QA, no keys, Vision not enabled): the customer then types the number.
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
    return analyze(answer?.fullTextAnnotation?.text || answer?.textAnnotations?.[0]?.description || '');
  } catch (error) {
    console.error('[passport] read:', error?.response?.data?.error?.message || error.message);
    return null;
  }
}

module.exports = { normalize, isValid, checkDigit, fromMrz, analyze, readFromImage };
