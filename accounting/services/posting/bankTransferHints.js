// Company-specific bank descriptors confirmed by the operator. No amount or balance is inferred.
const normalize = value => String(value || '').toLocaleLowerCase('tr').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9*]+/g, ' ').trim();
const number = value => {
  const text = String(value);
  return Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
};
function exchangeOf(description, currency, amount) {
  const text = normalize(description);
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
  if (text.includes('exios') && (text.includes('sirket') || text.includes('ticaret'))) {
    const receiver205 = /alici banka\s*205\b/.test(text), sender205 = /gonbanka\s*205\b/.test(text);
    const receiver203 = /alici banka\s*203\b/.test(text), sender203 = /gonbanka\s*203\b/.test(text);
    if (code === '110203' && ((outgoing && receiver205) || (!outgoing && sender205)))
      return result('own_transfer', find('110204'), 'تحويل بين حساب البركة وحساب كويت ترك التابعين للشركة بالليرة؛ قيد واحد يُطابق مع كشفي الحسابين');
    if (code === '110204' && ((outgoing && receiver203) || (!outgoing && sender203)))
      return result('own_transfer', find('110203'), 'تحويل بين حسابي الشركة بالليرة؛ لا إيراد ولا تكلفة شراء جديدة');
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
module.exports = { describe, exchangeOf, matchesMovement };
