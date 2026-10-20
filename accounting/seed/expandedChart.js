// Additive chart extension. Existing account codes and balances remain untouched.
const accounts = [];
const roles = {}, labels = {};
const group = (code, name, type, parent) => accounts.push({ code, name, type, parent, isGroup: true });
const detail = (code, name, type, parent, role, extra = {}) => {
  accounts.push({ code, name, type, parent, isGroup: false, ...extra });
  if (role) { roles[role] = [code, [type]]; labels[role] = name; }
};
const currencies = ['USD', 'LYD', 'CNY', 'TRY', 'EUR', 'KWD', 'SAR', 'AED', 'OMR', 'BHD', 'QAR', 'GBP'];
// Keep the original suffixes of retained currencies; account numbers must never shift.
const removedAccountCodes = ['1106', '1293', '1702', '2402', '2403'].flatMap(prefix =>
  currencies.map((currency, index) => ({ currency, code: `${prefix}${String(index + 1).padStart(2, '0')}` }))
    .filter(item => ['KWD', 'SAR', 'AED', 'OMR', 'BHD', 'QAR', 'GBP'].includes(item.currency) || (prefix === '2402' && item.currency === 'EUR'))
    .map(item => item.code));
for (const [code, name, role, type, parent, category] of [
  ['1293', 'حوالات خاطئة قيد الاسترداد', 'mistaken_transfer', 'asset', '12', 'other_current_asset'],
  ['1106', 'تحويلات بين الحسابات قيد الوصول', 'transfer_in_transit', 'asset', '11', 'other_current_asset'],
  ['1702', 'تأمينات مكاتب ومخازن مستردة', 'refundable_deposit', 'asset', '17', 'other_current_asset'],
  ['2402', 'رواتب موظفين مستحقة', 'salary_payable', 'liability', '24', 'current_liability'],
  ['2403', 'عمولات موظفين مستحقة', 'commission_payable', 'liability', '24', 'current_liability'],
]) {
  group(code, name, type, parent);
  currencies.forEach((currency, i) => {
    const accountCode = `${code}${String(i + 1).padStart(2, '0')}`;
    if (!removedAccountCodes.includes(accountCode)) detail(accountCode, `${name} - ${currency}`, type, code,
      `${role}_${currency.toLowerCase()}`, { currency, analysisCategory: category });
  });
}
detail('129900', 'مخصص خسائر ذمم العملاء', 'asset', '12', 'receivables_allowance', { analysisCategory: 'receivables_allowance' });
group('18', 'مخزون الشركة', 'asset', '1');
detail('180100', 'بضائع تملكها الشركة', 'asset', '18', 'company_inventory', { analysisCategory: 'inventory' });
detail('180900', 'مخصص انخفاض قيمة مخزون الشركة', 'asset', '18', 'inventory_allowance', { analysisCategory: 'inventory_allowance' });
detail('230300', 'قروض طويلة الأجل', 'liability', '23', 'long_term_loans', { analysisCategory: 'noncurrent_liability', cashFlowCategory: 'financing' });
detail('230400', 'أقساط قروض مستحقة خلال سنة', 'liability', '23', 'current_loan_portion', { analysisCategory: 'current_liability', cashFlowCategory: 'financing' });
for (const [code, name, role] of [
  ['150910', 'مجمع إهلاك السيارات', 'depreciation_vehicles'], ['150920', 'مجمع إهلاك الأثاث والمعدات', 'depreciation_equipment'],
  ['150930', 'مجمع إهلاك أجهزة الحاسوب والاتصالات', 'depreciation_computers'],
]) detail(code, name, 'asset', '15', role, { analysisCategory: 'noncurrent_contra', cashFlowCategory: 'investing' });
const expenses = [
  ['530110', 'عمولات ومكافآت الموظفين', 'employee_commission_expense'],
  ['530310', 'كهرباء ومياه', 'utilities_expense'], ['530320', 'هاتف واتصالات', 'telephone_expense'], ['530330', 'إنترنت', 'internet_expense'],
  ['530410', 'رسوم البنوك', 'bank_charges_expense'], ['530420', 'رسوم التحويل وAlipay', 'transfer_fees_expense'],
  ['530610', 'وقود', 'fuel_expense'], ['530620', 'صيانة سيارات', 'vehicle_maintenance_expense'],
  ['530710', 'صيانة مكاتب ومخازن', 'office_maintenance_expense'], ['530720', 'قرطاسية ومطبوعات', 'stationery_expense'],
  ['531901', 'مصروف ضرائب - ليبيا', 'tax_libya_expense'], ['531902', 'مصروف ضرائب - تركيا', 'tax_turkey_expense'],
  ['531910', 'خسائر حوالات خاطئة غير مستردة', 'mistaken_transfer_loss'],
];
expenses.forEach(([code, name, role]) => detail(code, name, 'expense', '53', role, { requires: ['office'] }));
detail('520300', 'مصروف مخصص خسائر ذمم العملاء', 'expense', '52', 'receivables_allowance_expense', { requires: ['office'] });
detail('520400', 'خسائر انخفاض قيمة المخزون', 'expense', '52', 'inventory_impairment_expense', { requires: ['office'] });
detail('510920', 'تكلفة بيع بضائع الشركة', 'expense', '51', 'company_inventory_cost', { requires: ['office'] });
detail('411200', 'مبيعات بضائع الشركة', 'income', '41', 'company_inventory_revenue', { requires: ['office'] });
detail('411300', 'زيادة الخزينة', 'income', '41', 'cash_surplus', { requires: ['office'] });
detail('530910', 'عجز الخزينة', 'expense', '53', 'cash_shortage', { requires: ['office'] });
group('42', 'أرباح فروقات العملة', 'income', '4');
detail('420100', 'أرباح صرف محققة', 'income', '42', 'fx_realized_gain');
detail('420200', 'أرباح إعادة تقييم عملات', 'income', '42', 'fx_unrealized_gain');
detail('710300', 'خسائر صرف محققة', 'expense', '7', 'fx_realized_loss');
detail('710400', 'خسائر إعادة تقييم عملات', 'expense', '7', 'fx_unrealized_loss');
module.exports = { accounts, roles, labels, expenses, currencies, removedAccountCodes };
