// Replay posted yuan movements and correct remittance costs without changing their CNY amounts.
// Deferred until the end of the transaction: bills, payments and cancellations must be complete.
const { JournalEntry } = require('../../models');
const { SupplierPayment, SupplierBill } = require('../../models/documents');
const Order = require('../../../models/order');
const { valueOutflow } = require('../carrying');
const { nextSeq } = require('../counter');
const { logAudit } = require('../audit');
const EVENT = 'ALIPAY_REVALUATION';
const pending = new WeakMap();

function queue(session, accountId, user) {
  const accounts = pending.get(session) || new Map();
  accounts.set(String(accountId), user);
  pending.set(session, accounts);
}
function reset(session) { pending.delete(session); }

async function flush(session) {
  const accounts = pending.get(session);
  reset(session);
  if (!accounts) return;
  for (const [accountId, user] of [...accounts].sort(([a], [b]) => a.localeCompare(b))) {
    await revalue(accountId, { session, user });
  }
}

async function revalue(accountId, { session, user }) {
  const payments = await SupplierPayment.find({ fromAccountId: accountId, currency: 'CNY', isHistorical: { $ne: true }, autoFromBillId: { $ne: null } }).session(session).lean();
  if (!payments.length) return;
  const bills = await SupplierBill.find({ _id: { $in: payments.map(p => p.autoFromBillId) }, isCreditNote: false }).session(session).lean();
  const orders = await Order.find({ _id: { $in: bills.flatMap(b => b.lines.filter(l => l.target === 'order').map(l => l.orderId)) }, isRemittance: true })
    .setOptions({ withDeleted: true }).select('_id placedAt').session(session).lean();
  const orderMap = new Map(orders.map(o => [String(o._id), o]));
  // Only one order's genuine remittance, paid immediately. General bills/refunds remain intact.
  const billMap = new Map(bills.filter(b => !b.isHistorical && !b.migrationRunId && !b.paidBeforeCount && b.lines.length === 1 && b.lines[0].target === 'order' && orderMap.has(String(b.lines[0].orderId)))
    .map(b => [String(b._id), b]));
  const paymentMap = new Map(payments.filter(p => billMap.has(String(p.autoFromBillId))).map(p => [String(p._id), p]));
  if (!paymentMap.size) return;
  const entries = await JournalEntry.find({ 'lines.accountId': accountId }).sort({ day: 1, createdAt: 1, _id: 1 }).session(session).lean();
  const generated = new Set(entries.filter(e => e.eventType === EVENT).map(e => String(e._id)));
  const byId = new Map(entries.map(e => [String(e._id), e]));
  const neutral = new Set();
  for (const entry of entries) {
    const original = byId.get(String(entry.reversalOf));
    if (original && (original.originalDay || original.day) === (entry.originalDay || entry.day)) {
      neutral.add(String(original._id)); neutral.add(String(entry._id));
    }
  }
  const applied = new Map();
  const replay = [];
  for (const entry of entries) {
    const walletLines = entry.lines.filter(l => String(l.accountId) === String(accountId));
    const native = walletLines.reduce((s, l) => s + (l.amountCurrency || 0), 0);
    const usd = walletLines.reduce((s, l) => s + l.debit - l.credit, 0);
    if (entry.eventType === EVENT || generated.has(String(entry.reversalOf))) {
      const key = String(entry.source?.id);
      applied.set(key, (applied.get(key) || 0) - usd);
      continue;
    }
    if (!neutral.has(String(entry._id))) replay.push({ entry, native, usd, day: entry.originalDay || entry.day });
  }
  // No transaction times are captured on legacy documents: use a daily weighted average,
  // receipts before withdrawals on the same day. Never pull a later day's receipt backwards.
  replay.sort((a, b) => a.day.localeCompare(b.day) || (a.native > 0 ? 0 : 1) - (b.native > 0 ? 0 : 1)
    || String(a.entry.createdAt).localeCompare(String(b.entry.createdAt)) || String(a.entry._id).localeCompare(String(b.entry._id)));
  let balance = { foreign: 0, usd: 0 };
  const changes = [];
  const seen = new Set();
  for (const movement of replay) {
    const { entry, native, usd } = movement;
    const key = entry.source?.model === 'AccountingSupplierPayment' ? String(entry.source.id) : '';
    const payment = paymentMap.get(key);
    const bill = payment && billMap.get(String(payment.autoFromBillId));
    let valued = usd;
    if (payment && payment.status === 'posted' && bill.status === 'posted' && entry.status === 'posted' && !entry.reversalOf && native < 0) {
      const carried = valueOutflow(balance, -native);
      // Until a usable balance exists, retain the valid daily rate used by the original payment.
      const cost = carried > 0 ? carried : -usd;
      const desired = cost + usd;
      const provisional = balance.foreign < -native || carried === null;
      changes.push({ payment, bill, entry, desired, cost, provisional, delta: desired - (applied.get(key) || 0) });
      seen.add(key);
      valued = -cost;
    }
    balance = { foreign: balance.foreign + native, usd: balance.usd + valued };
  }
  // A canceled payment's prior corrections are reversed with its source entries. Direct entry
  // reversals also clear any residual adjustment rather than leaving a cost without a payment.
  for (const [key, payment] of paymentMap) {
    if (seen.has(key) || !(applied.get(key))) continue;
    const bill = billMap.get(String(payment.autoFromBillId));
    changes.push({ payment, bill, entry: { day: payment.day }, desired: 0, cost: 0, provisional: false, delta: -(applied.get(key) || 0) });
  }
  const { postEntry } = require('../ledger');
  const { resolveAccount } = require('../roles');
  const { syncOrder } = require('../claims/sync');
  const sync = new Map();
  for (const change of changes) {
    const { payment, bill, entry, desired, cost, provisional, delta } = change;
    const orderId = bill.lines[0].orderId;
    const office = orderMap.get(String(orderId))?.placedAt;
    let correction;
    if (delta) {
      const wip = await resolveAccount('purchase_cost_wip');
      const seq = await nextSeq(`EV:${EVENT}:${payment._id}`, session);
      const label = `تسوية تلقائية لتكلفة حوالة Alipay · ${bill.number}`;
      correction = await postEntry({
        eventType: EVENT, eventKey: `${EVENT}:${payment._id}:${seq}`, date: entry.originalDay || entry.day,
        source: { model: 'AccountingSupplierPayment', id: payment._id }, description: label,
        countRule: 'skip',
        notes: [`إعادة التقييم حسب تاريخ الحركات؛ عند غياب وقت العملية تُجمع إيداعات اليوم قبل سحوباته.`, `القيمة الأصلية ${bill.totalUsd / 100}$؛ فرق التقييم التراكمي ${desired / 100}$. مبلغ اليوان لم يتغير.`],
        lines: [
          { accountId: wip._id, orderId, office, debit: delta > 0 ? delta : 0, credit: delta < 0 ? -delta : 0, label },
          { accountId, currency: 'CNY', amountCurrency: 0, debit: delta < 0 ? -delta : 0, credit: delta > 0 ? delta : 0, label },
        ],
      }, { session, user });
      await logAudit({ user, action: 'alipay.revalue', model: 'AccountingSupplierPayment', docId: payment._id,
        after: { billId: bill._id, orderId, deltaUsd: delta, adjustmentUsd: desired, effectiveUsd: cost, entryId: correction._id, provisional } }, session);
      sync.set(String(orderId), correction.day);
    }
    const metadata = { alipayValuationUsd: cost, alipayValuationAdjustmentUsd: desired, alipayValuationProvisional: provisional,
      ...(correction && { alipayValuationEntryId: correction._id }) };
    const differs = doc => correction || doc.alipayValuationUsd !== cost || doc.alipayValuationAdjustmentUsd !== desired || doc.alipayValuationProvisional !== provisional;
    if (differs(payment)) await SupplierPayment.updateOne({ _id: payment._id }, { $set: metadata }, { session });
    if (differs(bill)) await SupplierBill.updateOne({ _id: bill._id }, { $set: metadata }, { session });
  }
  for (const [orderId, date] of sync) await syncOrder(orderId, { session, user, date });
}

module.exports = { queue, reset, flush, revalue, EVENT };
