// Daily reconciliation (spec 10): things that must always hold between the ledger and the
// system, and situations the accountant should look at. Each check returns what it found; none
// of them changes anything.
const mongoose = require('mongoose');
const { JournalEntry, AccountingEvent, Reconciliation, ReviewedItem } = require('../../models');
const { SupplierBill, FixedAsset, PrepaidExpense, BankStatementLine } = require('../../models/documents');
const Wallet = require('../../../models/wallet');
const Order = require('../../../models/order');
const Inventory = require('../../../models/inventory');
const User = require('../../../models/user');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const Balance = require('../../../models/balance');
const { getConfig } = require('../config');
const { accountTotals } = require('../balances');
const { today, addDays, monthOf } = require('../dates');
const { monthsBetween, lastClosedMonth } = require('../posting/schedules');
const { ROLE_DEFAULTS } = require('../../seed/defaults');
const { roleIds, netBy, receivables, payables, purchaseProfitability } = require('./operations');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const SAMPLE = 50;
// An item is known by its link (one order, one trip) or else its text. Items the accountant marked
// as reviewed are left out of items to review and notices (never out of errors) and counted apart
const refOf = (item) => String(item.url || item.arKey || item.label || '');
let reviewed = new Map();
const loadReviewed = async () => {
  reviewed = new Map();
  (await ReviewedItem.find({}).select('check ref').lean()).forEach((r) => {
    if (!reviewed.has(r.check)) reviewed.set(r.check, new Set());
    reviewed.get(r.check).add(r.ref);
  });
};
const result = (key, severity, title, hint, all, link) => {
  const marked = severity === 'error' ? null : reviewed.get(key);
  const items = marked ? all.filter((item) => !marked.has(refOf(item))) : all;
  items.forEach((item) => { item.ref = refOf(item); });
  return { key, severity, title, hint, count: items.length, reviewedCount: all.length - items.length, items: items.slice(0, SAMPLE), link };
};

const userNames = async (ids) => new Map((await User.find({ _id: { $in: ids.filter(mongoose.isValidObjectId) } }).select('firstName lastName customerId').lean())
  .map((u) => [String(u._id), `${u.customerId || ''} ${u.firstName || ''} ${u.lastName || ''}`.trim()]));

const CHECKS = {
  // 3. The books balance
  async balanced() {
    const [totals] = await JournalEntry.aggregate([{ $unwind: '$lines' }, { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }]);
    const difference = (totals?.debit || 0) - (totals?.credit || 0);
    return result('balanced', 'error', 'مجموع المدين لا يساوي مجموع الدائن', 'الدفاتر يجب أن تتوازن دائماً. أبلغ عن هذا فوراً.', difference ? [{ label: 'الفرق', usd: difference }] : []);
  },

  // 1. Each customer wallet in the system equals the ledger
  async wallets() {
    const { currencies } = await getConfig();
    const roles = await roleIds(['wallet_usd', 'wallet_lyd']);
    const items = [];
    for (const [role, currency] of [['wallet_usd', 'USD'], ['wallet_lyd', 'LYD']]) {
      if (!roles[role]) continue;
      const accountId = oid(roles[role]);
      const ledger = await JournalEntry.aggregate([
        { $match: { 'lines.accountId': accountId } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': accountId } },
        { $group: { _id: '$lines.partnerId', foreign: { $sum: { $ifNull: ['$lines.amountCurrency', 0] } } } },
      ]);
      const booked = new Map(ledger.map((row) => [String(row._id), -row.foreign]));
      const decimals = currencies.get(currency)?.decimals ?? 2;
      const wallets = await Wallet.find({ currency }).select('user balance').lean();
      // Preserve negative balances: clamping them to zero hid invalid wallet operations (such as
      // a negative deposit) from this reconciliation check.
      const system = new Map(wallets.map((w) => [String(w.user), Math.round((Number(w.balance) || 0) * 10 ** decimals)]));
      new Set([...booked.keys(), ...system.keys()]).forEach((partner) => {
        const difference = (system.get(partner) || 0) - (booked.get(partner) || 0);
        if (partner !== 'null' && partner !== 'undefined' && difference) items.push({ partnerId: partner, currency, decimals, system: system.get(partner) || 0, booked: booked.get(partner) || 0, difference, url: `/user/${partner}` });
      });
    }
    const names = await userNames(items.map((item) => item.partnerId));
    items.forEach((item) => { item.label = names.get(item.partnerId) || item.partnerId; });
    items.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    return result('wallets', 'error', 'محفظة عميل في المنظومة لا تطابق الدفاتر', 'عملية على المحفظة لم تُرحَّل، أو تعديل مباشر على الرصيد. راجع كشف العميل وقائمة العمليات الفاشلة.', items);
  },

  // Operations of the system waiting with an error
  async failedEvents() {
    const events = await AccountingEvent.find({ status: 'failed' }).sort({ createdAt: -1 }).limit(SAMPLE).lean();
    const count = await AccountingEvent.countDocuments({ status: 'failed' });
    const out = result('failedEvents', 'error', 'عمليات من المنظومة لم تُرحَّل بسبب خطأ', 'عالج السبب (مثل سعر ناقص) ثم أعد المحاولة من الإعدادات.', events.map((e) => ({ label: `${e.type}: ${e.lastError || ''}`, day: e.createdAt })), '/accounting/settings?tab=live');
    out.count = count;
    return out;
  },

  // 4 + 16. A box with money in its currency but no dollar value (or the reverse), or below zero
  async cashBoxes() {
    const { accountsById } = await getConfig();
    const cash = [...accountsById.values()].filter((a) => a.isCash && !a.isGroup);
    const totals = await accountTotals({ accountIds: cash.map((a) => a._id) });
    const items = [];
    cash.forEach((account) => {
      const t = totals.get(String(account._id));
      if (!t) return;
      const foreign = account.currency && account.currency !== 'USD';
      const base = { label: `${account.code} ${account.name}`, usd: t.closingUsd, foreign: foreign ? t.foreign : undefined, currency: account.currency, url: `/accounting/accounts/${account._id}` };
      // Credit cards and creditor current accounts normally have a credit balance.
      // Totals use debit minus credit, so a negative balance on these liabilities is expected.
      if (account.type !== 'liability' && (t.foreign < 0 || (!foreign && t.closingUsd < 0))) items.push({ ...base, note: 'الرصيد سالب' });
      else if (foreign && t.foreign === 0 && t.closingUsd !== 0) items.push({ ...base, note: 'لا عملة فيها لكن لها قيمة بالدولار' });
    });
    return result('cashBoxes', 'error', 'خزينة برصيد سالب أو غير متسق', 'الخزينة لا تكون سالبة: حركة ناقصة (إيداع، تحويل) أو مسجلة على خزينة أخرى.', items);
  },

  // 13. The suspense account is not empty
  async suspense() {
    const roles = await roleIds(['migration_suspense']);
    const usd = (await accountTotals({ accountIds: [oid(roles.migration_suspense)] })).get(roles.migration_suspense)?.closingUsd || 0;
    return result('suspense', 'warn', 'حساب المعلّق غير صفري', 'مبالغ تنتظر توجيهها لحساباتها الصحيحة.', usd ? [{ label: 'رصيد المعلّق', usd }] : [], '/accounting/suspense');
  },

  // 5. Delivered and paid, but the revenue is still deferred
  async unrecognized() {
    const { settings } = await getConfig();
    const tolerance = settings.recognitionToleranceCents ?? 200;
    const roles = await roleIds(['deferred_shipping_revenue', 'customer_receivable']);
    const deferred = await netBy('packageId', [oid(roles.deferred_shipping_revenue)]);
    const waiting = [...deferred.entries()].filter(([, map]) => -(map.get(roles.deferred_shipping_revenue) || 0) > 0).map(([id]) => id).filter(mongoose.isValidObjectId);
    if (!waiting.length) return result('unrecognized', 'error', 'طرد مسلّم ومسدّد وإيراده ما زال مؤجلاً', '', []);
    const orders = await Order.find({ 'paymentList._id': { $in: waiting.map(oid) }, isCanceled: { $ne: true } }).select('orderId paymentList._id paymentList.status.received paymentList.deliveredPackages.trackingNumber').lean();
    const open = await netBy('packageId', [oid(roles.customer_receivable)]);
    const items = [];
    orders.forEach((order) => (order.paymentList || []).forEach((pkg) => {
      const id = String(pkg._id);
      if (!waiting.includes(id) || !pkg.status?.received) return;
      if ((open.get(id)?.get(roles.customer_receivable) || 0) > tolerance) return;
      items.push({ label: `${order.orderId} · ${pkg.deliveredPackages?.trackingNumber || id}`, usd: -(deferred.get(id).get(roles.deferred_shipping_revenue) || 0), url: `/invoice/${order._id}/edit` });
    }));
    return result('unrecognized', 'error', 'طرد مسلّم ومسدّد وإيراده ما زال مؤجلاً', 'يُفترض أن يُعترف به تلقائياً. افتح الطلب واحفظه ليُعاد فحصه، أو راجع العمليات الفاشلة.', items);
  },

  // 9. Paid more than billed
  async overpaid() {
    const { claims } = await receivables({});
    // A payment on an inactive order is its own check (unsurePaid), not listed twice
    const unsure = new Set((await Order.find({ unsureOrder: true }).select('_id').lean()).map((o) => String(o._id)));
    const items = claims.filter((c) => c.open < 0 && c.arKey && !unsure.has(String(c.orderId))).map((c) => ({ label: `${c.orderNumber || c.arKey}${c.tracking ? ` · ${c.tracking}` : ''}`, usd: c.open, url: c.orderId ? `/invoice/${c.orderId}/edit` : null }));
    return result('overpaid', 'warn', 'مطالبة دُفع عليها أكثر من قيمتها', 'دفعة مكررة، أو سعر خُفّض بعد الدفع. الزائد يُعاد للعميل أو يُوجَّه لمطالبة أخرى.', items, '/accounting/reports?tab=receivables');
  },

  // Dollars paid beyond what was owed, taken as profit (decision 119): above 5$ the accountant
  // confirms each one (marks it reviewed) or corrects it if it was the customer's money
  async overpaidProfit() {
    const { OVERPAID_LABEL, OVERPAID_REVIEW_CENTS } = require('../posting/operations');
    const roles = await roleIds(['revenue_other']);
    const revenue = oid(roles.revenue_other);
    const entries = await JournalEntry.find({ status: 'posted', reversalOf: null, lines: { $elemMatch: { accountId: revenue, label: OVERPAID_LABEL, credit: { $gt: OVERPAID_REVIEW_CENTS } } } })
      .select('number day lines').sort({ day: -1 }).lean();
    const orderIds = entries.map((e) => e.lines.find((l) => l.label === OVERPAID_LABEL)?.orderId).filter(Boolean);
    const orders = new Map((await Order.find({ _id: { $in: orderIds } }).setOptions({ withDeleted: true }).select('orderId').lean()).map((o) => [String(o._id), o.orderId]));
    const items = entries.map((entry) => {
      const line = entry.lines.find((l) => String(l.accountId) === String(revenue) && l.label === OVERPAID_LABEL);
      return {
        label: `${orders.get(String(line.orderId)) || 'دين'} · ${entry.number}`, usd: line.credit, day: entry.day,
        url: line.orderId ? `/accounting/customer-invoices/${line.orderId}?entry=${entry.number}` : `/accounting/entries?search=${entry.number}`,
      };
    });
    return result('overpaidProfit', 'warn', 'دفع زائد بالدولار أكثر من 5$ سُجّل مكسباً',
      'سُجّل إيرادات أخرى (القرار 119). إن كان صحيحاً علّمه «تمت المراجعة». إن كان مال العميل (دفعة مكررة مثلاً) احذف الدفعة من تبويب Payments في الطلب وأعد إدخالها بالمبلغ الصحيح.',
      items, '/accounting/reports?tab=receivables');
  },

  // 11. Purchase orders sold with no cost
  async purchases() {
    const { results } = await purchaseProfitability({});
    const items = results.filter((r) => r.withoutCost).map((r) => ({ label: `${r.orderNumber} · بلا تكلفة`, usd: r.revenue, url: `/invoice/${r.orderId}/edit` }));
    return result('purchases', 'warn', 'فاتورة شراء مسددة بلا تكلفة', 'ربح 100% يعني غالباً فاتورة مورد لم تُدخل.', items, '/accounting/reports?tab=purchases');
  },

  // 7. A cancelled order whose supplier cost is still waiting (owner's decision: the customer
  // got everything back on cancelling; the cost waits here until the accountant settles it)
  async canceledOrderCosts() {
    const { results } = await purchaseProfitability({});
    const items = results.filter((r) => r.stuckCost).map((r) => ({ label: r.orderNumber, usd: r.costInProgress, url: `/accounting/customer-invoices/${r.orderId}` }));
    return result('canceledOrderCosts', 'warn', 'طلب ملغى عليه تكلفة مورد معلّقة',
      'دُفع للمورد على طلب أُلغي. سوِّها من صفحة الطلب في المحاسبة: ما أعاده المورد يُسجَّل «ريفاند» بمبلغ محفظة صفر، أو إشعار دائن على فاتورة المورد، أو تُنقل التكلفة لطلب آخر بقيد يدوي (130200 من الطلب الملغى إلى الطلب الجديد).',
      items, '/accounting/reports?tab=purchases');
  },

  // A purchase order whose supplier cost is below zero: a supplier refund bigger than the cost
  // recorded on it, usually because the purchase itself was never entered. Its profit is too high
  async negativeOrderCost() {
    const roles = await roleIds(['purchase_cost_wip', 'cost_purchase_invoices', 'cost_remittance']);
    const ids = Object.values(roles).filter(Boolean).map(oid);
    const rows = await JournalEntry.aggregate([
      { $match: { 'lines.accountId': { $in: ids }, 'lines.orderId': { $exists: true } } }, { $unwind: '$lines' },
      // A free package's share of its trip (it carries the trip) is not the purchase
      { $match: { 'lines.accountId': { $in: ids }, 'lines.orderId': { $ne: null }, 'lines.tripId': null } },
      { $group: { _id: '$lines.orderId', cost: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
      { $match: { cost: { $lt: 0 } } },
    ]);
    const orders = new Map((await Order.find({ _id: { $in: rows.map((r) => r._id) } }).setOptions({ withDeleted: true }).select('orderId').lean()).map((o) => [String(o._id), o]));
    const items = rows.map((row) => ({ label: orders.get(String(row._id))?.orderId || String(row._id), usd: row.cost, note: 'ريفاند المورد أكبر من تكلفة الشراء المسجلة', url: `/accounting/customer-invoices/${row._id}` }));
    return result('negativeOrderCost', 'warn', 'طلب تكلفته بالسالب',
      'أُدخل ريفاند من المورد على طلب ليس عليه تكلفة شراء مسجلة (أو أقل منه)، فظهر ربحه أكبر من الحقيقة. أدخل تكلفة الشراء الأصلية بتاريخها (سطر مشتريات على الطلب، أو إرسال حوالة Alipay).',
      items, '/accounting/reports?tab=purchases');
  },

  // 12. Trips that arrived with no cost entered
  async tripsWithoutCost() {
    const roles = await roleIds(['trip_cost_wip', 'cost_shipping_air', 'cost_shipping_sea', 'cost_shipping_domestic']);
    const trips = await Inventory.find({ inventoryType: 'inventoryGoods', 'orders.0': { $exists: true } }).select('voyage arrivalDate status createdAt').lean();
    const withCost = new Set((await JournalEntry.distinct('lines.tripId', { 'lines.accountId': { $in: Object.values(roles).filter(Boolean).map(oid) } })).map(String));
    const items = trips.filter((t) => !withCost.has(String(t._id)) && (t.status === 'finished' || t.arrivalDate))
      .map((t) => ({ label: t.voyage, day: t.arrivalDate || t.createdAt, url: `/inventory/${t._id}/edit` }));
    return result('tripsWithoutCost', 'warn', 'رحلة وصلت بلا أي تكلفة مسجلة', 'أدخل فاتورة شركة الشحن ومصاريف الرحلة، وإلا ظهر ربحها أعلى من الحقيقة.', items, '/accounting/trips');
  },

  // 14 + 15. Monthly schedules behind
  async schedules() {
    const limit = lastClosedMonth();
    const items = [];
    const assets = await FixedAsset.find({ status: 'posted', assetStatus: 'active' }).select('name purchaseDay depreciationPosted').lean();
    assets.forEach((asset) => {
      const done = new Set(asset.depreciationPosted.map((p) => p.month));
      const missing = monthsBetween(monthOf(asset.purchaseDay), limit).filter((month) => !done.has(month));
      if (missing.length) items.push({ label: `إهلاك ${asset.name}: ${missing.length} شهراً لم يُرحَّل`, day: missing[0] });
    });
    const prepaid = await PrepaidExpense.find({ status: 'posted' }).select('description startMonth months amortizationPosted').lean();
    prepaid.forEach((schedule) => {
      const done = new Set(schedule.amortizationPosted.map((p) => p.month));
      const missing = monthsBetween(schedule.startMonth, limit).slice(0, schedule.months).filter((month) => !done.has(month));
      if (missing.length) items.push({ label: `قسط ${schedule.description}: ${missing.length} شهراً لم يُرحَّل`, day: missing[0] });
    });
    return result('schedules', 'warn', 'إهلاك أو قسط مصروف مقدم فائت', 'رحّله من شاشة الأصول والمقدمات.', items, '/accounting/assets');
  },

  // 17. Bank statement lines waiting more than 30 days
  async bankLines() {
    const lines = await BankStatementLine.find({ lineStatus: 'unmatched', day: { $lt: addDays(today(), -30) } }).sort({ day: 1 }).limit(500).lean();
    return result('bankLines', 'warn', 'سطور كشف بنك غير مطابقة منذ أكثر من 30 يوماً', 'طابقها أو أنشئ لها قيداً من شاشة مطابقة البنك.', lines.map((l) => ({ label: l.description || l.reference || '-', day: l.day })), '/accounting/bank');
  },

  // 18. Vendor bills unpaid for more than 60 days
  async oldBills() {
    const { items } = await payables({});
    const old = items.filter((item) => item.kind === 'bill' && item.open > 0 && item.age > 60)
      .map((item) => ({ label: `${item.number || ''} · ${item.vendor || ''} · ${item.age} يوماً`, usd: item.open, url: item.billId ? `/accounting/bills/${item.billId}` : null }));
    return result('oldBills', 'info', 'فواتير موردين غير مسددة منذ أكثر من 60 يوماً', '', old, '/accounting/reports?tab=payables');
  },

  // 20. Revenue, expense and cash lines must carry an office
  async missingOffice() {
    const { accountsById } = await getConfig();
    const ids = [...accountsById.values()].filter((a) => !a.isGroup && (a.requires || []).includes('office')).map((a) => a._id);
    const lineMatch = { 'lines.accountId': { $in: ids }, 'lines.office': { $in: [null, ''] } };
    const entries = await JournalEntry.aggregate([{ $match: lineMatch }, { $unwind: '$lines' }, { $match: lineMatch }, { $group: { _id: '$_id', number: { $first: '$number' }, day: { $first: '$day' } } }, { $limit: 500 }]);
    return result('missingOffice', 'warn', 'سطور إيراد أو مصروف بدون مكتب', 'لا تدخل في أرباح أي مكتب.', entries.map((e) => ({ label: e.number, day: e.day, url: `/accounting/entries/${e._id}` })));
  },

  // 21 + 26. Every role points to an active detail account
  async roles() {
    const { settings, accountsById } = await getConfig();
    const items = Object.keys(ROLE_DEFAULTS).map((role) => {
      const account = accountsById.get(String(settings.accountRoles?.[role] || ''));
      if (!account) return { label: `${role}: بلا حساب` };
      if (account.isGroup) return { label: `${role}: مربوط بمجموعة ${account.code}` };
      if (!account.isActive) return { label: `${role}: الحساب ${account.code} مؤرشف` };
      return null;
    }).filter(Boolean);
    return result('roles', 'error', 'دور بلا حساب صالح', 'العمليات التي تستخدم هذا الدور ستفشل. اربطه من الإعدادات.', items, '/accounting/settings?tab=roles');
  },

  // 24. Archived accounts must be empty
  async archivedBalances() {
    const { accountsById } = await getConfig();
    const archived = [...accountsById.values()].filter((a) => !a.isGroup && !a.isActive);
    const totals = await accountTotals({ accountIds: archived.map((a) => a._id) });
    const items = archived.filter((a) => (totals.get(String(a._id))?.closingUsd || 0) !== 0)
      .map((a) => ({ label: `${a.code} ${a.name}`, usd: totals.get(String(a._id)).closingUsd, url: `/accounting/accounts/${a._id}` }));
    return result('archivedBalances', 'warn', 'حساب مؤرشف عليه رصيد', 'حوّل رصيده لحساب نشط بقيد.', items);
  },

  // 27. Every wallet deduction (statement '-') has exactly one entry in effect, and nothing is
  // posted from a delivery invoice (spec E8: the statement line is the only source)
  async walletDeductions() {
    const { settings } = await getConfig();
    const title = 'خصم من المحفظة بلا قيد أو بأكثر من قيد';
    if (!settings?.migrationDate) return result('walletDeductions', 'error', title, '', []);
    const [statements, posted, fromInvoices] = await Promise.all([
      UserStatement.find({ calculationType: '-', amount: { $gt: 0 }, 'accountingSource.model': { $exists: false } }).select('_id user amount currency createdAt description').lean(),
      JournalEntry.aggregate([
        // A rounding entry beside a debt payment is not a second posting of it
        { $match: { 'source.model': 'UserStatement', reversalOf: null, eventType: { $ne: 'ROUNDING' } } },
        { $group: { _id: '$source.id', count: { $sum: { $cond: [{ $eq: ['$status', 'posted'] }, 1, 0] } }, reversed: { $sum: { $cond: [{ $eq: ['$status', 'reversed'] }, 1, 0] } } } },
      ]),
      JournalEntry.countDocuments({ 'source.model': 'Invoice' }),
    ]);
    const counts = new Map(posted.map((row) => [String(row._id), row.count]));
    // A payment cancelled later (given back to the wallet) keeps its line: its entry was reversed
    // exactly, which is right; only "never posted" or "posted twice" is a problem
    const cancelled = new Set(posted.filter((row) => !row.count && row.reversed).map((row) => String(row._id)));
    const items = statements.filter((s) => (counts.get(String(s._id)) || 0) !== 1 && !cancelled.has(String(s._id))).map((s) => ({
      label: `${s.description || ''} · ${s.amount} ${s.currency}`, day: s.createdAt, note: counts.get(String(s._id)) ? `${counts.get(String(s._id))} قيود` : 'بلا قيد', url: `/user/${s.user}`,
    }));
    if (fromInvoices) items.unshift({ label: `${fromInvoices} قيد مصدره فاتورة تسليم (Invoice)`, note: 'لا يجوز: الخصم يُرحَّل من سطر الكشف' });
    return result('walletDeductions', 'error', title, 'كل خصم من المحفظة يُرحَّل مرة واحدة من سطر الكشف نفسه. راجع العمليات الفاشلة.', items);
  },

  // 28. Everything the system created after the cutoff was recorded for live posting (spec 19.11)
  async liveCoverage() {
    const { settings } = await getConfig();
    const title = 'عملية بعد لحظة الانتقال لم تُسجَّل للترحيل';
    if (!settings?.cutoffAt) return result('liveCoverage', 'error', title, '', []);
    const after = { createdAt: { $gt: settings.cutoffAt } };
    const [statements, cashPayments, orders, debts] = await Promise.all([
      UserStatement.find({ ...after, 'accountingSource.model': { $exists: false } }).select('_id description amount currency user createdAt').lean(),
      OrderPaymentHistory.find({ ...after, paymentType: 'cash' }).select('_id receivedAmount currency createdAt').lean(),
      Order.find({ ...after, unsureOrder: { $ne: true } }).select('_id orderId createdAt').lean(),
      Balance.find({ ...after, balanceType: 'debt' }).select('_id notes createdAt').lean(),
    ]);
    const recorded = new Set((await AccountingEvent.distinct('refId', { createdAt: { $gt: settings.cutoffAt } })).map(String));
    const items = [
      ...statements.filter((s) => !recorded.has(String(s._id))).map((s) => ({ label: `كشف: ${s.description || ''} · ${s.amount} ${s.currency}`, day: s.createdAt, url: `/user/${s.user}` })),
      ...cashPayments.filter((p) => !recorded.has(String(p._id))).map((p) => ({ label: `دفع نقدي: ${p.receivedAmount} ${p.currency}`, day: p.createdAt })),
      ...orders.filter((o) => !recorded.has(String(o._id))).map((o) => ({ label: `طلب ${o.orderId}`, day: o.createdAt, url: `/invoice/${o._id}/edit` })),
      ...debts.filter((d) => !recorded.has(String(d._id))).map((d) => ({ label: `دين: ${d.notes || ''}`, day: d.createdAt })),
    ];
    return result('liveCoverage', 'error', title, 'كل كشف ودفعة وطلب ودين بعد لحظة الانتقال يُسجَّل حدثاً للترحيل. افتح العملية واحفظها، أو أبلغ المبرمج.', items);
  },

  // 2. What the books say is still owed on each order equals what the order screen says (the
  // order total, or the packages' weight x price, less the payments on the order at their rates)
  async claimsVsSystem() {
    const { settings } = await getConfig();
    const title = 'المتبقي على طلب في الدفاتر يختلف عن المنظومة';
    if (!settings?.migrationDate) return result('claimsVsSystem', 'warn', title, '', []);
    const tolerance = Math.max(settings.recognitionToleranceCents ?? 200, 100);
    const roles = await roleIds(['customer_receivable']);
    const receivable = oid(roles.customer_receivable);
    const ledger = await JournalEntry.aggregate([
      { $match: { 'lines.accountId': receivable } }, { $unwind: '$lines' },
      { $match: { 'lines.accountId': receivable, 'lines.orderId': { $ne: null }, 'lines.arKey': { $ne: null } } },
      { $group: { _id: { orderId: '$lines.orderId', kind: { $substrCP: ['$lines.arKey', 0, 3] } }, open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        // What the migration moved to other revenue as paid beyond the claim (decision 77, reviewed
        // in its report): known, so it is not shown here again
        overpaidMoved: { $sum: { $cond: [{ $regexMatch: { input: '$eventKey', regex: '^OVERPAID:' } }, { $subtract: ['$lines.debit', '$lines.credit'] }, 0] } } } },
    ]);
    const byOrder = new Map();
    ledger.forEach((row) => {
      const entry = byOrder.get(String(row._id.orderId)) || { PUR: 0, SHP: 0 };
      entry[row._id.kind] = (entry[row._id.kind] || 0) + row.open;
      entry[`${row._id.kind}moved`] = (entry[`${row._id.kind}moved`] || 0) + row.overpaidMoved;
      byOrder.set(String(row._id.orderId), entry);
    });
    const ids = [...byOrder.keys()].filter(mongoose.isValidObjectId).map(oid);
    const [orders, payments] = await Promise.all([
      Order.find({ _id: { $in: ids }, isCanceled: { $ne: true }, unsureOrder: { $ne: true } }).select('orderId isPayment totalInvoice paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice paymentList.deliveredPackages.domesticFee paymentList.deliveredPackages.customsFee paymentList.deliveredPackages.abandoned').lean(),
      OrderPaymentHistory.find({ order: { $in: ids } }).select('order category currency receivedAmount rate').lean(),
    ]);
    // A claim written off or a package declared abandoned is lowered in the books on purpose (each has
    // its own list); the system page still shows the full charge, so those orders are not compared
    const { ClaimWriteOff } = require('../../models/documents');
    const writtenOff = new Set((await ClaimWriteOff.find({ status: 'posted', orderId: { $in: ids } }).select('orderId').lean()).map((w) => String(w.orderId)));
    const paid = new Map();
    payments.forEach((p) => {
      const amount = Number(p.receivedAmount || 0);
      const usd = p.currency === 'USD' ? amount : Number(p.rate) > 0 ? amount / Number(p.rate) : 0;
      const key = `${p.order}|${p.category === 'receivedGoods' ? 'SHP' : 'PUR'}`;
      paid.set(key, (paid.get(key) || 0) + Math.round(usd * 100));
    });
    const items = [];
    orders.forEach((order) => {
      const books = byOrder.get(String(order._id));
      if (writtenOff.has(String(order._id)) || (order.paymentList || []).some((pkg) => pkg.deliveredPackages?.abandoned?.status)) return;
      const system = {
        PUR: order.isPayment ? Math.round(Number(order.totalInvoice || 0) * 100) - (paid.get(`${order._id}|PUR`) || 0) : 0,
        SHP: (order.paymentList || []).reduce((sum, pkg) => sum + require('../claims/keys').packageChargeCents(pkg) + Math.round(Number(pkg.deliveredPackages?.domesticFee?.usd || 0) * 100) + Math.round(Number(pkg.deliveredPackages?.customsFee?.usd || 0) * 100), 0)
          - (paid.get(`${order._id}|SHP`) || 0),
      };
      ['PUR', 'SHP'].forEach((kind) => {
        const difference = (books[kind] || 0) - system[kind];
        // Paid beyond the claim and moved to other revenue (decision 77): the system may count that
        // payment (it shows the excess) or not (a dinar payment with no rate); either agrees
        const beforeMove = difference - (books[`${kind}moved`] || 0);
        // The system shows what was paid beyond the claim; the books took that excess as profit (decision 119)
        const asProfit = system[kind] < 0 && (books[kind] || 0) >= system[kind] - tolerance && (books[kind] || 0) <= tolerance;
        if (Math.abs(difference) > tolerance && Math.abs(beforeMove) > tolerance && !asProfit) {
          items.push({ label: `${order.orderId} · ${kind === 'PUR' ? 'فاتورة شراء' : 'شحن'}`, usd: difference, note: `الدفاتر ${(books[kind] || 0) / 100}$ · المنظومة ${system[kind] / 100}$`, url: `/invoice/${order._id}/edit` });
        }
      });
    });
    items.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
    return result('claimsVsSystem', 'warn', title, 'السبب المعتاد: دفعة بالدينار بلا سعر، أو دين مرتبط بالطلب دُفع معه، أو تعديل على الطلب لم يُرحَّل.', items);
  },

  // An unsure (unconfirmed) order the customer paid on: billed like any order, but to be fixed
  async unsurePaid() {
    const roles = await roleIds(['customer_receivable']);
    const orders = await Order.find({ unsureOrder: true }).select('orderId').lean();
    if (!orders.length) return result('unsurePaid', 'warn', 'طلب غير مؤكد عليه دفعات', '', []);
    const paid = await JournalEntry.aggregate([
      { $match: { 'lines.orderId': { $in: orders.map((o) => o._id) }, eventType: { $in: ['WALLET_PAYMENT', 'CASH_PAYMENT', 'CANCEL', 'SETTLEMENT_CANCEL', 'REFUND'] } } }, { $unwind: '$lines' },
      { $match: { 'lines.orderId': { $in: orders.map((o) => o._id) }, 'lines.accountId': oid(roles.customer_receivable) } },
      { $group: { _id: '$lines.orderId', usd: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
      { $match: { usd: { $gt: 0 } } },
    ]);
    const numbers = new Map(orders.map((o) => [String(o._id), o.orderId]));
    const items = paid.map((row) => ({ label: numbers.get(String(row._id)), usd: row.usd, url: `/invoice/${row._id}/edit` }));
    return result('unsurePaid', 'warn', 'طلب غير مؤكد عليه دفعات', 'دُفع على طلب لم يُؤكَّد. لا يُحسب إيراداً؛ المبلغ يبقى رصيداً للعميل على الطلب حتى يُؤكَّد الطلب أو تُصحَّح الدفعة.', items);
  },

  // Goods that reached Libya and were not collected for too long (spec v8)
  async abandonedGoods() {
    const { abandonAfterDays, results } = await require('../abandoned').abandonedList();
    const items = results.filter((r) => r.status === 'waiting').map((r) => ({ label: `${r.orderNumber} · ${r.tracking || 'طرد'}`, usd: r.charge, note: `وصل ${r.arrived ? new Date(r.arrived).toISOString().slice(0, 10) : ''}`, url: `/invoice/${r.orderId}/edit` }));
    return result('abandonedGoods', 'info', `بضائع متروكة: وصلت ولم تُستلم منذ أكثر من ${abandonAfterDays} يوماً`, 'تواصل مع العميل. ما لن يُستلم يُعلن متروكاً من صفحة الطلب ← المحاسبة (للمدير والمالك)، ثم يُباع.', items);
  },

  // Bank lines parked as unidentified past their waiting period: the owner decides where they go
  async unidentifiedOverdue() {
    const { results } = await require('../posting/unidentified').list({ state: 'open' });
    const items = results.filter((r) => r.overdue).map((r) => ({ label: `${r.day} · ${r.description || ''}`, usd: Math.round((r.usd || 0) * 100), note: `${r.bank?.name || ''} · مستحق منذ ${r.dueDay}`, url: '/accounting/unidentified' }));
    return result('unidentifiedOverdue', 'warn', 'حركات بنك قيد التحديد تجاوزت مدة الانتظار', 'ابحث مرة أخيرة عن الطلبية أو الرحلة أو صاحب المال؛ وإلا يقرر المالك تصنيفها من «حركات قيد التحديد» بسبب مكتوب.', items);
  },

  // 30. Yuan paid to a broker and not in Alipay after a week
  async yuanPending() {
    const { YuanPurchase } = require('../../models/documents');
    const since = addDays(today(), -7);
    const rows = await YuanPurchase.find({ status: 'posted', arrived: false, day: { $lt: since } }).populate('vendorId', 'name').lean();
    const items = rows.map((p) => ({ label: `${p.number} · ${p.vendorId?.name || ''}`, usd: p.usd, note: `منذ ${p.day} · ${p.cnyExpected} يوان`, url: '/accounting/alipay' }));
    return result('yuanPending', 'warn', 'يوان مدفوع لم يصل منذ أكثر من 7 أيام', 'تابع مع الوسيط، ثم أكّد الوصول بالكمية الفعلية من صفحة Alipay.', items);
  },

  // A delivered package (or a purchase invoice) still unpaid long after: a candidate for writing
  // off (spec 19.7; the number of days is a setting)
  async writeOffCandidates() {
    const { settings } = await getConfig();
    const days = settings.writeOffAfterDays || 180;
    const title = `مسلَّم وغير مسدد أكثر من ${days} يوماً`;
    const roles = await roleIds(['customer_receivable']);
    const open = await JournalEntry.aggregate([
      { $match: { 'lines.accountId': oid(roles.customer_receivable), 'lines.arKey': /^(SHP|PUR):/ } }, { $unwind: '$lines' },
      { $match: { 'lines.accountId': oid(roles.customer_receivable), 'lines.arKey': /^(SHP|PUR):/ } },
      { $group: { _id: '$lines.arKey', usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
      { $match: { usd: { $gt: 0 } } },
    ]);
    if (!open.length) return result('writeOffCandidates', 'info', title, '', []);
    const cutoff = new Date(`${addDays(today(), -days)}T00:00:00Z`);
    const orderIds = [...new Set(open.map((row) => row._id.split(':')[1]))].filter(mongoose.isValidObjectId).map(oid);
    const orders = new Map((await Order.find({ _id: { $in: orderIds }, isCanceled: { $ne: true } })
      .select('orderId createdAt paymentList._id paymentList.status.received paymentList.deliveredPackages.trackingNumber paymentList.deliveredPackages.deliveredInfo.deliveredDate').lean())
      .map((o) => [String(o._id), o]));
    const items = [];
    open.forEach((row) => {
      const [kind, orderId, packageId] = row._id.split(':');
      const order = orders.get(orderId);
      if (!order) return;
      let since = order.createdAt;
      let label = `${order.orderId} · فاتورة شراء`;
      if (kind === 'SHP') {
        const pkg = (order.paymentList || []).find((p) => String(p._id) === packageId);
        if (!pkg?.status?.received) return;
        since = pkg.deliveredPackages?.deliveredInfo?.deliveredDate || order.createdAt;
        label = `${order.orderId} · ${pkg.deliveredPackages?.trackingNumber || 'طرد'}`;
      }
      if (since && new Date(since) < cutoff) items.push({ label, usd: row.usd, note: `منذ ${new Date(since).toISOString().slice(0, 10)}`, arKey: row._id, url: `/accounting/customer-invoices/${orderId}` });
    });
    items.sort((a, b) => b.usd - a.usd);
    return result('writeOffCandidates', 'info', title, 'راجعها مع العميل؛ ما لن يُدفع يُشطب من صفحة الطلب في المحاسبة (المطالبات ← شطب). الشطب يُبقي الإيراد بقدر ما دُفع ويُحمِّل التكلفة كاملة.', items);
  },

  // 19. Entry numbers have no gaps
  async numbering() {
    const rows = await JournalEntry.aggregate([{ $project: { number: 1 } }]);
    const series = new Map();
    rows.forEach(({ number }) => {
      const parts = String(number).split('/');
      const seq = Number(parts.pop());
      const key = parts.join('/');
      const item = series.get(key) || { count: 0, max: 0 };
      item.count++;
      item.max = Math.max(item.max, seq || 0);
      series.set(key, item);
    });
    const items = [...series.entries()].filter(([, s]) => s.count !== s.max).map(([key, s]) => ({ label: `${key}: ${s.max - s.count} رقماً مفقوداً` }));
    return result('numbering', 'warn', 'أرقام قيود مفقودة في التسلسل', 'يحدث بعد إلغاء تشغيل ترحيل تاريخي أو تدخل مباشر في قاعدة البيانات.', items);
  },
};

// Runs every check; one that fails is reported as such and the others still run
async function runChecks({ only } = {}) {
  await loadReviewed();
  const results = [];
  for (const [key, check] of Object.entries(CHECKS)) {
    if (only && !only.includes(key)) continue;
    try {
      results.push(await check());
    } catch (error) {
      results.push({ key, severity: 'error', title: `تعذّر تنفيذ الفحص (${key})`, hint: error.message, count: 1, items: [] });
    }
  }
  const found = results.filter((r) => r.count > 0);
  return {
    day: today(), ranAt: new Date(), results,
    errorCount: found.filter((r) => r.severity === 'error').length,
    warningCount: found.filter((r) => r.severity === 'warn').length,
  };
}

// The daily run is kept, so the dashboard shows the last result without recomputing it
async function runAndStore() {
  const report = await runChecks();
  await Reconciliation.updateOne({ day: report.day }, { $set: report }, { upsert: true });
  return report;
}

// A report stored before items carried their ref gets it here, so they can still be marked
const latest = async () => {
  const report = await Reconciliation.findOne({}).sort({ day: -1 }).lean();
  (report?.results || []).forEach((r) => (r.items || []).forEach((item) => { if (!item.ref) item.ref = refOf(item); }));
  return report;
};

// Runs one check again and puts its result in the latest stored report (after a mark is added or
// taken back), so the list changes at once without running every check
async function refreshCheck(key) {
  const report = await latest();
  if (!report || !CHECKS[key]) return runAndStore();
  const fresh = (await runChecks({ only: [key] })).results[0];
  const results = report.results.map((r) => (r.key === key ? fresh : r));
  const found = results.filter((r) => r.count > 0);
  const patch = { results, errorCount: found.filter((r) => r.severity === 'error').length, warningCount: found.filter((r) => r.severity === 'warn').length };
  await Reconciliation.updateOne({ _id: report._id }, { $set: patch });
  return { ...report, ...patch };
}

async function markReviewed({ check, ref, label, note }, user) {
  if (!CHECKS[check]) throw Object.assign(new Error('فحص غير معروف'), { statusCode: 400 });
  if (!ref) throw Object.assign(new Error('البند غير محدد'), { statusCode: 400 });
  await ReviewedItem.updateOne({ check, ref }, { $set: { label: label || ref, note: note || '', by: user?._id } }, { upsert: true });
  return refreshCheck(check);
}

async function unmarkReviewed(id) {
  const item = await ReviewedItem.findByIdAndDelete(id).lean();
  if (!item) throw Object.assign(new Error('البند غير موجود'), { statusCode: 404 });
  return refreshCheck(item.check);
}

const listReviewed = () => ReviewedItem.find({}).sort({ createdAt: -1 }).populate('by', 'firstName lastName').lean();

module.exports = { runChecks, runAndStore, latest, CHECKS, markReviewed, unmarkReviewed, listReviewed };
