// Odoo 17-19 master-data import. No Odoo connection or database mutations.
const ref = (kind, id) => 'exios_' + kind + '_' + String(id);
function accountType(a, roles, accounts) {
  const role = name => String(roles[name] || '') === String(a._id);
  if (role('customer_receivable')) return 'asset_receivable';
  if (role('payable_carriers') || role('payable_suppliers')) return 'liability_payable';
  if (a.type === 'liability') return a.isCash && a.cashKind === 'bank' ? 'liability_credit_card' : 'liability_current';
  if (a.type === 'asset') {
    if (a.isCash) return a.cashKind === 'current' ? 'asset_current' : 'asset_cash';
    if (role('prepaid_expenses')) return 'asset_prepayments';
    let node = a; const seen = new Set();
    while (node && !seen.has(String(node._id))) {
      seen.add(String(node._id));
      if (node.code === '15') return 'asset_fixed';
      node = accounts.get(String(node.parentId));
    }
    return 'asset_current';
  }
  if (role('depreciation_expense')) return 'expense_depreciation';
  if (a.type === 'expense' && /^51/.test(a.code)) return 'expense_direct_cost';
  return { equity: 'equity', income: 'income', expense: 'expense' }[a.type];
}
function buildMaster(accounts, journals, roles = {}, version = '19') {
  const byId = new Map(accounts.map(a => [String(a._id), a]));
  const accountRef = a => a.odooExternalId || ref('account', a._id);
  const groups = accounts.filter(a => a.isGroup).map(a => ({ id: ref('group', a._id), name: a.name, code_prefix_start: a.code, code_prefix_end: a.code }));
  const detail = accounts.filter(a => !a.isGroup);
  const accountRows = detail.map(a => {
    const type = accountType(a, roles, byId);
    if (!type) throw new Error('نوع حساب غير مدعوم: ' + a.code);
    return { id: accountRef(a), code: a.code, name: a.name, account_type: type,
      reconcile: ['asset_receivable','liability_payable','liability_credit_card'].includes(type) || !!a.isCash,
      'currency_id': a.currency || '' };
  });
  const taken = new Set();
  const journalRows = journals.map(j => {
    const a = byId.get(String(j.defaultAccountId));
    if (j.defaultAccountId && (!a || a.isGroup)) throw new Error('الحساب الافتراضي للدفتر غير صالح: ' + j.name);
    // Stable five-character prefix derived from the immutable source id; resolve collisions deterministically.
    const crypto = require('crypto');
    let salt = 0, code;
    do { code = 'X' + crypto.createHash('sha256').update(String(j._id) + ':' + salt++).digest('hex').slice(0,4).toUpperCase(); } while (taken.has(code));
    taken.add(code);
    const liquid = a?.type === 'asset' && a.isCash && a.cashKind !== 'current';
    const type = version === '19' && a?.type === 'liability' && a.cashKind === 'bank' ? 'credit'
      : liquid && j.type === 'cash' ? 'cash' : liquid && ['bank','ewallet'].includes(j.type) ? 'bank'
      : j.type === 'sales' ? 'sale' : j.type === 'purchases' ? 'purchase' : 'general';
    return { id: j.odooExternalId || ref('journal', j._id), name: j.name, code, type,
      'default_account_id/id': a ? accountRef(a) : '', currency_id: a?.currency || '' };
  });
  return { groups, accounts: accountRows, journals: journalRows };
}
module.exports = { ref, buildMaster };
