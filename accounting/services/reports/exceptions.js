// Daily reconciliation (spec 10): things that must always hold between the ledger and the
// system, and situations the accountant should look at. Each check returns what it found; none
// of them changes anything.
const mongoose = require('mongoose');
const { JournalEntry, AccountingEvent, Reconciliation } = require('../../models');
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
const result = (key, severity, title, hint, items, link) => ({ key, severity, title, hint, count: items.length, items: items.slice(0, SAMPLE), link });

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
      const system = new Map(wallets.map((w) => [String(w.user), Math.round(Math.max(0, Number(w.balance) || 0) * 10 ** decimals)]));
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
      if (t.foreign < 0 || (!foreign && t.closingUsd < 0)) items.push({ ...base, note: 'الرصيد سالب' });
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
    const items = claims.filter((c) => c.open < 0 && c.arKey).map((c) => ({ label: `${c.orderNumber || c.arKey}${c.tracking ? ` · ${c.tracking}` : ''}`, usd: c.open, url: c.orderId ? `/invoice/${c.orderId}/edit` : null }));
    return result('overpaid', 'warn', 'مطالبة دُفع عليها أكثر من قيمتها', 'دفعة مكررة، أو سعر خُفّض بعد الدفع. الزائد يُعاد للعميل أو يُوجَّه لمطالبة أخرى.', items, '/accounting/reports?tab=receivables');
  },

  // 11 + 7. Purchase orders sold with no cost, and costs stuck on cancelled orders
  async purchases() {
    const { results } = await purchaseProfitability({});
    const items = [
      ...results.filter((r) => r.withoutCost).map((r) => ({ label: `${r.orderNumber} · بلا تكلفة`, usd: r.revenue, url: `/invoice/${r.orderId}/edit` })),
      ...results.filter((r) => r.stuckCost).map((r) => ({ label: `${r.orderNumber} · طلب ملغى عليه تكلفة قيد التنفيذ`, usd: r.costInProgress, url: `/invoice/${r.orderId}/edit` })),
    ];
    return result('purchases', 'warn', 'فاتورة شراء مسددة بلا تكلفة، أو تكلفة على طلب ملغى', 'ربح 100% يعني غالباً فاتورة مورد لم تُدخل. تكلفة الطلب الملغى تُحمَّل خسارة أو تُنقل.', items, '/accounting/reports?tab=purchases');
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
        { $match: { 'source.model': 'UserStatement', status: 'posted', reversalOf: null } },
        { $group: { _id: '$source.id', count: { $sum: 1 } } },
      ]),
      JournalEntry.countDocuments({ 'source.model': 'Invoice' }),
    ]);
    const counts = new Map(posted.map((row) => [String(row._id), row.count]));
    const items = statements.filter((s) => (counts.get(String(s._id)) || 0) !== 1).map((s) => ({
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
      { $group: { _id: { orderId: '$lines.orderId', kind: { $substrCP: ['$lines.arKey', 0, 3] } }, open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]);
    const byOrder = new Map();
    ledger.forEach((row) => {
      const entry = byOrder.get(String(row._id.orderId)) || { PUR: 0, SHP: 0 };
      entry[row._id.kind] = (entry[row._id.kind] || 0) + row.open;
      byOrder.set(String(row._id.orderId), entry);
    });
    const ids = [...byOrder.keys()].filter(mongoose.isValidObjectId).map(oid);
    const [orders, payments] = await Promise.all([
      Order.find({ _id: { $in: ids }, isCanceled: { $ne: true } }).select('orderId isPayment totalInvoice paymentList.deliveredPackages.weight paymentList.deliveredPackages.exiosPrice').lean(),
      OrderPaymentHistory.find({ order: { $in: ids } }).select('order category currency receivedAmount rate').lean(),
    ]);
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
      const system = {
        PUR: order.isPayment ? Math.round(Number(order.totalInvoice || 0) * 100) - (paid.get(`${order._id}|PUR`) || 0) : 0,
        SHP: (order.paymentList || []).reduce((sum, pkg) => sum + Math.round(Number(pkg.deliveredPackages?.weight?.total || 0) * Number(pkg.deliveredPackages?.exiosPrice || 0) * 100), 0)
          - (paid.get(`${order._id}|SHP`) || 0),
      };
      ['PUR', 'SHP'].forEach((kind) => {
        const difference = (books[kind] || 0) - system[kind];
        if (Math.abs(difference) > tolerance) {
          items.push({ label: `${order.orderId} · ${kind === 'PUR' ? 'فاتورة شراء' : 'شحن'}`, usd: difference, note: `الدفاتر ${(books[kind] || 0) / 100}$ · المنظومة ${system[kind] / 100}$`, url: `/invoice/${order._id}/edit` });
        }
      });
    });
    items.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
    return result('claimsVsSystem', 'warn', title, 'السبب المعتاد: دفعة بالدينار بلا سعر، أو دين مرتبط بالطلب دُفع معه، أو تعديل على الطلب لم يُرحَّل.', items);
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

const latest = () => Reconciliation.findOne({}).sort({ day: -1 }).lean();

module.exports = { runChecks, runAndStore, latest, CHECKS };
