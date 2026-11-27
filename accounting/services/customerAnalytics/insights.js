// «المحلل الذكي» (owner 2026-11-27): reads a section's answer and says, in plain Arabic, what the
// numbers mean, which indicators are good or worrying, and what to do. Not a language model: fixed
// rules that compare the figures with published benchmarks (SOURCES), the previous period and the
// owner's targets, then pick the actions from the usual playbook for that indicator. Every judgement
// can be traced to a rule here and a source in the answer.

const SOURCES = {
  repeat: { label: 'Rivo — Repeat Purchase Rate benchmarks', url: 'https://www.rivo.io/blog/repeat-purchase-rate-complete-guide' },
  shopifyRetention: { label: 'Shopify — Customer retention rate by industry', url: 'https://www.shopify.com/il/blog/average-customer-retention-rate-by-industry' },
  secondPurchase: { label: 'LoyaltyLion — Customer retention metrics', url: 'https://loyaltylion.com/blog/blog-customer-retention-metrics' },
  cohortMethod: { label: 'Polar Analytics — Repeat purchase rate, definitions', url: 'https://www.polaranalytics.com/post/repeat-purchase-rate-ecommerce' },
  ltvCac: { label: 'Chargebee — LTV:CAC ratio', url: 'https://chargebee.com/resources/glossaries/ltv-cac-ratio' },
  ltvCac2026: { label: 'FoundryCRO — LTV:CAC benchmarks 2026', url: 'https://foundrycro.com/blog/ltv-cac-ratio-benchmarks-2026/' },
  delivery: { label: 'Sendcloud — How delivery frustrations impact repeat purchases', url: 'https://sendcloud.com/blog/how-delivery-frustrations-impact-repeat-purchases/' },
  deliveryBringg: { label: 'Bringg — Why a bad delivery drives customers away', url: 'https://bringg.com/resources/blog/what-makes-a-bad-delivery-experience-and-why-it-drives-customers-away' },
  rfm: { label: 'Shopify — RFM analysis', url: 'https://www.shopify.com/blog/rfm-analysis' },
  rfmPlaybook: { label: 'Umbrex — RFM segmentation', url: 'https://umbrex.com/resources/frameworks/marketing-frameworks/rfm-segmentation-recency-frequency-monetary/' },
  concentration: { label: 'SEC filing — significant customer at 10% of revenue', url: 'https://www.sec.gov/Archives/edgar/data/1758766/000175876624000091/stem-20240331.htm' },
  loyalty: { label: 'McKinsey — Next in loyalty', url: 'https://www.mckinsey.com/industries/retail/our-insights/next-in-loyalty-eight-levers-to-turn-customers-into-fans' },
  conversion: { label: 'CleverTap — Converting new e-commerce app users', url: 'https://clevertap.com/blog/quickly-convert-ecommerce-app-users/' },
  firstPurchase: { label: 'Opensend — Time to first purchase', url: 'https://www.opensend.com/post/first-purchase-ecommerce' },
  csat: { label: 'Survicate — CSAT benchmarks', url: 'https://survicate.com/reports/csat-survey-benchmarks/' },
  winBack: { label: 'EightX — Win-back reactivation benchmarks', url: 'https://eightx.co/blog/average-win-back-reactivation-rate-benchmarks' },
  retainCost: { label: 'HubSpot — Customer loyalty (cost of acquisition vs retention)', url: 'https://blog.hubspot.com/service/customer-loyalty' },
};

const METHOD = 'قواعد ثابتة لا تخمين: تُقارن أرقامكم بمعايير منشورة (المصادر أدناه) وبالفترة السابقة وبأهدافكم، ثم تُختار التوصية من دليل العمل المعروف لكل مؤشر. المعايير العالمية للتجارة الإلكترونية؛ نشاطكم شحن وشراء، فالمقارنة الأهم هي مع أرقامكم السابقة.';

const TITLES = {
  repeat: ['رجوع العملاء', 'Repeat Purchase Rate'],
  cohorts: ['الاحتفاظ', 'Cohort Retention'],
  churn: ['العملاء الخاملون', 'Churn & At-Risk'],
  conversion: ['من التسجيل إلى الطلب', 'Signup Conversion'],
  value: ['قيمة العميل', 'Customer Value · CLV · AOV'],
  rfm: ['شرائح العملاء', 'RFM Segmentation'],
  mix: ['مزيج الخدمات', 'Service Mix'],
  geo: ['المدن والمكاتب', 'Geography'],
  staff: ['موظفو المبيعات', 'Sales Rep Performance'],
  delivery: ['مدة التوصيل', 'Delivery Time · SLA'],
  ratings: ['التقييمات', 'Customer Satisfaction · CSAT'],
  loyalty: ['أثر النقاط', 'Loyalty Program Impact'],
  cac: ['تكلفة جلب العميل', 'Customer Acquisition Cost · CAC'],
};

// ---- formatting ----
const num = (v) => Number(v || 0).toLocaleString('en-US');
const trim = (s) => s.replace(/\.0$/, '');
const pct = (r) => (r == null ? '—' : `${trim((r * 100).toFixed(1))}%`);
const pct0 = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
const usd = (cents) => {
  if (cents == null) return '—';
  const d = cents / 100;
  return Math.abs(d) < 100 ? `$${d.toFixed(2)}` : `$${Math.round(d).toLocaleString('en-US')}`;
};
const days = (n) => (n == null ? '—' : `${trim(Number(n).toFixed(1))} يوم`);
const pts = (diff) => `${trim((Math.abs(diff) * 100).toFixed(1))} نقطة`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
// 'YYYY-MM' as «أبريل 2026» (the raw key reads backwards inside Arabic text)
const month = (key) => {
  const [y, m] = String(key || '').split('-').map(Number);
  return y && m ? `${MONTHS[m - 1]} ${y}` : String(key || '');
};

// good / warn / bad by thresholds; `lower` when a smaller value is better
function grade(value, good, warn, lower = false) {
  if (!isNum(value)) return 'info';
  if (lower) return value <= good ? 'good' : value <= warn ? 'warn' : 'bad';
  return value >= good ? 'good' : value >= warn ? 'warn' : 'bad';
}

// An indicator; a saved target decides its status (met: good, missed: bad) and is shown
function indicator({ key, label, labelEn, value, status = 'info', benchmark = null, actual, target, format, lower = false }) {
  const out = { key, label, labelEn, value, status, benchmark, target: null };
  if (isNum(target) && isNum(actual)) {
    out.target = format(target);
    out.status = (lower ? actual <= target : actual >= target) ? 'good' : 'bad';
  }
  return out;
}

const changeLine = (now, before, what) => {
  if (!isNum(now) || !isNum(before)) return null;
  const diff = now - before;
  if (Math.abs(diff) < 0.005) return `${what} ثابتة تقريباً مقارنة بالفترة السابقة.`;
  return `${what} ${diff > 0 ? 'ارتفعت' : 'انخفضت'} ${pts(diff)} مقارنة بالفترة السابقة (${pct(before)} ← ${pct(now)}).`;
};

const empty = (section, sources = []) => ({
  headline: 'لا توجد بيانات كافية في هذه الفترة بعد لتحليلها. وسّعوا الفترة أو انتظروا تراكم الطلبات.',
  summary: [], indicators: [], actions: [], sources,
});

// ---- sections ----
const rules = {
  repeat(r, t) {
    if (!r.customers) return empty('repeat', [SOURCES.repeat]);
    const newShare = r.newCustomers != null ? r.newCustomers / r.customers : null;
    const indicators = [
      indicator({ key: 'repeatRate', label: 'نسبة من طلب أكثر من مرة', labelEn: 'Repeat Rate', value: pct(r.repeatRate), status: grade(r.repeatRate, 0.4, 0.25),
        benchmark: 'متوسط التجارة الإلكترونية 25–30% خلال 12 شهراً (Shopify / Metrilo)', actual: r.repeatRate, target: t.repeatRate, format: pct }),
      indicator({ key: 'returningRate', label: 'نسبة العملاء القدامى', labelEn: 'Returning Rate', value: pct(r.returningRate), actual: r.returningRate, target: t.returningRate, format: pct }),
      indicator({ key: 'newShare', label: 'حصة العملاء الجدد', labelEn: 'New Customer Share', value: pct(newShare), status: newShare > 0.6 ? 'warn' : 'info' }),
    ];
    const summary = [`طلب منكم ${num(r.customers)} عميل في الفترة، و${pct(r.repeatRate)} منهم طلبوا أكثر من مرة.`];
    const change = changeLine(r.repeatRate, r.previous?.repeatRate, 'نسبة الرجوع');
    if (change) summary.push(change);
    if (newShare != null) summary.push(`${pct0(newShare)} من عملاء الفترة جدد (أول طلب لهم).`);
    const headline = r.repeatRate >= 0.4
      ? `عملاؤكم يرجعون أكثر بكثير من المعتاد: ${pct(r.repeatRate)} مقابل 25–30% في التجارة الإلكترونية.`
      : r.repeatRate < 0.25 ? `نسبة الرجوع ضعيفة (${pct(r.repeatRate)}): أغلب العملاء يطلبون مرة واحدة فقط.`
        : `نسبة الرجوع ${pct(r.repeatRate)}، ضمن المعدل العالمي تقريباً.`;
    const actions = [];
    if (isNum(r.previous?.repeatRate) && r.repeatRate < r.previous.repeatRate - 0.03) {
      actions.push({ priority: 'high', text: `نسبة الرجوع نزلت ${pts(r.repeatRate - r.previous.repeatRate)} عن الفترة السابقة: راجعوا «مدة التوصيل» و«التقييمات» لمعرفة السبب.` });
    }
    actions.push({ priority: 'high', text: 'ركّزوا على الطلبية الثانية: أهم فترة هي أول 30 يوماً بعد استلام الشحنة الأولى، تابعوا كل عميل جديد فيها.' });
    if (newShare > 0.6) actions.push({ priority: 'medium', text: 'معظم عملاء الفترة جدد: النمو يعتمد على جلب عملاء جدد أكثر من إرجاعهم، فاستثمروا في متابعة ما بعد الطلب الأول.' });
    actions.push({ priority: 'low', text: 'قارنوا الرقم بأرقامكم كل شهر أكثر من المتوسط العالمي، فنشاط الشحن والشراء بالجملة يختلف عن متاجر التجزئة.' });
    return { headline, summary, indicators, actions, sources: [SOURCES.repeat, SOURCES.shopifyRetention] };
  },

  cohorts(r, t) {
    const avg = r.average || [];
    const m1 = avg.find((a) => a.offset === 1);
    if (!m1 || !isNum(m1.rate)) return empty('cohorts', [SOURCES.secondPurchase]);
    const m3 = avg.find((a) => a.offset === 3);
    const latest = [...(r.cohorts || [])].reverse().find((c) => c.size > 0 && isNum(c.rates?.[1]));
    const indicators = [
      indicator({ key: 'm1', label: 'الاحتفاظ بعد شهر', labelEn: 'M1 Retention', value: pct(m1.rate), status: grade(m1.rate, 0.4, 0.25),
        benchmark: 'بعد أول شراء، فرصة رجوع العميل حوالي 27% في التجارة الإلكترونية (LoyaltyLion)', actual: m1.rate, target: t.month1Retention, format: pct }),
    ];
    if (m3 && isNum(m3.rate)) indicators.push(indicator({ key: 'm3', label: 'الاحتفاظ بعد 3 أشهر', labelEn: 'M3 Retention', value: pct(m3.rate) }));
    if (latest) {
      indicators.push(indicator({ key: 'latest', label: `آخر دفعة (${month(latest.month)}) بعد شهر`, labelEn: 'Latest Cohort M1', value: pct(latest.rates[1]),
        status: latest.rates[1] < m1.rate - 0.05 ? 'warn' : latest.rates[1] > m1.rate + 0.05 ? 'good' : 'info' }));
    }
    const summary = [`من كل 100 عميل جديد، يرجع حوالي ${Math.round(m1.rate * 100)} في الشهر التالي لأول طلب${m3 && isNum(m3.rate) ? `، وحوالي ${Math.round(m3.rate * 100)} بعد 3 أشهر` : ''}.`];
    if (latest) summary.push(`آخر دفعة مكتملة (${month(latest.month)}) احتفظت بـ ${pct(latest.rates[1])} بعد شهر، مقابل متوسط ${pct(m1.rate)}.`);
    const actions = [{ priority: 'high', text: 'رسالة أو مكالمة متابعة بعد 7–14 يوماً من تسليم أول شحنة: اسألوا عن التجربة واعرضوا المساعدة في الطلب التالي.' }];
    if (latest && latest.rates[1] < m1.rate - 0.05) actions.unshift({ priority: 'high', text: `الدفعة الأحدث أضعف من المتوسط: راجعوا ما تغيّر في ${month(latest.month)} (مدة التوصيل؟ الأسعار؟ الموظف المسؤول؟).` });
    actions.push({ priority: 'low', text: 'قارنوا كل دفعة بالدفعات السابقة لها بنفس الطريقة: الرقم الإجمالي قد ينخفض بينما كل دفعة تتحسن.' });
    return { headline: `الاحتفاظ بعد شهر ${pct(m1.rate)}: ${m1.rate >= 0.27 ? 'أعلى' : 'أقل'} من فرصة الرجوع المعتادة (حوالي 27%).`, summary, indicators, actions, sources: [SOURCES.secondPurchase, SOURCES.cohortMethod] };
  },

  churn(r, t) {
    const lost = r.lost || {};
    const risk = r.atRisk || {};
    if (!lost.customers && !risk.customers) {
      return { ...empty('churn'), headline: 'لا يوجد عملاء متوقفون أو في خطر حسب الإعدادات الحالية.', sources: [SOURCES.winBack] };
    }
    const lo = Math.round((lost.customers || 0) * 0.12);
    const hi = Math.round((lost.customers || 0) * 0.20);
    const indicators = [
      indicator({ key: 'lost', label: 'توقفوا', labelEn: 'Churned', value: `${num(lost.customers)} عميل · ${usd(lost.valueCents)}`, status: lost.customers ? 'warn' : 'good',
        actual: lost.customers, target: t.lostCustomers, format: (v) => `${num(v)} عميل`, lower: true }),
      indicator({ key: 'atRisk', label: 'في خطر التوقف', labelEn: 'At Risk', value: `${num(risk.customers)} عميل · ${usd(risk.valueCents)}`, status: risk.customers ? 'warn' : 'good',
        actual: risk.customers, target: t.atRiskCustomers, format: (v) => `${num(v)} عميل`, lower: true }),
      indicator({ key: 'winBack', label: 'المتوقع استرجاعه بحملة', labelEn: 'Expected Win-back', value: `${lo}–${hi} عميل (≈ ${usd((lost.valueCents || 0) * 0.12)}–${usd((lost.valueCents || 0) * 0.2)} من قيمتهم السابقة)`,
        benchmark: 'برامج الاسترجاع تعيد عادة 12–20% من العملاء المتوقفين (EightX)' }),
    ];
    const headline = (risk.valueCents || 0) >= (lost.valueCents || 0) * 0.5
      ? `عندكم ${num(risk.customers)} عميل في خطر التوقف، اشتروا منكم بـ ${usd(risk.valueCents)}: هؤلاء أولى بالاهتمام الآن قبل أن يتوقفوا.`
      : `${num(lost.customers)} عميل توقفوا وكانوا يشترون بـ ${usd(lost.valueCents)}: حملة استرجاع قد تعيد ${lo}–${hi} منهم.`;
    const summary = [`توقف ${num(lost.customers)} عميل (قيمتهم ${usd(lost.valueCents)}) و${num(risk.customers)} في خطر (قيمتهم ${usd(risk.valueCents)}).`,
      'استرجاع عميل يكلّف أقل بكثير من جلب عميل جديد (تقدّر المصادر جلب العميل الجديد بـ 5–25 ضعفاً).'];
    const actions = [
      { priority: 'high', text: 'اتصلوا شخصياً هذا الأسبوع بأكبر عملاء «في خطر» قيمةً. لا تكثروا الرسائل الجماعية لهم: الإلحاح يسرّع خروج العميل المتردد.' },
      { priority: 'high', text: 'حملة استرجاع للمتوقفين (زر «أرسل حملة واتساب») بعرض محدود المدة، وقيسوا بعد 30 يوماً كم رجع منهم.' },
      { priority: 'medium', text: 'اسألوا المتوقفين عن السبب في رسالة قصيرة: التوصيل؟ السعر؟ التواصل؟ واستعملوا الإجابات لإصلاح السبب.' },
      { priority: 'low', text: 'العملاء المتوقفون منذ وقت طويل وقيمتهم قليلة: رسائل آلية فقط، ولا تصرفوا عليهم ميزانية مدفوعة.' },
    ];
    return { headline, summary, indicators, actions, sources: [SOURCES.winBack, SOURCES.retainCost, SOURCES.rfmPlaybook] };
  },

  conversion(r, t) {
    if (!r.signups) return empty('conversion', [SOURCES.conversion]);
    const inv = r.bySource?.invited;
    const dir = r.bySource?.direct;
    const fastShare = r.converted ? (r.within7 || 0) / r.converted : null;
    const indicators = [
      indicator({ key: 'rate', label: 'نسبة من طلب بعد التسجيل', labelEn: 'Signup → Order', value: pct(r.rate), status: grade(r.rate, 0.5, 0.3),
        benchmark: 'في تطبيقات التسوق يشتري 22–57% من المسجلين خلال الشهر الأول (CleverTap)', actual: r.rate, target: t.conversionRate, format: pct }),
      indicator({ key: 'medianDays', label: 'المدة حتى أول طلب (الوسيط)', labelEn: 'Time to First Order', value: days(r.medianDays), status: grade(r.medianDays, 3, 7, true),
        benchmark: 'عادة 2–3 أيام (Opensend)', actual: r.medianDays, target: t.medianDaysToFirstOrder, format: days, lower: true }),
      indicator({ key: 'fast', label: 'من الطالبين طلبوا في أول أسبوع', labelEn: 'Ordered in Week 1', value: pct(fastShare) }),
    ];
    if (inv?.signups && dir?.signups) indicators.push(indicator({ key: 'invited', label: 'المدعوون مقابل المباشرين', labelEn: 'Referred vs Direct', value: `${pct(inv.rate)} مقابل ${pct(dir.rate)}`, status: inv.rate > dir.rate ? 'good' : 'info' }));
    const summary = [`سجّل ${num(r.signups)} وطلب منهم ${num(r.converted)} (${pct(r.rate)})، والوسيط ${days(r.medianDays)} حتى أول طلب.`];
    if (fastShare != null) summary.push(`${pct0(fastShare)} ممن طلبوا فعلوا ذلك في الأسبوع الأول: من لم يطلب بعد أسبوع تقلّ فرصته كثيراً.`);
    if (r.waiting?.total) summary.push(`${num(r.waiting.total)} سجّلوا ولم يطلبوا بعد.`);
    const actions = [{ priority: 'high', text: 'تابعوا من سجّل ولم يطلب خلال 48 ساعة: رسالة ترحيب، شرح طريقة الطلب أو الشحن، وتذكير بهدية التسجيل.' }];
    if (inv?.signups && dir?.signups && inv.rate > dir.rate + 0.05) actions.push({ priority: 'medium', text: `المدعوون يطلبون أكثر (${pct(inv.rate)} مقابل ${pct(dir.rate)}): شجّعوا «دعوة صديق» عند كل تسليم.` });
    actions.push({ priority: 'low', text: 'قيسوا من سجّل حديثاً بعد يوم و7 و30 يوماً: هذا أدقّ من أي معيار عام.' });
    return { headline: `${pct(r.rate)} من المسجلين طلبوا فعلاً، ونصفهم خلال ${days(r.medianDays)}.`, summary, indicators, actions, sources: [SOURCES.conversion, SOURCES.firstPurchase] };
  },

  value(r, t) {
    if (!r.customers) return empty('value', [SOURCES.concentration]);
    const top = r.top?.[0];
    const c = r.concentration || {};
    const skew = r.ltv?.avgCents && r.ltv?.medianCents ? r.ltv.avgCents / r.ltv.medianCents : null;
    const indicators = [
      indicator({ key: 'aov', label: 'متوسط قيمة الطلب', labelEn: 'AOV', value: usd(r.avgOrderCents), actual: r.avgOrderCents, target: t.avgOrderCents, format: usd }),
      indicator({ key: 'opc', label: 'طلبات لكل عميل', labelEn: 'Orders / Customer', value: trim(Number(r.ordersPerCustomer || 0).toFixed(1)), actual: r.ordersPerCustomer, target: t.ordersPerCustomer, format: (v) => trim(v.toFixed(1)) }),
      indicator({ key: 'ltv', label: 'قيمة العميل: المتوسط والوسيط', labelEn: 'LTV (avg · median)', value: `${usd(r.ltv?.avgCents)} · ${usd(r.ltv?.medianCents)}`, status: skew > 3 ? 'warn' : 'info' }),
    ];
    if (top) indicators.push(indicator({ key: 'topCustomer', label: `أكبر عميل (${top.name || '—'})`, labelEn: 'Top Customer Share', value: pct(top.share), status: grade(top.share, 0.05, 0.1, true),
      benchmark: 'الشركات تعتبر أي عميل يتجاوز 10% من الإيراد عميلاً جوهرياً تفصح عنه كخطر (إفصاحات SEC)' }));
    if (isNum(c.top10Share)) indicators.push(indicator({ key: 'top10Share', label: 'حصة أكبر 10 عملاء', labelEn: 'Top-10 Share', value: pct(c.top10Share), status: grade(c.top10Share, 0.3, 0.5, true) }));
    const summary = [`${num(r.orders)} طلب من ${num(r.customers)} عميل، بمتوسط ${usd(r.avgOrderCents)} للطلب و${usd(r.avgCustomerCents)} للعميل.`];
    if (skew > 3) summary.push(`متوسط قيمة العميل (${usd(r.ltv.avgCents)}) أكبر بكثير من الوسيط (${usd(r.ltv.medianCents)}): قلة من العملاء الكبار يرفعون المتوسط، والعميل المعتاد أصغر بكثير.`);
    const concentrated = (top && top.share > 0.1) || c.top10Share >= 0.5;
    const headline = concentrated
      ? `إيرادكم يعتمد على عدد قليل: ${top ? `أكبر عميل وحده ${pct(top.share)} و` : ''}أكبر 10 عملاء ${pct(c.top10Share)}. خسارة واحد منهم تظهر فوراً.`
      : `قيمة الطلبات موزعة بشكل صحي: أكبر 10 عملاء ${pct(c.top10Share)} من القيمة.`;
    const actions = [];
    if (concentrated) {
      actions.push({ priority: 'high', text: 'خطة رعاية لأكبر 10 عملاء: موظف مسؤول عن كل واحد، متابعة شهرية، وأولوية في الشحن والتسليم.' });
      actions.push({ priority: 'medium', text: 'وسّعوا قاعدة العملاء المتوسطين لتقليل الاعتماد على الكبار (عروض للعملاء بين 500 و2,000 دولار).' });
    }
    actions.push({ priority: 'low', text: 'إذا كان بعض الكبار شركات أو تجار جملة، علّموهم «حسابات شركات» وفعّلوا الاستثناء لرؤية الأفراد بوضوح.' });
    return { headline, summary, indicators, actions, sources: [SOURCES.concentration] };
  },

  rfm(r) {
    const seg = Object.fromEntries((r.segments || []).map((s) => [s.key, s]));
    const total = (r.segments || []).reduce((s, x) => s + (x.valueCents || 0), 0);
    const all = (r.segments || []).reduce((s, x) => s + (x.customers || 0), 0);
    if (!all) return empty('rfm', [SOURCES.rfm]);
    const share = (k) => (total ? (seg[k]?.valueCents || 0) / total : null);
    const line = (k) => `${num(seg[k]?.customers)} عميل · ${pct0(share(k))} من القيمة`;
    const indicators = [
      indicator({ key: 'champions', label: 'الأبطال', labelEn: 'Champions', value: line('champions'), status: 'good' }),
      indicator({ key: 'atRisk', label: 'في خطر الفقدان', labelEn: 'At Risk', value: line('atRisk'), status: seg.atRisk?.customers ? 'warn' : 'good' }),
      indicator({ key: 'promising', label: 'جدد واعدون', labelEn: 'Promising', value: line('promising') }),
      indicator({ key: 'lost', label: 'مفقودون ونائمون', labelEn: 'Lost · Hibernating', value: `${num((seg.lost?.customers || 0) + (seg.hibernating?.customers || 0))} عميل`, status: 'info' }),
    ];
    const headline = `${pct0((seg.champions?.customers || 0) / all)} من العملاء «أبطال» ويحققون ${pct0(share('champions'))} من القيمة: حافظوا عليهم أولاً.`;
    const summary = [`${num(all)} عميل مقسّمون حسب: متى آخر طلب (R)، وكم مرة طلبوا (F)، وكم دفعوا (M).`];
    if (seg.atRisk?.customers) summary.push(`${num(seg.atRisk.customers)} عميل كانوا يطلبون كثيراً ثم انقطعوا («في خطر»).`);
    const actions = [
      { priority: 'high', text: 'الأبطال: وصول مبكر للعروض، مزايا ولاء ومستوى أعلى، واطلبوا منهم دعوة أصدقاء. تجنّبوا الخصومات الكبيرة لهم فهم يشترون أصلاً.' },
      { priority: 'high', text: 'في خطر الفقدان: رسالة استرجاع شخصية، أزيلوا سبب الإزعاج (تأخير الشحن، صعوبة التواصل)، واسألوهم عن رأيهم.' },
      { priority: 'medium', text: 'الجدد الواعدون: متابعة بعد التسليم لتحويلهم إلى طلب ثانٍ، فالطلب الثاني هو أصعب خطوة.' },
      { priority: 'low', text: 'النائمون والمفقودون: رسائل آلية قليلة التكلفة، أو استبعادهم من الحملات المدفوعة لتوفير الميزانية.' },
    ];
    return { headline, summary, indicators, actions, sources: [SOURCES.rfm, SOURCES.rfmPlaybook] };
  },

  mix(r) {
    const p = r.byKind?.purchase || {};
    const s = r.byKind?.shipment || {};
    const orders = (p.orders || 0) + (s.orders || 0);
    if (!orders) return empty('mix');
    const value = (p.valueCents || 0) + (s.valueCents || 0);
    const customers = (p.customers || 0) + (s.customers || 0) - (r.bothKinds || 0);
    const both = customers ? (r.bothKinds || 0) / customers : null;
    const air = r.byMethod?.air || {};
    const sea = r.byMethod?.sea || {};
    const tr = r.transitions || {};
    const airToSea = tr.airFirst ? (tr.airThenSea || 0) / tr.airFirst : null;
    const indicators = [
      indicator({ key: 'purchase', label: 'الشراء: من الطلبات / من القيمة', labelEn: 'Purchase Share', value: `${pct0(p.orders / orders)} / ${pct0(value ? p.valueCents / value : null)}` }),
      indicator({ key: 'sea', label: 'البحري من الطلبات', labelEn: 'Sea Share', value: pct0(orders ? (sea.orders || 0) / orders : null) }),
      indicator({ key: 'both', label: 'عملاء يستخدمون الخدمتين', labelEn: 'Cross-sell Rate', value: pct(both), status: grade(both, 0.4, 0.2) }),
      indicator({ key: 'airToSea', label: 'بدأوا جوي ثم جرّبوا البحري', labelEn: 'Air → Sea', value: pct(airToSea) }),
    ];
    const headline = value && p.valueCents / value > (p.orders / orders) * 2
      ? `الشراء ${pct0(p.orders / orders)} فقط من الطلبات لكنه ${pct0(p.valueCents / value)} من القيمة: كل طلب شراء يساوي عدة طلبات شحن.`
      : `${pct0(both)} فقط من العملاء يستخدمون الشراء والشحن معاً.`;
    const shipOnly = Math.max((s.customers || 0) - (r.bothKinds || 0), 0);
    const actions = [
      { priority: 'medium', text: `${num(shipOnly)} عميل يشحنون فقط ولا يستخدمون خدمة الشراء: اعرضوها عليهم (الشراء نيابة عنهم من المورد).` },
      { priority: 'low', text: `عملاء الجوي بكميات كبيرة: عرّفوهم بالبحري للبضائع غير المستعجلة (فقط ${pct(airToSea)} جرّبوه).` },
    ];
    return { headline, summary: [`${num(orders)} طلب: جوي ${num(air.orders)}، بحري ${num(sea.orders)}.`], indicators, actions, sources: [] };
  },

  geo(r) {
    const cities = r.cities || [];
    if (!cities.length) return empty('geo');
    const name = (c) => c.city || 'غير محدد';
    const top2 = (cities[0]?.share || 0) + (cities[1]?.share || 0);
    const small = cities.filter((c) => c.customers >= 3 && c.share < 0.01);
    const indicators = [
      indicator({ key: 'topCity', label: `أكبر مدينة (${name(cities[0])})`, labelEn: 'Top City Share', value: pct(cities[0].share) }),
      indicator({ key: 'top2', label: 'أكبر مدينتين معاً', labelEn: 'Top-2 Concentration', value: pct(top2), status: top2 > 0.7 ? 'warn' : 'info' }),
      indicator({ key: 'cities', label: 'عدد المدن التي فيها طلبات', labelEn: 'Active Cities', value: num(cities.length) }),
    ];
    const actions = [];
    if (top2 > 0.7) actions.push({ priority: 'medium', text: `${pct0(top2)} من القيمة من مدينتين: التوسع في مدن أخرى يقلل المخاطر.` });
    if (small.length) actions.push({ priority: 'low', text: `مدن فيها عملاء لكن قيمة قليلة (${small.slice(0, 4).map(name).join('، ')}): جرّبوا نقطة استلام أو تسويقاً مخصصاً.` });
    return { headline: `${name(cities[0])} وحدها ${pct0(cities[0].share)} من قيمة الطلبات.`, summary: [`طلبات من ${num(cities.length)} مدينة.`], indicators, actions, sources: [] };
  },

  staff(r) {
    const rows = r.rows || [];
    const total = rows.reduce((s, x) => s + (x.newCustomers || 0), 0);
    if (!total) return empty('staff');
    const overall = rows.reduce((s, x) => s + (x.returned || 0), 0) / total;
    const people = rows.filter((x) => x.staffId !== 'app' && x.newCustomers >= 10).sort((a, b) => b.returnRate - a.returnRate);
    const best = people[0];
    const worst = people.length > 1 ? people[people.length - 1] : null;
    const app = rows.find((x) => x.staffId === 'app');
    const indicators = [indicator({ key: 'overall', label: 'نسبة رجوع العملاء الجدد', labelEn: 'New Customer Return Rate', value: pct(overall) })];
    if (best) indicators.push(indicator({ key: 'best', label: `الأفضل (${best.name})`, labelEn: 'Best Rep', value: `${pct(best.returnRate)} من ${num(best.newCustomers)} عميل`, status: 'good' }));
    if (worst) indicators.push(indicator({ key: 'worst', label: `الأقل (${worst.name})`, labelEn: 'Lowest Rep', value: `${pct(worst.returnRate)} من ${num(worst.newCustomers)} عميل`, status: worst.returnRate < overall - 0.15 ? 'bad' : 'warn' }));
    if (app) indicators.push(indicator({ key: 'app', label: 'من التطبيق أو غير معروف', labelEn: 'Self-serve / Unknown', value: `${num(app.newCustomers)} عميل (${pct0(app.newCustomers / total)})` }));
    const actions = [];
    if (best && worst) {
      actions.push({ priority: worst.returnRate < overall - 0.15 ? 'high' : 'medium', text: `اجعلوا ${best.name} يشرح للفريق كيف يتابع عملاءه بعد أول طلب، وراجعوا مع ${worst.name} متابعة العملاء الجدد.` });
    }
    actions.push({ priority: 'low', text: 'لا تقيسوا الموظف بعدد العملاء الجدد فقط: عميل يرجع أهم من عميلين يطلبان مرة واحدة.' });
    const headline = best && worst
      ? `عملاء ${best.name} يرجعون بنسبة ${pct0(best.returnRate)} مقابل ${pct0(worst.returnRate)} لعملاء ${worst.name}.`
      : `نسبة رجوع العملاء الجدد ${pct(overall)}.`;
    return { headline, summary: [`${num(total)} عميل جديد في الفترة، رجع منهم ${pct(overall)}.`], indicators, actions, sources: [] };
  },

  delivery(r, t) {
    if (!r.packages) return empty('delivery', [SOURCES.delivery]);
    const months = (r.months || []).filter((m) => m.packages >= 30 && isNum(m.medianDays));
    const first = months[0];
    const last = months[months.length - 1];
    let trend = 'info';
    if (first && last && first !== last) trend = last.medianDays > first.medianDays * 1.3 ? 'bad' : last.medianDays < first.medianDays * 0.8 ? 'good' : 'info';
    const effect = (r.effect || []).filter((e) => e.customers >= 5 && isNum(e.returnRate));
    const fast = effect[0];
    const slow = effect.length > 1 ? effect[effect.length - 1] : null;
    const gap = fast && slow ? fast.returnRate - slow.returnRate : null;
    const sea = r.byMethod?.sea;
    const air = r.byMethod?.air;
    const indicators = [
      indicator({ key: 'median', label: 'المدة المعتادة (الوسيط)', labelEn: 'Median Delivery', value: days(r.medianDays), status: grade(r.medianDays, 14, 30, true),
        benchmark: 'التأخير هو السبب الأول لتجربة التوصيل السيئة، وثلث المتسوقين تقريباً يتركون المتجر بعد تأخير (Sendcloud 2025)', actual: r.medianDays, target: t.medianDeliveryDays, format: days, lower: true }),
      indicator({ key: 'p90', label: 'أبطأ 10%', labelEn: 'P90', value: days(r.p90Days) }),
      indicator({ key: 'trend', label: 'الاتجاه', labelEn: 'Trend', value: first && last && first !== last ? `${days(first.medianDays)} (${month(first.month)}) ← ${days(last.medianDays)} (${month(last.month)})` : '—', status: trend }),
    ];
    if (air && sea) indicators.push(indicator({ key: 'method', label: 'جوي / بحري (الوسيط)', labelEn: 'Air / Sea', value: `${days(air.medianDays)} / ${days(sea.medianDays)}` }));
    if (gap != null) indicators.push(indicator({ key: 'effect', label: 'أثر أول شحنة على الرجوع', labelEn: 'First Delivery Effect', value: `${pct0(fast.returnRate)} (${fast.label} يوم) مقابل ${pct0(slow.returnRate)} (${slow.label} يوم)`, status: gap >= 0.15 ? 'bad' : 'info' }));
    const headline = gap >= 0.15
      ? `سرعة أول شحنة تحدد رجوع العميل: من وصلته خلال ${fast.label} يوم رجع بنسبة ${pct0(fast.returnRate)}، ومن انتظر ${slow.label} يوم رجع ${pct0(slow.returnRate)} فقط.`
      : `الوسيط ${days(r.medianDays)} من وصول الشحنة لمخزننا حتى تسليمها.`;
    const summary = [`${num(r.packages)} شحنة سُلّمت؛ نصفها خلال ${days(r.medianDays)}، وأبطأ 10% أكثر من ${days(r.p90Days)}.`];
    if (trend === 'bad') summary.push(`المدة في ازدياد: من ${days(first.medianDays)} في ${month(first.month)} إلى ${days(last.medianDays)} في ${month(last.month)}.`);
    const actions = [];
    if (gap >= 0.15) actions.push({ priority: 'high', text: 'أعطوا أول شحنة للعميل الجديد أولوية في التحميل والتسليم: هي التي تقرر هل يرجع.' });
    if (trend === 'bad') actions.push({ priority: 'high', text: `مدة التوصيل تزداد (${days(first.medianDays)} ← ${days(last.medianDays)}): حدّدوا أين يحدث التأخير، في الشحن الدولي أم في التسليم داخل ليبيا.` });
    actions.push({ priority: 'medium', text: 'أبلغوا العميل مسبقاً عند أي تأخير، برسالة فيها السبب والموعد الجديد. الصمت أسوأ من التأخير نفسه.' });
    return { headline, summary, indicators, actions, sources: [SOURCES.delivery, SOURCES.deliveryBringg] };
  },

  ratings(r, t) {
    const withOrders = (r.byStatus || []).reduce((s, x) => s + (x.customers || 0), 0);
    if (!r.rated) {
      return { ...empty('ratings', [SOURCES.csat]), headline: 'لا توجد تقييمات بعد.', actions: [{ priority: 'high', text: 'اطلبوا التقييم بعد كل تسليم: بدونه لا تعرفون من غير راضٍ قبل أن يتوقف.' }] };
    }
    const coverage = withOrders ? r.rated / withOrders : null;
    const lost = (r.byStatus || []).find((x) => x.status === 'lost');
    const active = (r.byStatus || []).find((x) => x.status === 'active');
    const indicators = [
      indicator({ key: 'avgRating', label: 'متوسط التقييم', labelEn: 'CSAT (avg / 5)', value: `${trim(Number(r.avgRating).toFixed(1))} / 5`, status: grade(r.avgRating, 4.3, 3.8),
        benchmark: 'المستوى الجيد عادة 75–85% راضين (4 أو 5 من 5)، أي متوسط قرابة 4 فأكثر (Survicate)', actual: r.avgRating, target: t.avgRating, format: (v) => `${v} / 5` }),
      indicator({ key: 'coverage', label: 'من العملاء قيّموا', labelEn: 'Response Rate', value: `${num(r.rated)} (${pct(coverage)})`, status: coverage >= 0.3 ? 'good' : 'warn' }),
    ];
    if (lost?.rated && active?.rated) indicators.push(indicator({ key: 'lostVsActive', label: 'تقييم المتوقفين مقابل النشطين', labelEn: 'Churned vs Active', value: `${trim(Number(lost.avgRating).toFixed(1))} مقابل ${trim(Number(active.avgRating).toFixed(1))}`, status: lost.avgRating < active.avgRating - 0.3 ? 'warn' : 'info' }));
    const actions = [];
    if (coverage < 0.3) actions.push({ priority: 'high', text: `قيّم ${pct0(coverage)} فقط من العملاء: اطلبوا التقييم بعد كل تسليم، فالحكم على عدد قليل غير دقيق.` });
    if (r.low?.total) actions.push({ priority: 'high', text: `اتصلوا بأصحاب التقييم 3 أو أقل (${num(r.low.total)}) واسألوهم ماذا حدث، خاصة من لم يتوقف بعد.` });
    actions.push({ priority: 'low', text: 'لا تعتمدوا على التقييم وحده: الراضي قد يتوقف أيضاً، فراقبوا «العملاء الخاملون» معه.' });
    return { headline: `متوسط التقييم ${trim(Number(r.avgRating).toFixed(1))} من 5${r.avgRating >= 4.3 ? '، مستوى جيد' : ''}، لكن من ${num(r.rated)} عميل فقط.`, summary: [], indicators, actions, sources: [SOURCES.csat] };
  },

  loyalty(r) {
    const g = Object.fromEntries((r.groups || []).map((x) => [x.key, x]));
    if (!(r.groups || []).some((x) => x.customers)) return empty('loyalty', [SOURCES.loyalty]);
    const red = g.redeemed;
    const none = g.none;
    if (!red?.customers) {
      return { headline: 'لم يستعمل أحد نقاطه بعد: البرنامج جديد، والمقارنة تصبح مفيدة بعد أول استعمالات.', summary: [],
        indicators: [indicator({ key: 'earned', label: 'كسبوا نقاطاً', labelEn: 'Members Earning', value: `${num(g.earnedOnly?.customers)} عميل` })],
        actions: [{ priority: 'medium', text: 'ذكّروا العملاء برصيدهم عند كل فاتورة واعرضوا الدفع بالنقاط: الاستعمال الأول هو ما يربط العميل بالبرنامج.' }], sources: [SOURCES.loyalty] };
    }
    const lift = none?.avgValueCents ? red.avgValueCents / none.avgValueCents - 1 : null;
    const indicators = [
      indicator({ key: 'redeemedRepeat', label: 'رجوع من استعمل نقاطاً', labelEn: 'Redeemers Repeat', value: pct(red.repeatRate), status: red.repeatRate > (none?.repeatRate || 0) ? 'good' : 'info' }),
      indicator({ key: 'noneRepeat', label: 'رجوع من بلا نقاط', labelEn: 'Non-members Repeat', value: pct(none?.repeatRate) }),
      indicator({ key: 'lift', label: 'فرق متوسط القيمة', labelEn: 'Value Lift', value: lift == null ? '—' : `${lift >= 0 ? '+' : ''}${pct0(lift)}`, benchmark: 'من يستعمل النقاط ينفق عادة حوالي 25% أكثر من العضو غير النشط (McKinsey)' }),
    ];
    return {
      headline: `من استعمل نقاطاً يرجع بنسبة ${pct0(red.repeatRate)} مقابل ${pct0(none?.repeatRate)} لمن ليس عنده نقاط.`,
      summary: ['الفرق ارتباط وليس بالضرورة سبباً: العملاء النشطون أصلاً يجمعون نقاطاً أكثر.'],
      indicators,
      actions: [{ priority: 'medium', text: 'شجّعوا أول استعمال للنقاط (اعرضوه عند الدفع): من يستعمل مرة يرتبط بالبرنامج.' }],
      sources: [SOURCES.loyalty],
    };
  },

  cac(r, t) {
    const x = r.totals || {};
    if (!x.newCustomers) return empty('cac', [SOURCES.ltvCac]);
    const ratio = x.valueToCac;
    const zeroMonths = (r.months || []).filter((m) => !(m.marketingCents > 0) && m.newCustomers > 0).length;
    const indicators = [
      indicator({ key: 'cac', label: 'تكلفة جلب العميل', labelEn: 'CAC', value: usd(x.cacCents), actual: x.cacCents, target: t.cacCents, format: usd, lower: true }),
      indicator({ key: 'valueToCac', label: 'قيمة أول 90 يوماً ÷ التكلفة', labelEn: 'LTV:CAC (90d)', value: ratio == null ? '—' : `${trim(Number(ratio).toFixed(1))}×`, status: grade(ratio, 3, 1),
        benchmark: '3:1 قاعدة شائعة، وأكثر من 5:1 يعني أن الإنفاق على النمو أقل من اللازم (Chargebee / FoundryCRO)', actual: ratio, target: t.valueToCac, format: (v) => `${v}×` }),
      indicator({ key: 'value90', label: 'ما يطلبه العميل الجديد في أول 90 يوماً', labelEn: 'Avg 90-day Value', value: usd(x.avgValue90Cents) }),
      indicator({ key: 'withCommissions', label: 'التكلفة مع عمولات الموظفين', labelEn: 'CAC incl. Commissions', value: usd(x.cacWithCommissionsCents) }),
    ];
    const summary = [`صرفتم ${usd(x.marketingCents)} على التسويق و${usd(x.giftsCents)} هدايا نقاط، وجاءكم ${num(x.newCustomers)} عميل جديد: ${usd(x.cacCents)} للعميل.`,
      'القيمة هنا قيمة طلبات وليست ربحاً، فالنسبة الحقيقية بعد هامش الربح أقل.'];
    if (zeroMonths) summary.push(`${zeroMonths} شهر بلا مصروف تسويق وفيها عملاء جدد: جزء كبير من العملاء يأتي بالتوصية والسمعة.`);
    const actions = [];
    if (ratio >= 5) actions.push({ priority: 'high', text: 'الإنفاق على التسويق أقل بكثير مما تحتمله الأرقام: زيدوا الميزانية تدريجياً (مثلاً ضعفها لشهرين) وراقبوا تكلفة العميل الجديد بعدها.' });
    else if (ratio < 1) actions.push({ priority: 'high', text: 'تكلفة جلب العميل أعلى من قيمة ما يطلبه في أول 90 يوماً: راجعوا القنوات الأغلى وأوقفوا ما لا يجلب عملاء.' });
    actions.push({ priority: 'medium', text: 'سجّلوا مصروف كل حملة على حساب «تسويق وإعلانات» واكتبوا القناة في البيان (فيسبوك، تيك توك…)، لتعرفوا أي قناة أرخص.' });
    actions.push({ priority: 'low', text: 'اسألوا كل عميل جديد «كيف عرفتنا؟» عند التسجيل لربط العملاء بالقنوات.' });
    return {
      headline: ratio >= 5 ? `كل دولار تسويق يقابله ${trim(Number(ratio).toFixed(0))}$ طلبات في أول 90 يوماً: التسويق رابح جداً وميزانيته صغيرة.` : `تكلفة العميل الجديد ${usd(x.cacCents)}، وقيمة أول 90 يوماً ${trim(Number(ratio || 0).toFixed(1))} ضعفها.`,
      summary, indicators, actions, sources: [SOURCES.ltvCac, SOURCES.ltvCac2026],
    };
  },
};

// The analyst's reading of one section's answer, or null for a section it does not read
function insightsFor(section, result = {}, { targets } = {}) {
  const rule = rules[section];
  if (!rule) return null;
  const [title, titleEn] = TITLES[section];
  const out = rule(result || {}, targets || result?.targets || {});
  return { title, titleEn, ...out, method: METHOD };
}

module.exports = { insightsFor, SOURCES, TITLES };
