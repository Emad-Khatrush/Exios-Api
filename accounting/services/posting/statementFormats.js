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
      const value = sign === '+' ? -trNumber(amount) : trNumber(amount);
      const movementKind = sign === '+' ? (/ÖDEME|TEŞEKKÜR/i.test(open.description) ? 'card_payment' : 'purchase_refund') : 'purchase';
      rows.push({ day: open.day, description: open.description + (open.foreign ? ` (${open.foreign})` : ''), reference: '', amount: value, balanceAfter: null, movementKind });
      if (open.originalCurrency) Object.assign(rows[rows.length - 1], { originalAmount: open.originalAmount, originalCurrency: open.originalCurrency,
        ...(open.settlementUsd > 0 && { settlementUsd: open.settlementUsd }) });
      if (open.settlementUsd > 0) rows[rows.length - 1].settlementUsd = open.settlementUsd;
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
      const foreign = line.match(/Orijinal\s*İşlem\s*Tutarı:\s*([\d.,]+)\s*([A-Z]{3})(?:,\s*USD\s*Karşılığı:\s*([\d.,]+)\s*USD)?/i);
      if (foreign) {
        open.originalAmount = trNumber(foreign[1]);
        open.originalCurrency = foreign[2].toUpperCase();
        open.settlementUsd = foreign[3] ? trNumber(foreign[3]) : open.originalCurrency === 'USD' ? open.originalAmount : undefined;
        const original = `${trNumber(foreign[1]).toFixed(2)} ${foreign[2].toUpperCase()}`;
        // "17,30KWD,USD Karşılığı:564,38USD": the dollars are kept last, where the bill reads them
        if (foreign[3]) open.description += ` ${original}`;
        open.foreign = foreign[3] ? `${trNumber(foreign[3]).toFixed(2)} USD` : original;
        continue;
      }
      // Advertising statements may print only "USD Karşılığı" without
      // "Orijinal İşlem Tutarı". It is still the bank's actual USD valuation.
      const dollarEquivalent = line.match(/^USD\s*Karşılığı:\s*([\d.,]+)\s*USD/i);
      if (dollarEquivalent) {
        open.settlementUsd = trNumber(dollarEquivalent[1]);
        // The original currency is unknown: keep it unknown rather than invent USD.
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
        const accountCurrency = text.match(/Tutar\s*\((USD|TRY|EUR)\)/i)?.[1].toUpperCase();
        row.counterAmount = accountCurrency === 'TRY' ? Number(sale[2]) : received;
        row.counterCurrency = accountCurrency === 'TRY' ? sale[3].toUpperCase() : 'TRY';
        row.exchangeRate = Number(sale[4]);
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
    // A customer's running balance can become negative after a withdrawal. Its sign
    // must not cause the withdrawal (or the following commission) to disappear.
    const pattern = new RegExp(`^(-?${US_AMOUNT})\\s*(${US_AMOUNT})\\s*(${US_AMOUNT})\\s*(\\d{4}/\\d{2}/\\d{2})(.*)$`);
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

const aswaq = {
  name: 'أسواق - كشف حساب العميل',
  detect: text => /ASWAQ/i.test(text) && /T336/.test(text),
  parse(text) {
    const rows = []; let description = [];
    const pattern = /^(.*?)(\d{2}\/\d{2}\/\d{4})([\d,]+\.\d{2})\$\s*([\d,]+\.\d{2})\$\s*([\d,]+\.\d{2})\$\s*(-?)(.*)$/;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); const m = line.match(pattern);
      if (!m) {
        if (line && !/20262026|المدينالمدين|الإجماليالإجمالي|T336|Tripoli|ASWAQ/.test(line)) description.push(line);
        continue;
      }
      const [, prefix, date, debit, credit, balance, negative, reference] = m;
      const label = [...description, prefix].filter(Boolean).join(' ').trim(); description = [];
      // An opening balance is a snapshot, not a new expense to import.
      if (/^FIRST\//.test(reference)) continue;
      const amount = round2(usNumber(credit) - usNumber(debit));
      if (!amount) continue;
      const [day, month, year] = date.split('/');
      rows.push({ day: `${year}-${month}-${day}`, description: label || reference, reference, amount,
        balanceAfter: usNumber(balance) * (negative ? 1 : -1) });
    }
    return rows;
  },
};

// Wasl's amounts are glued in plain text. Read their actual PDF columns instead of guessing.
const wasl = {
  name: 'وصل - كشف الحساب بالدولار',
  detect: text => /وصل للحوالات المالية/.test(text) && /كشف حساب#/.test(text),
  parse(text, pages = []) {
    const rows = [];
    for (const items of pages) {
      const dates = items.filter(i => i.x > 480 && /^\d{2}-\d{2}-\d{4}$/.test(i.text)).sort((a, b) => b.y - a.y);
      for (let index = 0; index < dates.length; index++) {
        const date = dates[index];
        const values = items.filter(i => i.x < 280 && Math.abs(i.y - date.y) < 2 && /^-?[\d,]+(?:\.\d+)?$/.test(i.text));
        const balance = values.find(i => i.x < 120), credit = values.find(i => i.x >= 120 && i.x < 200), debit = values.find(i => i.x >= 200);
        if (!balance || !credit || !debit) continue; // Printed footer date has no movement columns.
        const top = index ? (dates[index - 1].y + date.y) / 2 : date.y + 35;
        const bottom = dates[index + 1] ? (dates[index + 1].y + date.y) / 2 : date.y - 35;
        const label = items.filter(i => i.x >= 280 && i.x < 490 && i.y < top && i.y > bottom && !/التفاص|إجمالي العمليات|الرصي|بواسطة/.test(i.text))
          .sort((a, b) => b.y - a.y || b.x - a.x).map(i => i.text).join(' ').trim();
        const amount = round2(usNumber(credit.text) - usNumber(debit.text));
        const [day, month, year] = date.text.split('-');
        if (amount) {
          const row = { day: `${year}-${month}-${day}`, description: label, reference: '', amount, balanceAfter: -usNumber(balance.text) };
          if (/Alipay/i.test(label)) {
            const sum = label.match(/[\d,]+\s*\+\s*[\d,]+(?:\s*\+\s*[\d,]+)*/);
            const single = label.match(/بقيمة\s*([\d,]+)/);
            const yuan = sum ? sum[0].split('+').reduce((s, n) => s + usNumber(n.trim()), 0) : single ? usNumber(single[1]) : 0;
            if (yuan > 0) Object.assign(row, { originalAmount: yuan, originalCurrency: 'CNY', counterAmount: yuan, counterCurrency: 'CNY' });
            const quote = label.match(/صرف\s+([\d.]+)/);
            if (quote) row.exchangeRate = Number(quote[1]);
          }
          rows.push(row);
        }
      }
    }
    return rows;
  },
};

// Kuveyt Türk card is read by the general reader (its amounts are followed by "TL").
const FORMATS = [kuveytAccount, albarakaCard, albarakaAccount, almutaheda, aswaq, wasl];

function readKnownFormat(text, { pages } = {}) {
  const format = FORMATS.find((item) => item.detect(text));
  if (!format) return null;
  return { format: format.name, creditCard: !!format.creditCard, rows: format.parse(text, pages) };
}

module.exports = { readKnownFormat, FORMATS };
