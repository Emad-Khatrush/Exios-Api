const { JournalEntry } = require('../../models');
const { Settings, Period } = require('../../models/FinancialAnalysis');
const { getConfig } = require('../config');
const { sectionResolver, cashFlow } = require('./statements');
const { isDay, today, addDays } = require('../dates');
const { fail } = require('../posting/common');
const { logAudit } = require('../audit');
const CATEGORIES = {
  cash: 'نقد وما يعادله', receivables: 'ذمم عملاء تجارية متداولة', inventory: 'مخزون تملكه الشركة',
  receivables_allowance: 'مخصص مقابل ذمم العملاء (حساب مقابل)', inventory_allowance: 'مخصص مقابل المخزون (حساب مقابل)', noncurrent_contra: 'إهلاك متراكم / مقابل أصل غير متداول',
  prepaid: 'مقدمات متداولة', other_current_asset: 'أصول متداولة أخرى', noncurrent_asset: 'أصول غير متداولة',
  liquid_current_asset: 'استثمارات متداولة قابلة للتحويل سريعًا لنقد',
  current_liability: 'التزامات متداولة أخرى', trade_payables: 'ذمم موردين تجارية متداولة', noncurrent_liability: 'التزامات غير متداولة',
};
const BEHAVIORS = { fixed: 'ثابت', variable: 'متغير' };
const round = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
const pct = (x, y) => y > 0 ? round(x / y * 100) : null;
const growth = (a, b) => b > 0 ? round((a - b) / b * 100) : null;
function period(input, allowFuture = false) {
  const from = input.from || `${today().slice(0, 7)}-01`, to = input.to || today();
  if (!isDay(from) || !isDay(to) || from > to || (!allowFuture && to > today())) throw fail('اختر فترة صحيحة تنتهي اليوم أو قبله للتحليل الفعلي');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 1830) throw fail('اختر فترة لا تتجاوز خمس سنوات');
  const previousTo = input.previousTo || addDays(from, -1), previousFrom = input.previousFrom || addDays(previousTo, 1 - days);
  if (!isDay(previousFrom) || !isDay(previousTo) || previousFrom > previousTo || previousTo >= from) throw fail('فترة المقارنة يجب أن تنتهي قبل الفترة الحالية');
  const previousDays = Math.round((Date.parse(`${previousTo}T00:00:00Z`) - Date.parse(`${previousFrom}T00:00:00Z`)) / 86400000) + 1;
  if (previousDays > 1830) throw fail('فترة المقارنة طويلة جدًا');
  return { from, to, days, previousFrom, previousTo, previousDays };
}
async function configuration() {
  const [saved, config] = await Promise.all([Settings.findOne({ key: 'main' }).lean(), getConfig()]);
  return { settings: saved || { classifications: [], costBehavior: [], version: 0 },
    accounts: [...config.accountsById.values()].filter(a => !a.isGroup).map(a => ({ _id: a._id, code: a.code, name: a.name, type: a.type, isCash: a.isCash, cashKind: a.cashKind, isActive: a.isActive, analysisCategory: a.analysisCategory })),
    categories: CATEGORIES, behaviors: BEHAVIORS,
    suggestedReliableFrom: config.count ? addDays(config.count.day, config.count.endOfDay ? 1 : 0) : null };
}
async function saveSettings(body, { session, req }) {
  const config = await getConfig();
  if (body.reliableFrom && (!isDay(body.reliableFrom) || body.reliableFrom > today())) throw fail('تاريخ بداية البيانات الموثوقة غير صالح');
  const classifications = Array.isArray(body.classifications) ? body.classifications : [];
  const costBehavior = Array.isArray(body.costBehavior) ? body.costBehavior : [];
  for (const [rows, type] of [[classifications, 'classification'], [costBehavior, 'behavior']]) {
    const seen = new Set();
    for (const row of rows) {
      const account = config.accountsById.get(String(row.accountId));
      if (!account || account.isGroup || seen.has(String(row.accountId))) throw fail('حساب غير صالح أو مكرر في الإعدادات');
      seen.add(String(row.accountId));
      if (type === 'classification') {
        const liabilityCategory = row.category?.endsWith('liability') || row.category === 'trade_payables';
        if (!CATEGORIES[row.category] || (account.type === 'asset' ? liabilityCategory : account.type === 'liability' ? !liabilityCategory : true)) throw fail('تصنيف الحساب لا يوافق نوعه');
      } else if (account.type !== 'expense' || !BEHAVIORS[row.behavior]) throw fail('اختر سلوكًا صحيحًا لحساب مصروف');
    }
  }
  const old = await Settings.findOne({ key: 'main' }).session(session).lean();
  if (Number(body.version) !== (old?.version || 0)) throw fail('تغيرت الإعدادات؛ أعد تحميلها قبل الحفظ');
  const fields = { classifications, costBehavior, reliableFrom: body.reliableFrom || null, updatedBy: req.user._id };
  const saved = await Settings.findOneAndUpdate({ key: 'main', version: old?.version || 0 }, { $set: fields, $inc: { version: 1 } }, { upsert: !old, new: true, session, runValidators: true });
  if (!saved) throw fail('تغيرت الإعدادات؛ أعد تحميلها');
  await logAudit({ req, action: 'analysis.settings.update', model: 'AccountingAnalysisSettings', docId: saved._id, before: old, after: saved }, session);
  return saved;
}
async function savePeriod(body, { session, req }) {
  const p = period(body, true), config = await getConfig();
  const rows = Array.isArray(body.budget) ? body.budget : [], seen = new Set();
  for (const row of rows) {
    const account = config.accountsById.get(String(row.accountId));
    if (!account || account.isGroup || !['income', 'expense'].includes(account.type) || !Number.isSafeInteger(row.amount) || seen.has(String(row.accountId))) throw fail('بنود الموازنة غير صالحة؛ المبالغ بالدولار بالسنت');
    seen.add(String(row.accountId));
  }
  const fields = { budget: rows, notes: String(body.notes || '').slice(0, 5000), updatedBy: req.user._id };
  for (const key of ['creditSales', 'creditPurchases', 'inventoryCost', 'interestExpense']) {
    const value = body[key];
    if (p.to > today() && value != null) throw fail('احفظ موازنة الفترة المستقبلية دون معلومات نشاط فعلي؛ تُدخل معلومات النشاط بعد انتهاء الفترة');
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw fail('قيم النشاط الإضافية يجب أن تكون مبالغ موجبة بالدولار بالسنت');
    fields[key] = value == null ? null : value;
  }
  const old = await Period.findOne({ from: p.from, to: p.to }).session(session).lean();
  if (Number(body.version) !== (old?.version || 0)) throw fail('تغيرت الموازنة؛ حدّث الفترة قبل الحفظ');
  const saved = await Period.findOneAndUpdate({ from: p.from, to: p.to, version: old?.version || 0 }, { $set: fields, $inc: { version: 1 } }, { upsert: !old, new: true, session, runValidators: true });
  if (!saved) throw fail('تغيرت الموازنة؛ أعد تحميل الفترة');
  await logAudit({ req, action: 'analysis.period.update', model: 'AccountingAnalysisPeriod', docId: saved._id, before: old, after: saved }, session);
  return saved;
}
async function readPlan(input) {
  const p = period(input, true);
  return await Period.findOne({ from: p.from, to: p.to }).lean() || { from: p.from, to: p.to, budget: [], version: 0 };
}
const zero = () => ({ revenue: 0, cost: 0, expenses: 0, depreciation: 0, fx: 0 });
const summarize = s => ({ ...s, grossProfit: s.revenue - s.cost, operatingProfit: s.revenue - s.cost - s.expenses - s.depreciation, netProfit: s.revenue - s.cost - s.expenses - s.depreciation - s.fx });
function metric(key, title, value, unit, formula, reason, scope = 'period') {
  return { key, title, value: value == null ? null : round(value), unit, formula, reason: value == null ? reason || 'البيانات غير كافية أو المقام غير موجب' : null, scope };
}
async function overview(input) {
  const p = period(input);
  const [config, saved, planning] = await Promise.all([getConfig(), Settings.findOne({ key: 'main' }).lean(), Period.findOne({ from: p.from, to: p.to }).lean()]);
  const sectionOf = await sectionResolver();
  const net = { $subtract: ['$lines.debit', '$lines.credit'] };
  const within = (from, to) => ({ $and: [{ $gte: ['$day', from] }, { $lte: ['$day', to] }] });
  const economic = range => ({ $and: [range, { $ne: ['$eventType', 'YEAR_CLOSE'] }] });
  const [aggregate, flow] = await Promise.all([
    JournalEntry.aggregate([
      { $match: { day: { $lte: p.to } } },
      { $facet: {
        coverage: [{ $group: { _id: null, firstDay: { $min: '$day' }, currentCount: { $sum: { $cond: [economic(within(p.from, p.to)), 1, 0] } }, previousCount: { $sum: { $cond: [economic(within(p.previousFrom, p.previousTo)), 1, 0] } } } }],
        balances: [{ $unwind: '$lines' }, { $group: { _id: '$lines.accountId', closing: { $sum: net }, opening: { $sum: { $cond: [{ $lt: ['$day', p.from] }, net, 0] } }, previousClosing: { $sum: { $cond: [{ $lte: ['$day', p.previousTo] }, net, 0] } }, current: { $sum: { $cond: [economic(within(p.from, p.to)), net, 0] } }, previous: { $sum: { $cond: [economic(within(p.previousFrom, p.previousTo)), net, 0] } } } }],
        monthly: [{ $match: { day: { $gte: p.from }, eventType: { $ne: 'YEAR_CLOSE' } } }, { $unwind: '$lines' }, { $group: { _id: { key: { $substr: ['$day', 0, 7] }, accountId: '$lines.accountId' }, net: { $sum: net } } }],
        offices: [{ $match: { day: { $gte: p.from }, eventType: { $ne: 'YEAR_CLOSE' } } }, { $unwind: '$lines' }, { $group: { _id: { key: { $ifNull: ['$lines.office', '-'] }, accountId: '$lines.accountId' }, net: { $sum: net } } }],
      } },
    ]).allowDiskUse(true),
    cashFlow({ from: p.from, to: p.to }),
  ]);
  const raw = aggregate[0] || { coverage: [], balances: [], monthly: [], offices: [] };
  const coverage = raw.coverage[0] || {};
  const reliableFrom = saved?.reliableFrom || (config.count ? addDays(config.count.day, config.count.endOfDay ? 1 : 0) : coverage.firstDay);
  let currentReliable = !!coverage.currentCount && !!reliableFrom && p.from >= reliableFrom;
  let previousReliable = !!coverage.previousCount && !!reliableFrom && p.previousFrom >= reliableFrom;
  const classification = new Map((saved?.classifications || []).map(r => [String(r.accountId), r.category]));
  const behaviors = new Map((saved?.costBehavior || []).map(r => [String(r.accountId), r.behavior]));
  const current = zero(), previous = zero(), accounts = [], unclassified = [], costUnclassified = [];
  const groups = Object.fromEntries(Object.keys(CATEGORIES).map(key => [key, { closing: 0, opening: 0, previousClosing: 0 }]));
  const balance = { assets: 0, liabilities: 0, equity: 0, openingAssets: 0, openingLiabilities: 0, openingEquity: 0, previousAssets: 0, previousLiabilities: 0 };
  let unclosed = 0, openingUnclosed = 0, unknown = 0, fixed = 0, variable = 0, capital = [];
  for (const row of raw.balances) {
    const account = config.accountsById.get(String(row._id));
    if (!account || account.isGroup) { unknown += Math.abs(row.closing) + Math.abs(row.current) + Math.abs(row.previous) + Math.abs(row.opening); continue; }
    const section = sectionOf(account), sign = section === 'revenue' ? -1 : 1;
    if (section) {
      current[section] += sign * row.current; previous[section] += sign * row.previous;
      const item = { accountId: account._id, code: account.code, name: account.name, section, current: sign * row.current, previous: sign * row.previous, change: sign * (row.current - row.previous), growth: currentReliable && previousReliable ? growth(sign * row.current, sign * row.previous) : null };
      if (item.current || item.previous) accounts.push(item);
      if (['cost', 'expenses', 'depreciation'].includes(section) && row.current) {
        const behavior = behaviors.get(String(account._id));
        if (behavior === 'fixed') fixed += row.current;
        else if (behavior === 'variable') variable += row.current;
        else costUnclassified.push({ accountId: account._id, code: account.code, name: account.name, amount: row.current });
      }
      unclosed -= row.closing; openingUnclosed -= row.opening;
    }
    if (account.type === 'asset') {
      balance.assets += row.closing; balance.openingAssets += row.opening; balance.previousAssets += row.previousClosing;
    } else if (account.type === 'liability') {
      balance.liabilities -= row.closing; balance.openingLiabilities -= row.opening; balance.previousLiabilities -= row.previousClosing;
    } else if (account.type === 'equity') {
      balance.equity -= row.closing; balance.openingEquity -= row.opening;
      if (row.closing || row.opening) capital.push({ accountId: account._id, code: account.code, name: account.name, opening: -row.opening, closing: -row.closing, change: row.opening - row.closing });
    }
    if (['asset', 'liability'].includes(account.type)) {
      const category = classification.get(String(account._id)) || account.analysisCategory;
      if (category && groups[category]) {
        const s = account.type === 'asset' ? 1 : -1;
        for (const key of ['closing', 'opening', 'previousClosing']) groups[category][key] += s * row[key];
      } else if (row.closing || row.opening || row.previousClosing) unclassified.push({ accountId: account._id, code: account.code, name: account.name, type: account.type, amount: account.type === 'asset' ? row.closing : -row.closing });
    }
  }
  if (unknown) { currentReliable = false; previousReliable = false; }
  const summary = summarize(current), comparison = summarize(previous);
  const totalEquity = balance.equity + unclosed, openingEquity = balance.openingEquity + openingUnclosed;
  const difference = balance.assets - balance.liabilities - totalEquity;
  const openingDifference = balance.openingAssets - balance.openingLiabilities - openingEquity;
  const negativeBalances = raw.balances.some(r => {
    const a = config.accountsById.get(String(r._id));
    const contra = ['receivables_allowance', 'inventory_allowance', 'noncurrent_contra'].includes(classification.get(String(r._id)) || a?.analysisCategory);
    return a && ((a.type === 'asset' && (contra ? r.closing > 0 || r.opening > 0 : r.closing < 0 || r.opening < 0)) || (a.type === 'liability' && (r.closing > 0 || r.opening > 0)));
  });
  const balanceValid = !unknown && difference === 0;
  const classified = !unclassified.length && balanceValid && !negativeBalances;
  const sumGroups = (keys, key = 'closing') => keys.reduce((sum, k) => sum + groups[k][key], 0);
  const currentAssets = sumGroups(['cash', 'receivables', 'receivables_allowance', 'inventory', 'inventory_allowance', 'prepaid', 'other_current_asset', 'liquid_current_asset']);
  const currentLiabilities = groups.current_liability.closing + groups.trade_payables.closing;
  const averageAssets = (balance.assets + balance.openingAssets) / 2;
  const averageEquity = (totalEquity + openingEquity) / 2;
  const insuff = 'الفترة تسبق بداية البيانات الموثوقة أو لا تحتوي قيودًا';
  const classificationReason = !balanceValid ? 'الميزانية غير متوازنة أو يوجد حساب مفقود' : negativeBalances ? 'توجد أرصدة أصول أو التزامات بعكس طبيعتها؛ راجعها أولًا' : 'أكمل تصنيف حسابات الأصول والالتزامات في إعدادات التحليل';
  const ratios = [
    metric('grossMargin', 'هامش مجمل الربح', currentReliable ? pct(summary.grossProfit, summary.revenue) : null, '%', 'مجمل الربح ÷ الإيرادات × 100', !currentReliable ? insuff : null),
    metric('operatingMargin', 'هامش الربح التشغيلي', currentReliable ? pct(summary.operatingProfit, summary.revenue) : null, '%', 'الربح التشغيلي ÷ الإيرادات × 100', !currentReliable ? insuff : null),
    metric('netMargin', 'هامش صافي الربح', currentReliable ? pct(summary.netProfit, summary.revenue) : null, '%', 'صافي الربح ÷ الإيرادات × 100', !currentReliable ? insuff : null),
    metric('expenseShare', 'المصروفات التشغيلية من الإيراد', currentReliable ? pct(summary.expenses + summary.depreciation, summary.revenue) : null, '%', '(المصروفات التشغيلية + الإهلاك) ÷ الإيرادات × 100', !currentReliable ? insuff : null),
    metric('currentRatio', 'نسبة التداول', classified && currentLiabilities > 0 ? currentAssets / currentLiabilities : null, 'مرة', 'الأصول المتداولة ÷ الالتزامات المتداولة', !classified ? classificationReason : 'لا توجد التزامات متداولة موجبة', 'balance'),
    metric('quickRatio', 'السيولة السريعة', classified && currentLiabilities > 0 ? sumGroups(['cash', 'receivables', 'receivables_allowance', 'liquid_current_asset']) / currentLiabilities : null, 'مرة', '(النقد + صافي ذمم العملاء التجارية + الاستثمارات السائلة المتداولة) ÷ الالتزامات المتداولة؛ لا تشمل المقدمات والأصول غير السائلة', !classified ? classificationReason : null, 'balance'),
    metric('cashRatio', 'نسبة النقدية', classified && currentLiabilities > 0 ? groups.cash.closing / currentLiabilities : null, 'مرة', 'النقد وما يعادله ÷ الالتزامات المتداولة', !classified ? classificationReason : null, 'balance'),
    metric('workingCapital', 'رأس المال العامل', classified ? currentAssets - currentLiabilities : null, 'USD', 'الأصول المتداولة − الالتزامات المتداولة', classificationReason, 'balance'),
    metric('debtRatio', 'الالتزامات إلى الأصول', balanceValid && !negativeBalances ? pct(balance.liabilities, balance.assets) : null, '%', 'إجمالي الالتزامات ÷ إجمالي الأصول × 100', !balanceValid || negativeBalances ? classificationReason : 'لا توجد أصول موجبة لحساب النسبة', 'balance'),
    metric('debtEquity', 'الالتزامات إلى حقوق الملكية', balanceValid && !negativeBalances && totalEquity > 0 ? balance.liabilities / totalEquity : null, 'مرة', 'الالتزامات ÷ حقوق الملكية', 'حقوق الملكية غير موجبة أو الميزانية تحتاج مراجعة', 'balance'),
    metric('roa', 'العائد على الأصول للفترة', currentReliable && balanceValid && !openingDifference && !negativeBalances && averageAssets > 0 && balance.openingAssets > 0 ? pct(summary.netProfit, averageAssets) : null, '%', 'صافي ربح الفترة ÷ متوسط أصول أول وآخر الفترة × 100؛ غير محسوب سنويًا', 'تحتاج فترة موثوقة وأرصدة افتتاحية موجبة ومتوازنة'),
    metric('roe', 'العائد على حقوق الملكية للفترة', currentReliable && balanceValid && !openingDifference && totalEquity > 0 && openingEquity > 0 ? pct(summary.netProfit, averageEquity) : null, '%', 'صافي ربح الفترة ÷ متوسط حقوق الملكية × 100؛ غير محسوب سنويًا', 'تحتاج حقوق ملكية موجبة في بداية ونهاية فترة موثوقة'),
  ];
  const operational = flow.categories.find(c => c.key === 'operating')?.total || 0;
  ratios.push(metric('cashConversion', 'التدفق التشغيلي إلى صافي الربح', currentReliable && !flow.unexplained && summary.netProfit > 0 ? operational / summary.netProfit : null, 'مرة', 'التدفق النقدي التشغيلي ÷ صافي الربح', 'تحتاج ربحًا موجبًا وتدفقات متصالحة وفترة موثوقة'));
  const average = key => (groups[key].closing + groups[key].opening + (groups[`${key}_allowance`]?.closing || 0) + (groups[`${key}_allowance`]?.opening || 0)) / 2;
  const manual = key => planning?.[key] == null ? null : planning[key];
  ratios.push(
    metric('collectionDays', 'متوسط أيام التحصيل', currentReliable && classified && average('receivables') >= 0 && manual('creditSales') > 0 && manual('creditSales') <= summary.revenue ? average('receivables') / manual('creditSales') * p.days : null, 'يوم', 'متوسط صافي الذمم التجارية ÷ المبيعات الآجلة المعترف بها × أيام الفترة', 'أدخل المبيعات الآجلة المعترف بها للفترة وأكمل التصنيفات؛ لا تُستخدم كل الإيرادات بدلها'),
    metric('paymentDays', 'متوسط أيام سداد الموردين', currentReliable && classified && manual('creditPurchases') > 0 && average('trade_payables') >= 0 ? average('trade_payables') / manual('creditPurchases') * p.days : null, 'يوم', 'متوسط الذمم التجارية للموردين ÷ المشتريات الآجلة × أيام الفترة', 'أدخل المشتريات الآجلة للفترة وصنّف ذمم الموردين التجارية منفصلة عن بقية الالتزامات'),
    metric('inventoryTurnover', 'دوران المخزون المملوك', currentReliable && classified && manual('inventoryCost') != null && manual('inventoryCost') <= summary.cost && average('inventory') > 0 ? manual('inventoryCost') / average('inventory') : null, 'مرة', 'تكلفة المخزون المباع ÷ متوسط المخزون المملوك؛ لا يشمل شحنات العملاء', 'أدخل تكلفة المخزون المباع وصنّف مخزونًا تملكه الشركة، وليس شحنات العملاء'),
    metric('interestCoverage', 'تغطية الفوائد', currentReliable && manual('interestExpense') > 0 && manual('interestExpense') <= summary.expenses ? (summary.operatingProfit + manual('interestExpense')) / manual('interestExpense') : null, 'مرة', '(الربح التشغيلي + الفوائد المسجلة ضمنه) ÷ الفوائد', 'أدخل الفوائد المدرجة ضمن المصروفات التشغيلية؛ صفر لا يعني نقص قدرة الدفع'),
  );
  const split = rows => {
    const map = new Map();
    for (const row of rows) {
      const a = config.accountsById.get(String(row._id.accountId)), section = a && sectionOf(a);
      if (!section) continue;
      const key = row._id.key; if (!map.has(key)) map.set(key, zero());
      map.get(key)[section] += a.type === 'income' ? -row.net : row.net;
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, label: config.offices.get(key)?.name || (key === '-' ? 'غير موزع على مكتب' : key), ...summarize(v), margin: pct(summarize(v).netProfit, v.revenue) }));
  };
  const months = split(raw.monthly);
  const activityDefinitions = [
    ['air', 'الشحن الجوي', 'revenue_shipping_air', 'cost_shipping_air'],
    ['sea', 'الشحن البحري', 'revenue_shipping_sea', 'cost_shipping_sea'],
    ['domestic', 'النقل الداخلي', 'revenue_shipping_domestic', 'cost_shipping_domestic'],
    ['purchases', 'فواتير الشراء', 'revenue_purchase_invoices', 'cost_purchase_invoices'],
    ['services', 'الخدمات', 'revenue_services', 'cost_services'],
  ];
  const activities = activityDefinitions.map(([key, title, revenueRole, costRole]) => {
    const revenueId = config.settings?.accountRoles?.[revenueRole], costId = config.settings?.accountRoles?.[costRole];
    const revenue = accounts.find(a => String(a.accountId) === String(revenueId))?.current || 0;
    const cost = accounts.find(a => String(a.accountId) === String(costId))?.current || 0;
    return { key, title, revenue, cost, grossProfit: revenue - cost, margin: pct(revenue - cost, revenue), configured: !!revenueId && !!costId };
  });
  const otherRevenue = summary.revenue - activities.reduce((sum, a) => sum + a.revenue, 0);
  const otherCost = summary.cost - activities.reduce((sum, a) => sum + a.cost, 0);
  if (otherRevenue || otherCost) activities.push({ key: 'other', title: 'باقي الإيرادات والتكاليف غير المرتبطة بهذه الأنشطة', revenue: otherRevenue, cost: otherCost, grossProfit: otherRevenue - otherCost, margin: null, configured: false });
  // Include empty months so a missing activity month does not disappear from the trend.
  for (let d = `${p.from.slice(0, 7)}-01`; d <= p.to;) {
    const key = d.slice(0, 7); if (!months.some(m => m.key === key)) months.push({ key, label: key, ...summarize(zero()), margin: null });
    const date = new Date(`${d}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); d = date.toISOString().slice(0, 10);
  }
  months.sort((a, b) => a.key.localeCompare(b.key));
  for (const a of accounts) { a.share = pct(a.current, summary.revenue); if (!currentReliable || !previousReliable) a.growth = null; }
  const budget = (planning?.budget || []).map(row => {
    const account = config.accountsById.get(String(row.accountId)), actual = accounts.find(a => String(a.accountId) === String(row.accountId))?.current || 0;
    const variance = actual - row.amount;
    return { accountId: row.accountId, code: account?.code, name: account?.name, section: account && sectionOf(account), planned: row.amount, actual, variance, variancePct: growth(actual, row.amount), favorable: account?.type === 'income' ? variance >= 0 : variance <= 0 };
  });
  const budgetMissing = accounts.filter(a => a.current && !budget.some(b => String(b.accountId) === String(a.accountId)));
  const budgetSummary = summarize(budget.reduce((s, b) => { if (b.section) s[b.section] += b.planned; return s; }, zero()));
  const contributionRate = summary.revenue > 0 ? 1 - variable / summary.revenue : null;
  const breakEvenAvailable = currentReliable && !costUnclassified.length && fixed >= 0 && variable >= 0 && contributionRate > 0;
  const breakEvenRevenue = breakEvenAvailable ? Math.round(fixed / contributionRate) : null;
  const insights = [];
  if (!currentReliable) insights.push({ tone: 'warning', text: 'الفترة الحالية لا تغطيها بيانات موثوقة كاملة؛ تُعرض الأرقام المسجلة فقط ولا يعتمد عليها لتقييم الفترة كلها.', action: '/accounting/review' });
  if (!previousReliable) insights.push({ tone: 'warning', text: 'فترة المقارنة غير مكتملة؛ نسب النمو غير متاحة حتى تأكيد اكتمال بياناتها.', action: '/accounting/financial-analysis' });
  if (p.days !== p.previousDays) insights.push({ tone: 'info', text: 'الفترتان مختلفتان في عدد الأيام؛ لا تفسر الفرق كتحسن أداء دون مراعاة طول الفترة.' });
  if (unknown || difference) insights.push({ tone: 'error', text: 'تحتاج الميزانية مراجعة قبل تفسير مؤشرات المركز المالي.', action: '/accounting/trial-balance' });
  if (negativeBalances) insights.push({ tone: 'warning', text: 'توجد أرصدة أصول أو التزامات بعكس طبيعتها؛ قد تحتاج مقاصة أو تصنيفًا مناسبًا.', action: '/accounting/accounts' });
  if (flow.unexplained) insights.push({ tone: 'warning', text: 'حركة النقد لا تتصالح بالكامل مع التدفقات المصنفة؛ راجع القيود المختلطة والتصنيف.', action: '/accounting/reports?tab=cash' });
  if (currentReliable && summary.netProfit < 0) insights.push({ tone: 'warning', text: 'الفترة تظهر خسارة في الدفاتر. ابدأ بأكبر بنود التكلفة والمصروف ثم راجع اكتمال الإيرادات.', action: '/accounting/reports?tab=income' });
  if (currentReliable && summary.netProfit > 0 && operational < 0) insights.push({ tone: 'warning', text: 'النتيجة ربح، لكن التدفق التشغيلي سالب؛ راجع التحصيل والمدفوعات وتوقيت العمليات.', action: '/accounting/reports?tab=receivables' });
  if (currentReliable && previousReliable && summary.revenue > 0 && comparison.revenue > 0 && pct(summary.netProfit, summary.revenue) < pct(comparison.netProfit, comparison.revenue)) insights.push({ tone: 'info', text: 'هامش صافي الربح انخفض مقارنة بالفترة السابقة؛ راجع نمو التكلفة مقابل الإيراد.', action: '/accounting/reports?tab=income' });
  const openingE = openingEquity, closingE = totalEquity;
  return { period: p, generatedAt: new Date(), currency: 'USD', amountsIn: 'cents', summary, comparison,
    coverage: { reliableFrom, firstDay: coverage.firstDay || null, currentReliable, previousReliable, currentCount: coverage.currentCount || 0, previousCount: coverage.previousCount || 0 },
    changes: Object.keys(summary).map(key => ({ key, current: summary[key], previous: comparison[key], change: summary[key] - comparison[key], growth: currentReliable && previousReliable ? growth(summary[key], comparison[key]) : null })),
    accounts, months, offices: split(raw.offices), activities, ratios, insights,
    balance: { ...balance, equity: totalEquity, openingEquity, difference, openingDifference, balanced: balanceValid, groups, unclassified, negativeBalances },
    cashFlow: flow,
    equityChanges: { opening: openingE, profit: summary.netProfit, otherMovements: closingE - openingE - summary.netProfit, closing: closingE, accounts: capital },
    breakEven: { available: breakEvenAvailable, reason: !currentReliable ? insuff : costUnclassified.length ? 'صنّف جميع التكاليف والمصروفات التشغيلية إلى ثابتة أو متغيرة' : 'هامش المساهمة غير موجب أو التكاليف تحتاج مراجعة', fixed, variable, contributionRate, revenue: breakEvenRevenue, safetyMargin: breakEvenAvailable ? pct(summary.revenue - breakEvenRevenue, summary.revenue) : null, unclassified: costUnclassified },
    planning: planning || { budget: [], version: 0 }, budget: { rows: budget, missing: budgetMissing, complete: !!budget.length && !budgetMissing.length, summary: budgetSummary },
    methodology: ['المبالغ بالدولار بالسنت من الدفاتر؛ النسب غير محسوبة سنويًا.', 'الافتتاح من اليوم السابق لبداية الفترة؛ المقارنة تلقائيًا بالفترة السابقة مساوية الأيام.', 'قيد الإقفال السنوي مستبعد من نتائج الفترات ومشمول في أرصدة المركز المالي.', 'المقامات الصفرية والسالبة لا تنتج نسبًا مضللة؛ تظهر غير متاحة.', 'تصنيف الجاري والمتداول والثابت والمتغير مسؤولية المحاسب ويُحفظ بإعدادات صريحة.', 'محافظ العملاء التزامات وليست إيرادًا، وشحنات العملاء ليست مخزونًا تملكه الشركة.', 'الموازنة والمعلومات الإضافية بيانات تحليلية؛ لا تنشئ قيودًا ولا تغير رصيدًا.', 'فروق الميزانية وعدم تصالح التدفق تنبيهات مراجعة؛ ليس التقرير شهادة تدقيق.'],
  };
}
module.exports = { overview, configuration, saveSettings, savePeriod, readPlan };
