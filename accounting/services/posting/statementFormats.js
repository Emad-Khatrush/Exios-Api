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
    const starts = /^\d{2}\.\d{2}\.\d{4}[A-Z0-9]{5}/;
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const rows = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!starts.test(lines[i])) continue;
      // A long description wraps: the amount and balance (even the "-" alone) come on the next
      // lines ("23.10.2026AYQ6H" / "Gönderen:...,Ödeme" / "Türü:BireyselÖdeme" / "-5.000,0034.609,76")
      let joined = lines[i];
      let match = joined.match(pattern);
      for (let next = i + 1; !match && next < lines.length && next <= i + 4 && !starts.test(lines[next]); next += 1) {
        joined += lines[next];
        match = joined.match(pattern);
      }
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

// ---- Garanti BBVA Bonus Business credit card (TRY or foreign-currency statement) ----
// Garanti issues separate statements for the same physical card when the payment type differs.
// A TRY statement may show both the original foreign amount and the settled TRY amount, while a
// USD statement shows the USD payable directly. The account currency must follow the statement.
const garantiCard = {
  name: 'Garanti BBVA - Bonus Business credit card',
  creditCard: true,
  detect: (text) => /garanti\s*bankas|garantibbva/i.test(text) && /BONUS\s+BUSINESS/i.test(text)
    && /Ekstre\s+No\s*:/i.test(text) && /Kart\s+Numaras[ıi]/i.test(text),
  parse(text) {
    const normalized = String(text || '').replace(/\u00a0/g, ' ');
    const currencyMatch = normalized.match(/Tutar\s*\(\s*(TL|TRY|USD)\s*\)/i);
    const currency = (currencyMatch?.[1] || (normalized.match(/Toplam\s+Borcunuz\s*[\d.,]+\s*(TL|TRY|USD)/i) || [])[1] || '').toUpperCase();
    if (!['TL', 'TRY', 'USD'].includes(currency)) return [];
    const statementCurrency = currency === 'TL' ? 'TRY' : currency;
    const cardNumber = (normalized.match(/Kart\s+Numaras[ıi]\s*([\d* ]{8,})/i) || [])[1]?.replace(/\s/g, '') || '';
    const transactionSection = normalized.split(/İşlem\s*Tarihi/i).slice(1).join('\n');
    const transactionText = transactionSection.split(/(?:^|\n)\s*Toplam\s+[\d.,]+/i)[0] || '';
    const months = { ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12 };
    const datePattern = /(?:^|\n)\s*(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s*(\d{4})([^\r\n]*)/giu;
    const rows = [];
    for (const match of transactionText.matchAll(datePattern)) {
      const [, dayText, monthText, year, tail] = match;
      const amountMatch = tail.match(/([+-]?)\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2})\s*$/);
      if (!amountMatch) continue;
      const amount = trNumber(amountMatch[2]);
      if (!(amount > 0)) continue;
      let description = tail.slice(0, amountMatch.index).trim();
      let originalAmount; let originalCurrency;
      if (statementCurrency === 'TRY') {
        const foreign = description.match(/([\d.,]+)\s*(USD|EUR|GBP)\s*$/i);
        if (foreign) {
          originalAmount = trNumber(foreign[1]);
          originalCurrency = foreign[2].toUpperCase();
          description = description.slice(0, foreign.index).trim();
        }
      } else {
        originalAmount = amount;
        originalCurrency = statementCurrency;
      }
      const textLower = description.toLocaleLowerCase('tr');
      const isPayment = /ödeme|odeme|payment|teşekkür|tesekkur/.test(textLower);
      const isRefund = !isPayment && /iade|iptal|refund|reversal|returned|chargeback|ters işlem|ters islem/.test(textLower);
      // Card statements show purchases as positive and payments/credits as negative. The UI then
      // flips the statement sign to the normal account movement sign.
      const printedSign = amountMatch[1] === '-' || isPayment || isRefund ? -1 : 1;
      const row = {
        day: `${year}-${String(months[monthText.toLocaleLowerCase('tr')]).padStart(2, '0')}-${dayText.padStart(2, '0')}`,
        description: description || (isPayment ? 'Garanti card payment' : isRefund ? 'Garanti card purchase refund' : 'Garanti card purchase'),
        reference: '', amount: printedSign * amount, balanceAfter: null,
        movementKind: isPayment ? 'card_payment' : isRefund ? 'purchase_refund' : 'purchase',
      };
      if (originalAmount > 0 && originalCurrency) Object.assign(row, { originalAmount, originalCurrency,
        ...(originalCurrency === 'USD' && { settlementUsd: originalAmount }) });
      rows.push(row);
    }
    return rows;
  },
  currency(text) {
    const found = String(text || '').match(/Tutar\s*\(\s*(TL|TRY|USD)\s*\)/i)
      || String(text || '').match(/Toplam\s+Borcunuz\s*[\d.,]+\s*(TL|TRY|USD)/i);
    return found ? (found[1].toUpperCase() === 'TL' ? 'TRY' : found[1].toUpperCase()) : null;
  },
  cardNumber(text) { return (String(text || '').match(/Kart\s+Numaras[ıi]\s*([\d* ]{8,})/i) || [])[1]?.replace(/\s/g, '') || null; },
};

// ---- Garanti BBVA Turkish deposit-account statement (TRY and USD) ----
// The bank prints each date, description/tag, and the amount/balance on separate PDF text lines.
const garantiAccount = {
  name: 'Garanti BBVA - bank account statement',
  detect: text => /garanti\s*bankas|garantibbva/i.test(text) && /Hesap\s*Hareketleri/i.test(text)
    && /Hesap\s*Numaras[ıi]:/i.test(text) && /Kullanılabilir\s+Bakiye/i.test(text),
  parse(text) {
    const normalized = String(text || '').replace(/\u00a0/g, ' ');
    const currency = garantiAccount.currency(normalized);
    if (!['TRY', 'USD'].includes(currency)) return [];
    const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const rows = [];
    // A movement starts on a line beginning with its date. The PDF usually puts the date alone on
    // that line, but can join the date, text and amounts into one line (seen on the newest row).
    const startsMovement = /^(\d{2})\.(\d{2})\.(\d{4})(.*)$/;
    for (let index = 0; index < lines.length; index++) {
      const date = lines[index].match(startsMovement);
      if (!date) continue;
      const block = date[4].trim() ? [date[4].trim()] : [];
      const sameLine = block.length;
      for (let next = index + 1; next < lines.length && !startsMovement.test(lines[next]); next++) block.push(lines[next]);
      const amountPattern = /([+-]?\s*\d+(?:\.\d{3})*,\d{2})\s*(TL|TRY|USD)\s*([+-]?\s*\d+(?:\.\d{3})*,\d{2})\s*(TL|TRY|USD)$/i;
      const amountIndex = block.findIndex(line => amountPattern.test(line));
      if (amountIndex < 0) continue;
      const amountMatch = block[amountIndex].match(amountPattern);
      if (!amountMatch || amountMatch[2].toUpperCase() !== amountMatch[4].toUpperCase()) continue;
      const amount = trNumber(amountMatch[1].replace(/\s/g, ''));
      const balanceAfter = trNumber(amountMatch[3].replace(/\s/g, ''));
      if (!amount) continue;
      const description = [...block.slice(0, amountIndex), block[amountIndex].slice(0, amountMatch.index)].join(' ').replace(/\s+/g, ' ').trim();
      if (!description) continue;
      const row = { day: `${date[3]}-${date[2]}-${date[1]}`, description, reference: '', amount, balanceAfter };
      const textLower = description.toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (textLower.includes('kart odemesi')) row.movementKind = 'card_payment';
      const rateMatch = description.match(/USD\s*:\s*([\d.,]+)/i);
      if ((textLower.includes('doviz alis') || textLower.includes('doviz satis')) && rateMatch) {
        const rate = Number(rateMatch[1].replace(/,/g, ''));
        if (Number.isFinite(rate) && rate > 0) {
          const buying = textLower.includes('doviz alis');
          const validDirection = currency === 'TRY' ? (buying ? amount < 0 : amount > 0) : (buying ? amount > 0 : amount < 0);
          if (validDirection) Object.assign(row, {
            counterAmount: round2(currency === 'TRY' ? Math.abs(amount) / rate : Math.abs(amount) * rate),
            counterCurrency: currency === 'TRY' ? 'USD' : 'TRY', exchangeRate: rate,
          });
        }
      }
      rows.push(row);
      index += amountIndex + 1 - sameLine;
    }
    return rows;
  },
  currency(text) {
    const balance = String(text || '').match(/Bakiye\s*:\s*[\d.,]+\s*(TL|TRY|USD)/i)
      || String(text || '').match(/Kullanılabilir\s+Bakiye\s*:\s*[\d.,]+\s*(TL|TRY|USD)/i);
    return balance ? (balance[1].toUpperCase() === 'TL' ? 'TRY' : balance[1].toUpperCase()) : null;
  },
  accountNumber(text) { return (String(text || '').match(/Hesap\s*Numaras[ıi]:\s*\d+\s*-\s*(\d+)/i) || [])[1] || null; },
  iban(text) { return (String(text || '').match(/IBAN:\s*([A-Z]{2}(?:\s*\d){24})/i) || [])[1]?.replace(/\s/g, '') || null; },
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
  // Both of Wasl's letterheads: «وصل للحوالات المالية» and the older «وصل المتحدة للشحن والخدمات اللوجستية»
  detect: text => /وصل (?:للحوالات المالية|المتحدة للشحن)/.test(text) && /كشف حساب#/.test(text),
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
          // A yuan transfer, by Alipay or by bank («حواله بنك بقيمة 100,000¥ … صرف $6.78»)
          if (/Alipay/i.test(label) || /حوال.*بقيمة.*¥/.test(label)) {
            // «32,723.88+40,909=73,632.88¥»: the total printed after «=» first, else the parts with their decimals
            const parsed = require('./partnerTransfers').partsOf(label);
            const single = label.match(/بقيمة\s*([\d,]+(?:\.\d+)?)/);
            const yuan = parsed ? Math.round(parsed.total * 100) / 100 : single ? usNumber(single[1]) : 0;
            if (yuan > 0) Object.assign(row, { originalAmount: yuan, originalCurrency: 'CNY', counterAmount: yuan, counterCurrency: 'CNY' });
            const quote = label.match(/صرف\s+\$?([\d.]+)/);
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
const FORMATS = [garantiCard, garantiAccount, kuveytAccount, albarakaCard, albarakaAccount, almutaheda, aswaq, wasl];

function readKnownFormat(text, { pages } = {}) {
  const format = FORMATS.find((item) => item.detect(text));
  if (!format) return null;
  return { format: format.name, creditCard: !!format.creditCard, rows: format.parse(text, pages),
    ...(format.currency && { currency: format.currency(text) }), ...(format.cardNumber && { cardNumber: format.cardNumber(text) }),
    ...(format.accountNumber && { accountNumber: format.accountNumber(text) }), ...(format.iban && { iban: format.iban(text) }) };
}

module.exports = { readKnownFormat, FORMATS };
