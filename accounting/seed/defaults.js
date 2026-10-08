// Default setup created by `npm run accounting:setup`. This is the ONLY place account codes,
// office codes and currencies are written; posting code works with roles (see ROLE_DEFAULTS).

const CURRENCIES = [
  { code: 'USD', name: 'دولار أمريكي', decimals: 2, symbol: '$', isBase: true },
  { code: 'LYD', name: 'دينار ليبي', decimals: 3, symbol: 'د.ل' },
  { code: 'CNY', name: 'يوان صيني', decimals: 2, symbol: '¥' },
  { code: 'TRY', name: 'ليرة تركية', decimals: 2, symbol: '₺' },
  { code: 'EUR', name: 'يورو', decimals: 2, symbol: '€' },
  // Website purchases in the Gulf and the UK: supplier bills in the purchase's own currency (spec 19.13)
  { code: 'KWD', name: 'دينار كويتي', decimals: 3, symbol: 'KD' },
  { code: 'SAR', name: 'ريال سعودي', decimals: 2, symbol: 'SR' },
  { code: 'AED', name: 'درهم إماراتي', decimals: 2, symbol: 'AED' },
  { code: 'OMR', name: 'ريال عماني', decimals: 3, symbol: 'OMR' },
  { code: 'BHD', name: 'دينار بحريني', decimals: 3, symbol: 'BD' },
  { code: 'QAR', name: 'ريال قطري', decimals: 2, symbol: 'QR' },
  { code: 'GBP', name: 'جنيه إسترليني', decimals: 2, symbol: '£' },
];

const OFFICES = [
  { code: 'tripoli', name: 'طرابلس', nameEn: 'Tripoli', country: 'LY', short: 'TRP' },
  { code: 'benghazi', name: 'بنغازي', nameEn: 'Benghazi', country: 'LY', short: 'BEN' },
  { code: 'turkey', name: 'تركيا', nameEn: 'Turkey', country: 'TR', short: 'TUR' },
  { code: 'china', name: 'الصين', nameEn: 'China', country: 'CN', short: 'CHN' },
];

// Values of UserStatement.office that are not offices but an account of one
const STATEMENT_OFFICE_ALIASES = {
  almutahidaTrBank: { office: 'turkey', groupCode: '1102', kind: 'bank', name: 'مصرف المتحدة - تركيا', nameEn: 'Al Mutahida Bank - Turkey' },
  // "بنك الليبي" in the deposit screen
  bank: { office: 'tripoli', groupCode: '1102', kind: 'bank', name: 'المصرف الليبي', nameEn: 'Libyan bank' },
};

const g = (code, name, nameEn, type, parent, extra = {}) => ({ code, name, nameEn, type, parent, isGroup: true, ...extra });
const a = (code, name, nameEn, type, parent, extra = {}) => ({ code, name, nameEn, type, parent, isGroup: false, ...extra });
const OFFICE_DIM = ['office'];

// Parents always come before their children
const ACCOUNTS = [
  g('1', 'الأصول', 'Assets', 'asset', null),
  g('11', 'النقدية وما في حكمها', 'Cash and equivalents', 'asset', '1'),
  g('1101', 'الخزائن', 'Cash boxes', 'asset', '11'),
  a('110101', 'خزينة طرابلس - دولار', 'Tripoli cash - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'tripoli' }),
  a('110102', 'خزينة طرابلس - دينار', 'Tripoli cash - LYD', 'asset', '1101', { currency: 'LYD', isCash: true, cashKind: 'cash', office: 'tripoli' }),
  a('110103', 'خزينة بنغازي - دولار', 'Benghazi cash - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'benghazi' }),
  a('110104', 'خزينة بنغازي - دينار', 'Benghazi cash - LYD', 'asset', '1101', { currency: 'LYD', isCash: true, cashKind: 'cash', office: 'benghazi' }),
  a('110107', 'مكتب تركيا - دولار', 'Turkey office - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'turkey' }),
  a('110108', 'مكتب الصين - دولار', 'China office - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'china' }),
  // The offices' sub cash boxes (spec v8): staff cash operations land here, the accountant moves the
  // money to the main box
  a('110121', 'خزينة فرعية طرابلس - دولار', 'Tripoli sub cash - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'tripoli', subBox: true }),
  a('110122', 'خزينة فرعية طرابلس - دينار', 'Tripoli sub cash - LYD', 'asset', '1101', { currency: 'LYD', isCash: true, cashKind: 'cash', office: 'tripoli', subBox: true }),
  a('110123', 'خزينة فرعية بنغازي - دولار', 'Benghazi sub cash - USD', 'asset', '1101', { currency: 'USD', isCash: true, cashKind: 'cash', office: 'benghazi', subBox: true }),
  a('110124', 'خزينة فرعية بنغازي - دينار', 'Benghazi sub cash - LYD', 'asset', '1101', { currency: 'LYD', isCash: true, cashKind: 'cash', office: 'benghazi', subBox: true }),
  g('1102', 'البنوك', 'Banks', 'asset', '11'),
  a('110201', 'مصرف المتحدة - تركيا', 'Al Mutahida Bank - Turkey', 'asset', '1102', { currency: 'USD', isCash: true, cashKind: 'bank', office: 'turkey' }),
  a('110202', 'بنك البركه التركي - دولار', 'Albaraka bank USD', 'asset', '1102', { currency: 'USD', isCash: true, cashKind: 'bank', office: 'turkey' }),
  a('110203', 'بنك البركه التركي - ليره', 'Albaraka bank TL', 'asset', '1102', { currency: 'TRY', isCash: true, cashKind: 'bank', office: 'turkey' }),
  a('110204', 'بنك الكويت ترك - ليره', 'Kuveyt Türk BANK TRY', 'asset', '1102', { currency: 'TRY', isCash: true, cashKind: 'bank', office: 'turkey' }),
  a('110205', 'بنك الكويت ترك - دولار', 'Kuveyt Türk BANK USD', 'asset', '1102', { currency: 'USD', isCash: true, cashKind: 'bank', office: 'turkey' }),
  g('1103', 'المحافظ الإلكترونية', 'E-wallets', 'asset', '11'),
  a('110301', 'Alipay شركة 1', 'Alipay company 1', 'asset', '1103', { currency: 'CNY', isCash: true, cashKind: 'ewallet', office: 'china' }),
  a('110302', 'Alipay شركة 2', 'Alipay company 2', 'asset', '1103', { currency: 'CNY', isCash: true, cashKind: 'ewallet', office: 'china' }),
  // A partner's current account (spec 19.4): what the partner holds for us, by their statement.
  // It works like a cash box: it can receive a customer's deposit and pay bills.
  g('1104', 'الحسابات الجارية للشركاء', 'Partner current accounts', 'asset', '11'),
  a('110401', 'جاري وصل', 'Wasl current account', 'asset', '1104', { currency: 'USD', isCash: true, cashKind: 'current', office: 'tripoli' }),
  // Dollars paid to a broker for yuan that has not reached Alipay yet (spec 19.5)
  g('1105', 'مدفوعات بانتظار الوصول', 'Payments awaiting arrival', 'asset', '11'),
  a('110501', 'يوان مدفوع بانتظار الوصول', 'Yuan paid, awaiting arrival', 'asset', '1105', { requires: ['vendor'] }),
  g('12', 'الذمم المدينة', 'Receivables', 'asset', '1'),
  a('121000', 'ذمم العملاء', 'Customer receivables', 'asset', '12', { requires: ['partner'], allowManualEntry: true }),
  g('13', 'تكاليف قيد التنفيذ', 'Work in progress', 'asset', '1'),
  a('130100', 'تكاليف رحلات قيد التنفيذ', 'Trip costs in progress', 'asset', '13', { requires: ['trip'] }),
  a('130200', 'تكاليف مشتريات قيد التنفيذ', 'Purchase costs in progress', 'asset', '13', { requires: ['order'] }),
  a('130300', 'تكاليف تخليص جمركي قيد التنفيذ', 'Customs clearance in progress', 'asset', '13', { requires: ['order'] }),
  g('14', 'السلف والمدفوعات المقدمة', 'Advances and prepayments', 'asset', '1'),
  // Custody: money given to spend for the company, settled by its expenses or returned
  a('140100', 'عهد الموظفين', 'Employee custody', 'asset', '14', { requires: ['employee'] }),
  // Each in its own currency: given in dinars, settled in dinars (owner's request 2026-10-04)
  a('140110', 'عهد الموظفين - دينار', 'Employee custody - LYD', 'asset', '14', { currency: 'LYD', requires: ['employee'] }),
  a('140200', 'مصروفات مدفوعة مقدماً', 'Prepaid expenses', 'asset', '14'),
  // Loans to staff, taken back from their salary or returned (owner's request 2026-10-04: apart from custody)
  a('140300', 'سلف الموظفين', 'Employee loans', 'asset', '14', { requires: ['employee'] }),
  a('140310', 'سلف الموظفين - دينار', 'Employee loans - LYD', 'asset', '14', { currency: 'LYD', requires: ['employee'] }),
  g('15', 'الأصول الثابتة', 'Fixed assets', 'asset', '1', { cashFlowCategory: 'investing' }),
  a('150100', 'سيارات', 'Vehicles', 'asset', '15', { cashFlowCategory: 'investing' }),
  a('150200', 'أثاث ومعدات', 'Furniture and equipment', 'asset', '15', { cashFlowCategory: 'investing' }),
  a('150300', 'أجهزة حاسوب واتصالات', 'Computers and telecom', 'asset', '15', { cashFlowCategory: 'investing' }),
  a('150900', 'مجمع الإهلاك', 'Accumulated depreciation', 'asset', '15', { cashFlowCategory: 'investing' }),

  g('2', 'الالتزامات', 'Liabilities', 'liability', null),
  g('21', 'الذمم الدائنة', 'Payables', 'liability', '2'),
  a('210100', 'ذمم شركات الشحن', 'Carrier payables', 'liability', '21', { requires: ['vendor'] }),
  a('210200', 'ذمم الموردين', 'Supplier payables', 'liability', '21', { requires: ['vendor'] }),
  a('219100', 'استردادات موردين قيد التحديد', 'Unidentified supplier refunds', 'liability', '21'),
  g('22', 'محافظ العملاء والإيرادات المؤجلة', 'Customer wallets and deferred revenue', 'liability', '2'),
  a('220100', 'محافظ العملاء - دولار', 'Customer wallets - USD', 'liability', '22', { currency: 'USD', requires: ['partner'] }),
  a('220200', 'محافظ العملاء - دينار', 'Customer wallets - LYD', 'liability', '22', { currency: 'LYD', requires: ['partner'] }),
  a('220300', 'إيرادات مشتريات مؤجلة', 'Deferred purchase revenue', 'liability', '22', { requires: ['order'] }),
  a('220400', 'إيرادات شحن مؤجلة', 'Deferred shipping revenue', 'liability', '22', { requires: ['package'] }),
  g('23', 'القروض', 'Loans', 'liability', '2', { cashFlowCategory: 'financing' }),
  a('230100', 'قروض', 'Loans', 'liability', '23', { cashFlowCategory: 'financing' }),
  g('24', 'المستحقات', 'Accruals', 'liability', '2'),
  a('240100', 'مصروفات مستحقة', 'Accrued expenses', 'liability', '24'),
  // A card is money owed to the bank: spending raises it, paying the card from the bank lowers it
  g('25', 'بطاقات الائتمان', 'Credit cards', 'liability', '2'),
  a('250100', 'بطاقة كويت ترك الائتمانية - ليرة', 'Kuveyt Turk credit card - TRY', 'liability', '25', { currency: 'TRY', isCash: true, cashKind: 'bank', office: 'turkey' }),
  a('250200', 'بطاقة البركة الائتمانية - ليرة', 'Albaraka credit card - TRY', 'liability', '25', { currency: 'TRY', isCash: true, cashKind: 'bank', office: 'turkey' }),
  // A partner who pays for us on their account (spec 19.4): what we owe them by their statement.
  // Aswaq ships from the UAE and Saudi Arabia and pays purchases and taxes for us; we settle in
  // cash dollars. A friend whose card buys for us (a purchase funder) gets an account like it.
  g('26', 'الحسابات الجارية الدائنة للشركاء', 'Partner current accounts (owed)', 'liability', '2'),
  a('260100', 'جاري أسواق', 'Aswaq current account', 'liability', '26', { currency: 'USD', isCash: true, cashKind: 'current', office: 'tripoli' }),

  g('3', 'حقوق الملكية', 'Equity', 'equity', null, { cashFlowCategory: 'financing' }),
  a('310000', 'رأس المال', 'Capital', 'equity', '3', { cashFlowCategory: 'financing' }),
  a('320000', 'الأرباح المحتجزة', 'Retained earnings', 'equity', '3'),
  a('330000', 'مسحوبات الشركاء', 'Partner withdrawals', 'equity', '3', { cashFlowCategory: 'financing' }),
  // Money a partner puts into (or takes out of) the company's accounts outside capital
  a('340000', 'جاري الشركاء', 'Partners current account', 'equity', '3', { cashFlowCategory: 'financing' }),
  a('390000', 'أرصدة افتتاحية', 'Opening balances', 'equity', '3'),
  a('399000', 'فروقات الترحيل التاريخي (معلّق)', 'Migration suspense', 'equity', '3'),

  g('4', 'الإيرادات', 'Income', 'income', null),
  g('41', 'الإيرادات التشغيلية', 'Operating income', 'income', '4'),
  a('410100', 'إيرادات شحن جوي', 'Air shipping revenue', 'income', '41', { requires: OFFICE_DIM }),
  a('410200', 'إيرادات شحن بحري', 'Sea shipping revenue', 'income', '41', { requires: OFFICE_DIM }),
  a('410300', 'مبيعات فواتير الشراء', 'Purchase invoice sales', 'income', '41', { requires: OFFICE_DIM }),
  a('410500', 'إيرادات شحن داخلي', 'Domestic shipping revenue', 'income', '41', { requires: OFFICE_DIM }),
  a('410600', 'إيرادات أخرى', 'Other income', 'income', '41', { requires: OFFICE_DIM }),
  a('410700', 'إيرادات حوالات', 'Remittance revenue', 'income', '41', { requires: OFFICE_DIM }),
  a('410800', 'إيرادات بيع بضائع متروكة', 'Abandoned goods sales', 'income', '41', { requires: OFFICE_DIM }),
  a('410900', 'إيرادات تخليص جمركي', 'Customs clearance revenue', 'income', '41', { requires: OFFICE_DIM }),

  g('5', 'التكاليف والمصروفات', 'Costs and expenses', 'expense', null),
  g('51', 'تكلفة الإيرادات', 'Cost of revenue', 'expense', '5'),
  a('510100', 'تكلفة شحن جوي', 'Air shipping cost', 'expense', '51', { requires: OFFICE_DIM }),
  a('510200', 'تكلفة شحن بحري', 'Sea shipping cost', 'expense', '51', { requires: OFFICE_DIM }),
  a('510300', 'تكلفة شحن داخلي', 'Domestic shipping cost', 'expense', '51', { requires: OFFICE_DIM }),
  a('510400', 'تكلفة فواتير الشراء', 'Purchase invoice cost', 'expense', '51', { requires: OFFICE_DIM }),
  a('510700', 'تكلفة حوالات', 'Remittance cost', 'expense', '51', { requires: OFFICE_DIM }),
  a('510800', 'تكلفة تخليص جمركي', 'Customs clearance cost', 'expense', '51', { requires: OFFICE_DIM }),
  g('52', 'التعويضات والديون المعدومة', 'Compensation and bad debts', 'expense', '5'),
  a('520000', 'تعويضات العملاء', 'Customer compensation', 'expense', '52', { requires: OFFICE_DIM }),
  a('520100', 'ديون معدومة', 'Bad debts written off', 'expense', '52', { requires: OFFICE_DIM }),
  a('520200', 'مبالغ مستردة للعملاء', 'Refunds credited to customers', 'expense', '52', { requires: OFFICE_DIM }),
  g('53', 'المصروفات التشغيلية', 'Operating expenses', 'expense', '5'),
  a('530100', 'رواتب وأجور', 'Salaries and wages', 'expense', '53', { requires: OFFICE_DIM }),
  a('530200', 'إيجارات', 'Rent', 'expense', '53', { requires: OFFICE_DIM }),
  a('530300', 'كهرباء واتصالات وإنترنت', 'Utilities and internet', 'expense', '53', { requires: OFFICE_DIM }),
  a('530400', 'عمولات ورسوم مصرفية وتحويل', 'Bank and transfer fees', 'expense', '53', { requires: OFFICE_DIM }),
  a('530500', 'نقل ومواصلات محلية', 'Local transport', 'expense', '53', { requires: OFFICE_DIM }),
  a('530600', 'وقود وصيانة سيارات', 'Fuel and vehicle maintenance', 'expense', '53', { requires: OFFICE_DIM }),
  a('530700', 'صيانة مكاتب وقرطاسية', 'Office maintenance and stationery', 'expense', '53', { requires: OFFICE_DIM }),
  a('530800', 'مصروفات عامة أخرى', 'Other general expenses', 'expense', '53', { requires: OFFICE_DIM }),
  a('530900', 'عجز/زيادة الخزينة', 'Cash over and short', 'expense', '53', { requires: OFFICE_DIM }),
  a('531000', 'تسويق وإعلانات', 'Marketing and advertising', 'expense', '53', { requires: OFFICE_DIM }),
  a('531100', 'برمجيات واشتراكات', 'Software and subscriptions', 'expense', '53', { requires: OFFICE_DIM }),
  a('531200', 'رسوم حكومية وتراخيص', 'Government fees and licenses', 'expense', '53', { requires: OFFICE_DIM }),
  a('531300', 'ضيافة', 'Hospitality', 'expense', '53', { requires: OFFICE_DIM }),
  a('531400', 'مواد تغليف', 'Packaging materials', 'expense', '53', { requires: OFFICE_DIM }),
  a('531500', 'سفر وتذاكر طيران', 'Travel and flights', 'expense', '53', { requires: OFFICE_DIM }),
  a('531600', 'مواقف سيارات', 'Parking', 'expense', '53', { requires: OFFICE_DIM }),
  a('531700', 'خدمات من موردين', 'Services from suppliers', 'expense', '53', { requires: OFFICE_DIM }),
  g('54', 'الإهلاك', 'Depreciation', 'expense', '5'),
  a('540100', 'مصروف الإهلاك', 'Depreciation expense', 'expense', '54', { requires: OFFICE_DIM }),
  a('540200', 'أرباح/خسائر بيع أصول ثابتة', 'Gain/loss on asset disposal', 'expense', '54', { requires: OFFICE_DIM }),

  g('7', 'فروقات العملة', 'Currency differences', 'expense', null),
  a('710100', 'أرباح/خسائر فروقات الصرف', 'Exchange gain/loss', 'expense', '7'),
  a('710200', 'فروقات التقريب', 'Rounding differences', 'expense', '7'),
];

// Role -> default account code, and the account types a role may point to
const ROLE_DEFAULTS = {
  customer_receivable: ['121000', ['asset']],
  yuan_in_transit: ['110501', ['asset']],
  trip_cost_wip: ['130100', ['asset']],
  purchase_cost_wip: ['130200', ['asset']],
  customs_cost_wip: ['130300', ['asset']],
  employee_advances: ['140100', ['asset']],
  employee_loans: ['140300', ['asset']],
  employee_advances_lyd: ['140110', ['asset']],
  employee_loans_lyd: ['140310', ['asset']],
  prepaid_expenses: ['140200', ['asset']],
  accumulated_depreciation: ['150900', ['asset']],
  payable_carriers: ['210100', ['liability']],
  payable_suppliers: ['210200', ['liability']],
  wallet_usd: ['220100', ['liability']],
  wallet_lyd: ['220200', ['liability']],
  deferred_purchase_revenue: ['220300', ['liability']],
  deferred_shipping_revenue: ['220400', ['liability']],
  loans: ['230100', ['liability']],
  accrued_expenses: ['240100', ['liability']],
  capital: ['310000', ['equity']],
  retained_earnings: ['320000', ['equity']],
  partner_withdrawals: ['330000', ['equity']],
  opening_balance: ['390000', ['equity']],
  migration_suspense: ['399000', ['equity']],
  revenue_shipping_air: ['410100', ['income']],
  revenue_shipping_sea: ['410200', ['income']],
  revenue_purchase_invoices: ['410300', ['income']],
  revenue_shipping_domestic: ['410500', ['income']],
  revenue_other: ['410600', ['income']],
  revenue_remittance: ['410700', ['income']],
  revenue_abandoned_sale: ['410800', ['income']],
  revenue_customs: ['410900', ['income']],
  cost_shipping_air: ['510100', ['expense']],
  cost_shipping_sea: ['510200', ['expense']],
  cost_shipping_domestic: ['510300', ['expense']],
  cost_purchase_invoices: ['510400', ['expense']],
  cost_remittance: ['510700', ['expense']],
  cost_customs: ['510800', ['expense']],
  compensation_expense: ['520000', ['expense']],
  bad_debt_expense: ['520100', ['expense']],
  customer_refunds: ['520200', ['expense']],
  salaries_expense: ['530100', ['expense']],
  bank_fees: ['530400', ['expense']],
  general_expense: ['530800', ['expense']],
  cash_over_short: ['530900', ['expense']],
  depreciation_expense: ['540100', ['expense']],
  asset_disposal: ['540200', ['expense', 'income']],
  fx_gain_loss: ['710100', ['expense', 'income']],
  rounding: ['710200', ['expense', 'income']],
};

const ROLE_LABELS = {
  customer_receivable: 'ذمم العملاء',
  trip_cost_wip: 'تكاليف رحلات قيد التنفيذ',
  purchase_cost_wip: 'تكاليف مشتريات قيد التنفيذ',
  customs_cost_wip: 'تكاليف تخليص جمركي قيد التنفيذ',
  employee_advances: 'عهد الموظفين',
  employee_loans: 'سلف الموظفين',
  employee_advances_lyd: 'عهد الموظفين - دينار',
  employee_loans_lyd: 'سلف الموظفين - دينار',
  prepaid_expenses: 'مصروفات مدفوعة مقدماً',
  accumulated_depreciation: 'مجمع الإهلاك',
  payable_carriers: 'ذمم شركات الشحن',
  payable_suppliers: 'ذمم الموردين',
  wallet_usd: 'محافظ العملاء - دولار',
  wallet_lyd: 'محافظ العملاء - دينار',
  deferred_purchase_revenue: 'إيرادات مشتريات مؤجلة',
  deferred_shipping_revenue: 'إيرادات شحن مؤجلة',
  loans: 'القروض',
  accrued_expenses: 'مصروفات مستحقة',
  capital: 'رأس المال',
  retained_earnings: 'الأرباح المحتجزة',
  partner_withdrawals: 'مسحوبات الشركاء',
  opening_balance: 'أرصدة افتتاحية',
  migration_suspense: 'فروقات الترحيل (معلّق)',
  revenue_shipping_air: 'إيراد شحن جوي',
  revenue_shipping_sea: 'إيراد شحن بحري',
  revenue_purchase_invoices: 'مبيعات فواتير الشراء',
  revenue_shipping_domestic: 'إيراد شحن داخلي',
  revenue_other: 'إيرادات أخرى',
  revenue_remittance: 'إيرادات حوالات Alipay',
  revenue_abandoned_sale: 'إيرادات بيع بضائع متروكة',
  revenue_customs: 'إيرادات تخليص جمركي',
  yuan_in_transit: 'يوان مدفوع بانتظار الوصول',
  cost_shipping_air: 'تكلفة شحن جوي',
  cost_shipping_sea: 'تكلفة شحن بحري',
  cost_shipping_domestic: 'تكلفة شحن داخلي',
  cost_purchase_invoices: 'تكلفة فواتير الشراء',
  cost_remittance: 'تكلفة حوالات Alipay',
  cost_customs: 'تكلفة تخليص جمركي',
  compensation_expense: 'تعويضات العملاء',
  bad_debt_expense: 'ديون معدومة',
  customer_refunds: 'مبالغ مستردة للعملاء',
  salaries_expense: 'الرواتب',
  bank_fees: 'رسوم مصرفية',
  general_expense: 'مصروفات عامة',
  cash_over_short: 'عجز/زيادة الخزينة',
  depreciation_expense: 'مصروف الإهلاك',
  asset_disposal: 'أرباح/خسائر بيع أصول',
  fx_gain_loss: 'فروقات الصرف',
  rounding: 'فروقات التقريب',
};

const JOURNALS = [
  { code: 'SALES', name: 'دفتر المبيعات', type: 'sales', sequencePrefix: 'SALE' },
  { code: 'PURCH', name: 'دفتر المشتريات', type: 'purchases', sequencePrefix: 'PURCH' },
  { code: 'WALLET', name: 'دفتر المحافظ', type: 'wallet', sequencePrefix: 'WAL' },
  { code: 'GEN', name: 'القيود العامة', type: 'general', sequencePrefix: 'JV' },
  { code: 'FX', name: 'فروقات العملة', type: 'fx', sequencePrefix: 'FX' },
  { code: 'DEPR', name: 'الإهلاك والأقساط', type: 'depreciation', sequencePrefix: 'DEPR' },
  { code: 'MIG', name: 'الترحيل التاريخي', type: 'migration', sequencePrefix: 'MIG' },
];

// '@cash' = the journal of the cash/bank account used on the entry
const EVENT_JOURNALS = {
  DEPOSIT: '@cash',
  WITHDRAWAL: '@cash',
  CASH_PAYMENT: '@cash',
  TRANSFER: '@cash',
  CASHCOUNT: '@cash',
  VENDOR_PAYMENT: '@cash',
  VENDOR_RECEIPT: '@cash',
  YUAN_PURCHASE: '@cash',
  ABANDONED_SALE: '@cash',
  YUAN_ARRIVAL: '@cash',
  SALARY: '@cash',
  EQUITY: '@cash',
  BANK_LINE: '@cash',
  OPENING_CASH: 'MIG',
  COMPENSATION: 'WALLET',
  REFUND: 'WALLET',
  SERVICE_FEE: 'WALLET',
  WALLET_PAYMENT: 'WALLET',
  SETTLEMENT: 'WALLET',
  SETTLEMENT_CANCEL: 'WALLET',
  NETTING: 'WALLET',
  PURCHASE_BILLED: 'SALES',
  CLAIM_WRITEOFF: 'SALES',
  WRITEOFF_RECOVERY: 'SALES',
  SHIPMENT_BILLED: 'SALES',
  SHIPMENT_REPRICE: 'SALES',
  SHIPMENT_RECOGNIZED: 'SALES',
  PURCHASE_RECOGNIZED: 'SALES',
  TRIP_TRUEUP: 'SALES',
  ORDER_CANCEL: 'SALES',
  PACKAGE_REMOVE: 'SALES',
  AMOUNT_EDIT: 'SALES',
  DEBT_WRITEOFF: 'SALES',
  RECLASS_PARTNER: 'SALES',
  CLAIM: 'SALES',
  RECOGNITION: 'SALES',
  COST_RECOGNITION: 'SALES',
  GENERAL_DEBT: 'SALES',
  BILL: 'PURCH',
  DEPRECIATION: 'DEPR',
  ASSET_DISPOSAL: 'DEPR',
  PREPAID_AMORT: 'DEPR',
  MIGRATION_ADJUST: 'MIG',
  MANUAL: 'GEN',
  YEAR_CLOSE: 'GEN',
  BALANCE_TRANSFER: 'GEN',
};

// seedKey -> vendor. 'cash_expenses' is the vendor of quick expenses paid on the spot.
const VENDORS = [
  ...require('./merchants'),
  { seedKey: 'historical_carrier', name: 'شركة شحن - تاريخي', type: 'carrier' },
  { seedKey: 'historical_supplier', name: 'مورد مشتريات - تاريخي', type: 'supplier' },
  { seedKey: 'cash_expenses', name: 'مصروفات نقدية', type: 'service' },
];

// Quick expense types -> expense account code
const EXPENSE_TYPES = [
  ['rent', 'إيجار', 'Rent', '530200'],
  ['salaries', 'رواتب', 'Salaries', '530100'],
  ['electricity', 'كهرباء', 'Electricity', '530300'],
  ['water', 'ماء', 'Water', '530300'],
  ['internet', 'إنترنت واتصالات', 'Internet and phone', '530300'],
  ['fuel', 'وقود وصيانة سيارات', 'Fuel and vehicle maintenance', '530600'],
  ['office', 'صيانة مكاتب وقرطاسية', 'Office maintenance and stationery', '530700'],
  ['hospitality', 'ضيافة', 'Hospitality', '531300'],
  ['transport', 'نقل محلي', 'Local transport', '530500'],
  ['bank_fees', 'رسوم مصرفية', 'Bank fees', '530400'],
  ['transfer_fees', 'عمولات تحويل', 'Transfer fees', '530400'],
  ['government', 'رسوم حكومية وتراخيص', 'Government fees and licenses', '531200'],
  ['marketing', 'تسويق وإعلانات', 'Marketing and advertising', '531000'],
  ['software', 'برمجيات واشتراكات', 'Software and subscriptions', '531100'],
  ['packaging', 'مواد تغليف', 'Packaging materials', '531400'],
  ['other', 'مصروفات أخرى', 'Other expenses', '530800'],
].map(([seedKey, name, nameEn, accountCode]) => ({ seedKey, name, nameEn, accountCode }));

// The vendor a site's bills go to (purchases and expenses are posted as a bill in dollars and its
// payment from the bank); a site not listed is billed to the merchant written on the line
const SITE_VENDORS = {
  alibaba: 'Alibaba', 1688: '1688', taobao: 'Taobao', aliexpress: 'AliExpress', amazon: 'Amazon', amzn: 'Amazon', ebay: 'eBay',
  temu: 'Temu', shein: 'Shein', noon: 'Noon', trendyol: 'Trendyol', hepsiburada: 'Hepsiburada', iherb: 'iHerb', walmart: 'Walmart',
  google: 'Google', odoo: 'Odoo', kaspersky: 'Kaspersky', microsoft: 'Microsoft', adobe: 'Adobe', openai: 'OpenAI', github: 'GitHub',
  godaddy: 'GoDaddy', namecheap: 'Namecheap', hostinger: 'Hostinger', zoom: 'Zoom', canva: 'Canva', 'apple com': 'Apple',
  tiktok: 'TikTok', facebook: 'Meta', facebk: 'Meta', meta: 'Meta', snapchat: 'Snapchat', instagram: 'Meta',
  thy: 'Turkish Airlines', 'turkish airlines': 'Turkish Airlines', pegasus: 'Pegasus', flydubai: 'flydubai', emirates: 'Emirates',
  'qatar airways': 'Qatar Airways', 'booking com': 'Booking.com',
};

// Where a statement line goes, by the words in its text (bank and card statements); a refund from
// the same site goes back to the same account. Every one is a normal rule the owner can change or
// delete; lines no rule knows are left for review. A website purchase that matches a purchase cost
// typed on an order is linked to that order instead (see services/posting/bank.js).
// { bank } limits a rule to one account's statements (it wins over the general ones); vendor '@bank'
// bills the charge to the bank itself.
const MUTAHEDA_VENDOR = 'مورد خدمات - المتحدة';

const BANK_RULES = [
  ...require('./merchants').filter(v => v.bankPurpose !== 'yuan_purchase').flatMap(v => v.bankAliases.map(keyword => [keyword, v.bankAccountCode || '510400', 0, { vendor: v.name, office: v.bankOffice }])),
  // Websites: buying for customers' invoices (purchase invoice cost)
  ...['alibaba', '1688', 'taobao', 'aliexpress', 'amazon', 'amzn', 'ebay', 'temu', 'shein', 'noon', 'trendyol', 'hepsiburada', 'iherb', 'walmart',
    // Gulf shops paid through their payment pages
    'salla', 'mf', 'tap', 'amwal pay', 'myfatoorah',
    ].map((keyword) => [keyword, '510400']),
  // Weak hints: every shop in Kuwait, Saudi Arabia and the Emirates (card lines end with the
  // country code), and suppliers paid by transfer ("... Co. Ltd.", "Trading", "Import and Export")
  ...['kwt', 'kuwait', 'sau', 'riyadh', 'jeddah', 'makkah', 'are', 'uae', 'dubai', 'abu dhabi', 'sharjah',
    'limited', 'ltd', 'trading', 'import and export', 'giden havale'].map((keyword) => [keyword, '510400', -1]),
  // Bank charges and late fees
  ...['swift masrafi', 'muhabir', 'masraf tahsilati', 'gecikme tazminati', 'eft ucreti', 'havale ucreti', 'komisyon', 'bsmv'].map((keyword) => [keyword, '530400', 0, { vendor: '@bank' }]),
  // Parking (GENCSOY is the car park the office uses)
  ...['gencsoy', 'otopark', 'ispark', 'parking'].map((keyword) => [keyword, '531600', 0, { vendor: keyword === 'gencsoy' ? 'GENCSOY' : undefined }]),
  // A partner putting money in or taking it out ("... /Ortaklık/Şirket Yetkilisi")
  ...['ortaklik', 'sirket yetkilisi'].map((keyword) => [keyword, '340000']),
  // Services the company itself uses
  ...['google', 'odoo', 'kaspersky', 'nexway', 'microsoft', 'adobe', 'openai', 'github', 'godaddy', 'namecheap', 'hostinger', 'zoom', 'canva', 'apple com'].map((keyword) => [keyword, '531100']),
  ...['tiktok', 'facebook', 'facebk', 'meta', 'snapchat', 'instagram'].map((keyword) => [keyword, '531000']),
  ...['thy', 'turkish airlines', 'pegasus', 'flydubai', 'emirates', 'qatar airways', 'booking com'].map((keyword) => [keyword, '531500']),
  // ---- The company's own accounts ----
  // Kuveyt Türk: the lira account pays the card; lira comes in by FAST from the Albaraka lira account
  ['kredi kartı borç ödemesi', '250100', 1, { bank: '110204' }],
  ['fast para transferi', '110203', 1, { bank: '110204' }],
  ['kredi kartı borç ödeme', '110204', 1, { bank: '250100' }],
  // Albaraka: the card is paid from the lira account; dollars are sold into the lira account; the
  // dollars deposited by the owner were withdrawn from Al Mutaheda
  ['ödeme için teşekkür ederiz', '110203', 1, { bank: '250200' }],
  ['usd satış', '110203', 1, { bank: '110202' }],
  ['ortaklik', '110201', 1, { bank: '110202' }],
  ['sirket yetkilisi', '110201', 1, { bank: '110202' }],
  // Al Mutaheda: "Com" is its commission. 1414 is the company's own client number there; money
  // sent to another number pays a supplier of services (a service bill of that supplier). Money
  // received is almost always a customer paying, already entered as a wallet deposit on Al
  // Mutaheda: it has no rule, so it is matched to that deposit
  ['com', '530400', 2, { bank: '110201', vendor: '@bank' }],
  ['1414', '531700', 0, { bank: '110201', vendor: `${MUTAHEDA_VENDOR} {party:1414}`, direction: 'out' }],
].map(([keyword, accountCode, priority = 0, { bank, vendor, office, direction = 'any' } = {}]) => ({
  seedKey: `bank-rule:${bank ? `${bank}:` : ''}${keyword}${direction === 'any' ? '' : `:${direction}`}`, keyword, direction, accountCode, priority,
  bankCode: bank || null, office, vendorName: vendor || SITE_VENDORS[keyword] || undefined,
})).filter((rule, index, all) => all.findIndex(other => other.seedKey === rule.seedKey) === index);

const SETTINGS = {
  fiscalYearStartMonth: 1,
  timezone: 'Africa/Tripoli',
  lockDate: null,
};

module.exports = {
  CURRENCIES,
  OFFICES,
  STATEMENT_OFFICE_ALIASES,
  ACCOUNTS,
  ROLE_DEFAULTS,
  ROLE_LABELS,
  JOURNALS,
  EVENT_JOURNALS,
  VENDORS,
  EXPENSE_TYPES,
  BANK_RULES,
  SETTINGS,
};
