// Readers for the statements of the company's own banks. The text a PDF gives is often glued
// together (no spaces between columns, "48.184,0373.184,03" for an amount and a balance), which no
// general reader can split safely; each bank's layout is known, so it is read by its own pattern.
// A statement no reader recognises goes to the general reader in bank.js.
//
// Every reader returns rows { day, description, reference, amount, balanceAfter } with the
// statement's own signs, and may add { counterAmount, counterCurrency } when the line says what
// the other side received (a currency sale: "48734.41 TRY Karşılığı 1000.00 USD Satış").

const TR_AMOUNT = '-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}';
const US_AMOUNT = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}';
const trNumber = (text) => Number(String(text).replace(/\./g, '').replace(',', '.'));
const usNumber = (text) => Number(String(text).replace(/,/g, ''));
const round2 = (value) => Math.round(value * 100) / 100;

const TR_MONTHS = { ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12 };
const dotDay = (text) => { const [d, m, y] = text.split('.'); return `${y}-${m}-${d}`; };

// ---- Kuveyt Türk current account (Hesap Özeti) ----
// "01.09.2026A05XFKrediKartıNo:5398********5271,KrediKartıBorçÖdemesi-25.000,0048.184,03"
const kuveytAccount = {
  name: 'Kuveyt Türk - hesap özeti',
  detect: (text) => /HESAP\s*ÖZET/i.test(text) && /KUVEYT/i.test(text) && /Bakiye/i.test(text),
  parse(text) {
    const pattern = new RegExp(`^(\\d{2}\\.\\d{2}\\.\\d{4})([A-Z0-9]{5})(.+?)(${TR_AMOUNT})(${TR_AMOUNT})$`);
    const rows = [];
    for (const raw of text.split(/\r?\n/)) {
      const match = raw.trim().match(pattern);
      if (!match) continue;
      const [, day, reference, body, amount, balance] = match;
      // The text comes without spaces: the two kinds of line are written out again readably
      const card = body.match(/KrediKartıNo:([\d*]+)/);
      let description = body;
      if (/KrediKartıBorçÖdemesi/i.test(body)) description = `Kredi Kartı Borç Ödemesi${card ? ` (kart ${card[1].slice(-4)})` : ''}`;
      else if (/FASTParaTransferi/i.test(body)) description = `FAST Para Transferi - Gönderen: ${(body.match(/Gönderen:([^,]+)/) || [])[1] || ''}`.trim();
      rows.push({ day: dotDay(day), description, reference, amount: trNumber(amount), balanceAfter: trNumber(balance) });
    }
    return rows;
  },
};

// ---- Albaraka Türk credit card (Kredi Kartı Ekstresi) ----
// "04 Eylül2026ÖDEMEİÇİN TEŞEKKÜREDERİZ+72.348,19"          one line
// "13 Eylül2026world.taobao.comLUXEMBOURGLU"                 then
// "OrijinalİşlemTutarı:206,85USD"                            then
// "10.222,47"
const albarakaCard = {
  name: 'Albaraka - kredi kartı',
  creditCard: true,
  detect: (text) => /alBaraka/i.test(text) && /Kredi\s*Kartı\s*Ekstre/i.test(text),
  parse(text) {
    const start = /^(\d{1,2}) (Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s*(\d{4})(.*)$/i;
    const amountOnly = new RegExp(`^([+-]?)(${TR_AMOUNT.replace('-?', '')})$`);
    const amountAtEnd = new RegExp(`^(.*?)([+-]?)(${TR_AMOUNT.replace('-?', '')})$`);
    const rows = [];
    let open = null;
    const close = (sign, amount) => {
      // A payment is printed with "+": on a card statement it is the negative side (money to the card)
      const value = sign ? -trNumber(amount) : trNumber(amount);
      rows.push({ day: open.day, description: open.description + (open.foreign ? ` (${open.foreign})` : ''), reference: '', amount: value, balanceAfter: null });
      open = null;
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const head = line.match(start);
      if (head) {
        const day = `${head[3]}-${String(TR_MONTHS[head[2].toLocaleLowerCase('tr')]).padStart(2, '0')}-${head[1].padStart(2, '0')}`;
        const rest = head[4].trim();
        const withAmount = rest.match(amountAtEnd);
        open = { day, description: withAmount ? withAmount[1].trim() : rest, foreign: null };
        if (withAmount) close(withAmount[2], withAmount[3]);
        continue;
      }
      if (!open) continue;
      const foreign = line.match(/OrijinalİşlemTutarı:\s*([\d.,]+)\s*([A-Z]{3})(?:,\s*USD\s*Karşılığı:\s*([\d.,]+)\s*USD)?/i);
      if (foreign) {
        const original = `${trNumber(foreign[1]).toFixed(2)} ${foreign[2].toUpperCase()}`;
        // "17,30KWD,USD Karşılığı:564,38USD": the dollars are kept last, where the bill reads them
        if (foreign[3]) open.description += ` ${original}`;
        open.foreign = foreign[3] ? `${trNumber(foreign[3]).toFixed(2)} USD` : original;
        continue;
      }
      const amount = line.match(amountOnly);
      if (amount) close(amount[1], amount[2]);
    }
    return rows;
  },
};

// ---- Albaraka Türk current account export (Tarih / Fiş No / Açıklama / Tutar) ----
// "28.09.202612646797784.52 TRY Karşılığı 2000.00 USD Satış, Kur: 48.89226-2000.00"
// "23.09.20261306EMAD SULEIMAN ALI SULEIMAN KHATRUSH/Ortaklık/Şirket Yetkilisi 13000.00"
const albarakaAccount = {
  name: 'Albaraka - hesap hareketleri',
  detect: (text) => /Fiş\s*No/i.test(text) && /Tutar\s*\((USD|TRY|EUR)\)/i.test(text),
  parse(text) {
    const rows = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const whole = line.match(/^(\d{2}\.\d{2}\.\d{4})(.*?)(-?\d+\.\d{2})$/);
      if (!whole) continue;
      const [, day, body, amount] = whole;
      let description = body.trim();
      let reference = '';
      const row = { day: dotDay(day), amount: Number(amount), balanceAfter: null };
      // A sale of the account's currency: what the other account received is worked out from the
      // rate, since the receipt number is glued to it ("126467" + "97784.52")
      const sale = body.match(/([\d.]+) TRY Karşılığı (\d+\.\d{2}) (USD|EUR) Satış, Kur: ([\d.]+)/);
      if (sale) {
        // The receipt number is glued in front of the lira amount ("5331153000.00"): the amount is
        // the ending of those digits that the rate confirms
        const expected = Number(sale[2]) * Number(sale[4]);
        const [whole, cents] = sale[1].split('.');
        let received = round2(expected);
        for (let start = 0; start < whole.length; start++) {
          const candidate = Number(`${whole.slice(start)}.${cents || '00'}`);
          if (Math.abs(candidate - expected) < 1) { received = candidate; break; }
        }
        description = `${received.toFixed(2)} TRY Karşılığı ${sale[2]} ${sale[3]} Satış, Kur: ${sale[4]}`;
        row.counterAmount = received;
        row.counterCurrency = 'TRY';
      } else {
        // The receipt number comes first, glued to the text: it is dropped
        const bankRef = body.match(/\d{9}OS\d{5}/);
        if (bankRef) reference = bankRef[0];
        description = (bankRef ? body.replace(bankRef[0], ' ') : body).replace(/^\d+/, '').replace(/\s*-\s*-\s*/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').replace(/\s+/g, ' ').trim() || body;
      }
      rows.push({ ...row, description, reference });
    }
    return rows;
  },
};

// ---- Al Mutaheda exchange office (Arabic statement of a client account) ----
// "19,393.010.007,687.002026/09/281414 // -1207": balance, credit (in), debit (out), date, text
const almutaheda = {
  name: 'المتحدة - كشف حساب عميل',
  detect: (text) => /AL\s*MUTAHEDA/i.test(text) && /Pre Balance/i.test(text),
  parse(text) {
    const pattern = new RegExp(`^(${US_AMOUNT})(${US_AMOUNT})(${US_AMOUNT})(\\d{4}/\\d{2}/\\d{2})(.*)$`);
    const rows = [];
    for (const raw of text.split(/\r?\n/)) {
      const match = raw.trim().match(pattern);
      if (!match) continue;
      const [, balance, credit, debit, date, body] = match;
      if (/Pre Balance/i.test(body)) continue;
      // "دائن / علينا" is money the office holds for us (in), "مدين / لنا" money that left (out)
      const amount = round2(usNumber(credit) - usNumber(debit));
      if (!amount) continue;
      const description = body.replace(/\s+/g, ' ').trim();
      rows.push({ day: date.replace(/\//g, '-'), description, reference: '', amount, balanceAfter: usNumber(balance) });
    }
    return rows;
  },
};

// Kuveyt Türk card is read by the general reader (its amounts are followed by "TL")
const FORMATS = [kuveytAccount, albarakaCard, albarakaAccount, almutaheda];

function readKnownFormat(text) {
  const format = FORMATS.find((item) => item.detect(text));
  if (!format) return null;
  return { format: format.name, creditCard: !!format.creditCard, rows: format.parse(text) };
}

module.exports = { readKnownFormat, FORMATS };
