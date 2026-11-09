// Company-specific bank descriptors confirmed by the operator. No amount or balance is inferred.
const normalize = value => String(value || '').toLocaleLowerCase('tr').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9*]+/g, ' ').trim();
const number = value => {
  const text = String(value);
  return Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
};
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
// The company's own name on a line ("EXİOS İÇ VE DIŞ TİCARET LİMİTED ŞİRKETİ", also written without
// spaces): money moving between the company's accounts, never a purchase or a supplier refund.
// Banks print it with or without spaces, so it is read with the spaces taken out.
function isOwnCompany(description) {
  const text = normalize(description).replace(/ /g, '');
  return text.includes('exios') && (text.includes('sirket') || text.includes('ticaret'));
}
// Turkish interbank (EFT/FAST) codes of the banks holding the company's lira accounts
const OWN_BANK_CODES = { 203: '110203', 205: '110204', 62: '110208' };
function exchangeOf(description, currency, amount) {
  const text = normalize(description);
  if (text.includes('doviz alis') || text.includes('doviz satis')) {
    const rateText = String(description).match(/USD\s*:\s*([\d.,]+)/i)?.[1];
    const rate = rateText ? number(rateText) : 0;
    if (!(rate > 0) || !Number.isFinite(rate)) return { error: 'سعر صرف Garanti غير ظاهر بوضوح؛ راجع البيان قبل الاعتماد' };
    const buying = text.includes('doviz alis');
    const validDirection = currency === 'TRY' ? (buying ? amount < 0 : amount > 0) : currency === 'USD' ? (buying ? amount > 0 : amount < 0) : false;
    if (!validDirection) return { error: 'عملة الحساب أو اتجاه حركة الصرف لا يطابق وصف Döviz Alış / Satış' };
    return { counterAmount: round2(currency === 'TRY' ? Math.abs(amount) / rate : Math.abs(amount) * rate),
      counterCurrency: currency === 'TRY' ? 'USD' : 'TRY', exchangeRate: rate };
  }
  if (!text.includes('karsiligi') || !text.includes('satis')) return null;
  const match = String(description).match(/([\d.,]+)\s*TRY\s*Kar[sş]ılığı\s*([\d.,]+)\s*(USD|EUR)\s*Sat[iı][sş],?\s*Kur:\s*([\d.,]+)/i);
  if (!match) return { error: 'وصف صرف غير مكتمل؛ راجع المبلغين وسعر البنك قبل الترحيل' };
  const lira = number(match[1]), foreign = number(match[2]), rate = number(match[4]), foreignCurrency = match[3].toUpperCase();
  if (![lira, foreign, rate].every(n => Number.isFinite(n) && n > 0) || Math.abs(lira - foreign * rate) > 1)
    return { error: 'مبالغ الصرف لا تتفق مع سعر البنك المكتوب؛ راجع الكشف' };
  const incoming = currency === 'TRY' && amount > 0, outgoing = currency === foreignCurrency && amount < 0;
  if ((!incoming && !outgoing) || Math.abs(Math.abs(amount) - (incoming ? lira : foreign)) > 0.005)
    return { error: 'عملة حساب الكشف أو إشارة مبلغ الصرف لا تتفق مع الوصف؛ اختر الحساب الصحيح' };
  return { counterAmount: incoming ? foreign : lira, counterCurrency: incoming ? foreignCurrency : 'TRY', exchangeRate: rate };
}
function describe(line, bank, accounts) {
  const code = bank.seedKey || bank.code, text = normalize(line.description), outgoing = line.amount < 0;
  const find = wanted => accounts.find(a => a.isActive !== false && !a.isGroup && (a.seedKey === wanted || a.code === wanted));
  const result = (kind, counter, reason) => ({ source: kind, account: counter || null, reason,
    requiresConfirmation: !counter || kind === 'funder_settlement', semanticTransfer: true });
  if (['110207', '110208'].includes(code) && ['TRY', 'USD'].includes(bank.currency)) {
    if (outgoing && text.includes('kart odemesi')) {
      const cardCode = bank.currency === 'USD' ? '250400' : '250300';
      return result('card_transfer', find(cardCode), 'سداد رصيد بطاقة Garanti؛ اربط الحركة بحساب البطاقة بنفس العملة ولا تسجلها كمصروف شراء جديد.');
    }
    if (outgoing && text.includes('faiz komisyon')) return { source: 'bank_fee', account: find('530400') || null,
      office: 'turkey', vendorName: 'Garanti BBVA', vendorType: 'service', requiresConfirmation: true,
      reason: 'عمولة أو رسم مصرفي من Garanti؛ يصنف على الرسوم المصرفية بعد مراجعة المبلغ.' };
    if (text.includes('doviz alis') || text.includes('doviz satis')) {
      const exchange = exchangeOf(line.description, bank.currency, Math.abs(line.amount) / 100 * (outgoing ? -1 : 1));
      if (exchange?.error) return { source: 'exchange', account: null, requiresConfirmation: true, reason: exchange.error };
      const counter = find(exchange.counterCurrency === 'USD' ? '110207' : '110208');
      return { ...result('exchange', counter?.currency === exchange.counterCurrency ? counter : null,
        'شراء أو بيع عملة بين حسابَي Garanti؛ يستخدم مبلغَي الكشف وسعر البنك، ولا يُسجل كإيراد أو مصروف.'), ...exchange };
    }
    if (!outgoing && text.includes('para transferi')) return { source: 'bank_transfer_in', account: null, office: 'turkey', requiresConfirmation: true,
      reason: 'حوالة واردة إلى حساب Garanti؛ طابقها مع قيد التحويل أو حدد الطرف المقابل قبل اعتمادها، ولا تعتبرها إيرادًا تلقائيًا.' };
  }
  if (code === '110201' && bank.currency === 'USD' && outgoing) {
    // Arabic RTL extraction may print "1414" as "4 ... Com 141" and glue Com
    // to the preceding Arabic word. Commission recognition must come before cash.
    if (/\bcom\b/i.test(String(line.description || ''))) {
      return { source: 'bank_fee', account: find('530400') || null, office: 'turkey',
        vendorName: bank.name, vendorType: 'service', requiresConfirmation: true,
        reason: 'عمولة المتحدة للسحب أو التحويل، وليست مبلغ الكاش المستلم ولا تكلفة مشتريات جديدة.' };
    }
    const arabic = String(line.description || '').normalize('NFKC')
      .replace(/[\u064b-\u065f\u0670\u0640\u200e\u200f]/g, '')
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (/(?:^| )1414(?: |$)/.test(arabic) && /(?:^| )بيده(?: |$)/.test(arabic)
      && /(?:^| )(?:كا+ش|ك)(?: |$)/.test(arabic)) {
      return result('cash_withdrawal', find('110107'),
        'استلام دولار كاش من المتحدة بيد عماد؛ تحويل إلى خزينة مكتب تركيا بالدولار، وليس مصروف خدمات أو مشتريات. عمولة السحب تُسجل منفصلة.');
    }
  }
  if (!['110202', '110203', '110204', '110205', '250100', '250200'].includes(code)) return null;
  if (code === '110203' && outgoing && text.startsWith('fon alis')) {
    // RBV identifies this fund; another fund must not be mixed into its balance.
    const counter = /\brbv\b/.test(text) ? find('investment:albaraka:RBV:TRY') : null;
    return { ...result('investment_transfer', counter, 'اشتراك في صندوق استثماري؛ يُنقل أصل المبلغ من البنك إلى استثمار RBV، دون مصروف شراء أو ربح استثمار مفترض.'), requiresConfirmation: true };
  }
  if (code === '110203' && outgoing && text.startsWith('katilma hesabi acilisi'))
    return { ...result('investment_transfer', find('investment:albaraka:katilim:TRY'), 'تمويل حساب مشاركة البركة؛ أصل استثماري مستقل، وليس مصروفًا أو إيرادًا.'), requiresConfirmation: true };
  if (['110203', '110204'].includes(code) && text.includes('emad kaya'))
    return { ...result('owner_loan', find('loan:emad-kaya:TRY'), outgoing
      ? 'رد قرض عماد إلى حساب EMAD KAYA؛ يخفض الدين بنفس مبلغ الليرة، دون تكلفة شراء. لا يُسمح بسداد أكبر من الدين المسجل.'
      : 'قرض من حساب عماد الشخصي EMAD KAYA للشركة؛ يزيد البنك والدين المستحق له، وليس إيرادًا أو رأس مال.'), requiresConfirmation: true };
  if (code === '110203' && outgoing && text.includes('esra bahcali') && (text.includes('muhasebe ucreti') || text.includes('ticaret odasi masraf'))) {
    const government = text.includes('ticaret odasi masraf');
    return { account: find(government ? '531200' : '531700') || null, source: 'professional_fee', requiresConfirmation: true,
      vendorName: 'Esra Bahcali', vendorType: 'service', office: 'turkey', reason: government ? 'رسوم غرفة التجارة؛ راجع فاتورة الرسوم قبل اعتمادها كمصروف حكومي' : 'خدمات محاسبة؛ راجع الفاتورة السابقة قبل تسجيل مصروف خدمات جديد' };
  }
  if (text.includes('karsiligi') && text.includes('satis')) {
    const exchange = exchangeOf(line.description, bank.currency || 'USD', Math.abs(line.amount) / 100 * (outgoing ? -1 : 1));
    if (!exchange || exchange.error) return result('exchange', null, exchange?.error || 'راجع وصف الصرف');
    const wanted = { '110203': '110202', '110202': '110203', '110204': '110205', '110205': '110204' }[code];
    const counter = wanted && find(wanted);
    return { ...result('exchange', counter?.currency === exchange.counterCurrency ? counter : null, 'صرف بين حسابي البنك: المبلغان وسعر العملية من وصف الكشف، وليس إيرادًا أو مصروف شراء'), ...exchange };
  }
  if (code === '110203' && outgoing && text.includes('yusuf alahmar'))
    return result('funder_settlement', accounts.find(a => a.isActive !== false && a.seedKey === 'funding:yusuf:TRY'), 'سداد مشتريات دفعها يوسف عن الشركة: يُخفض حسابه الجاري، ولا ينشئ تكلفة شراء جديدة. راجع تسجيل المشتريات أو الدين الافتتاحي عليه.');
  if (code === '110203' && outgoing && /5472\*+(1890|9480)/.test(text) && text.includes('kredi kartina') && text.includes('hesaptan odeme'))
    return result('card_transfer', find('250200'), 'سداد بطاقة البركة من حساب البنك بالليرة؛ تحويل بين الحسابين وليس مصروف مشتريات');
  if (code === '110204' && outgoing && text.includes('kredi kart') && text.includes('borc odeme'))
    return result('card_transfer', find('250100'), 'سداد بطاقة كويت ترك من حساب البنك؛ لا تُسجّل تكلفة الشراء مرة ثانية');
  if (isOwnCompany(line.description)) {
    // The other bank's code: the sender on money in, the receiver on money out
    const bankCode = (outgoing ? text.match(/alici banka\s*(\d+)\b/) : text.match(/gonbanka\s*(\d+)\b/))?.[1];
    const counter = bankCode && OWN_BANK_CODES[bankCode] && find(OWN_BANK_CODES[bankCode]);
    if (counter && counter.code !== bank.code && (counter.currency || 'USD') === (bank.currency || 'USD'))
      return result('own_transfer', counter, `تحويل بين حسابي الشركة (${bank.name} و${counter.name})؛ قيد واحد يُطابق مع كشفي الحسابين، لا إيراد ولا تكلفة شراء جديدة`);
  }
  if (!outgoing && text.includes('emad suleiman') && text.includes('para yatirma')) {
    const cash = bank.currency === 'TRY' ? find('cash:turkey:TRY') : bank.currency === 'USD' ? find('110107') : null;
    return { ...result('cash_deposit', cash, 'إيداع من خزينة الشركة بنفس العملة. سجّل سحب دولار المتحدة إلى خزينة تركيا، ثم الصرف بالمبلغين الفعليين إلى خزينة الليرة، ثم هذا الإيداع. الدولار المتبقي يُودع بعملية دولار منفصلة؛ لا نستنتج سعر الصرف من الإيداع.'), requiresConfirmation: true };
  }
  return null;
}
function matchesMovement(line, hint, movement) {
  if (!hint?.semanticTransfer) return true;
  if (!hint.account) return false;
  const lines = (movement.ledgerLines || []).filter(l => String(l.accountId) === String(hint.account._id));
  if (!lines.length) return false;
  const actual = lines.reduce((sum, l) => sum + (hint.account.currency && hint.account.currency !== 'USD' ? Number(l.amountCurrency || 0) : Number(l.debit || 0) - Number(l.credit || 0)), 0);
  const expected = hint.source === 'exchange' ? -Math.sign(line.amount) * Math.round(hint.counterAmount * 100) : -line.amount;
  return actual === expected;
}
module.exports = { describe, exchangeOf, matchesMovement, isOwnCompany };
