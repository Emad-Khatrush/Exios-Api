const mongoose = require('mongoose');
const Balance = require('../../../models/balance');
const { JournalEntry } = require('../../models');
const { resolveAccount } = require('../roles');
const { postEntry } = require('../ledger');
const { lockClaimAllocations } = require('./locks');

// Recompute collected revenue from the net ledger, including reversals. Deposits into
// a wallet never call this; only settling the service claim releases its revenue.
async function syncServiceDebts(keys, options = {}) {
  const ids = [...new Set(keys.filter(k => String(k).startsWith('GEN:')).map(k => String(k).slice(4)))];
  if (!ids.length) return;
  const { session } = options;
  const balances = await Balance.find({ _id: { $in: ids }, accountingKind: 'service_sale', sourceBalance: null }).session(session).lean();
  for (const balance of balances) {
    const key = `GEN:${balance._id}`;
    await lockClaimAllocations([key], session);
    const original = await JournalEntry.findOne({ eventKey: `GENERAL_DEBT:${balance._id}`, status: 'posted', reversalOf: null }).session(session).lean();
    if (!original) continue;
    const ar = await resolveAccount('customer_receivable');
    const deferred = await resolveAccount('deferred_service_revenue');
    const revenue = await resolveAccount('revenue_services');
    const billed = original.lines.filter(l => String(l.accountId) === String(ar._id)).reduce((s, l) => s + l.debit - l.credit, 0);
    const rows = await JournalEntry.aggregate([
      { $match: { 'lines.arKey': key } }, { $unwind: '$lines' }, { $match: { 'lines.arKey': key } },
      { $group: { _id: '$lines.accountId', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]).session(session || null);
    const net = account => rows.find(r => String(r._id) === String(account._id))?.net || 0;
    const writeOffs = await JournalEntry.find({ eventType: 'DEBT_WRITEOFF', status: 'posted', reversalOf: null, 'lines.arKey': key }).session(session).lean();
    const written = writeOffs.reduce((s, e) => s + e.lines.filter(l => l.arKey === key && String(l.accountId) === String(ar._id)).reduce((n, l) => n + l.credit - l.debit, 0), 0);
    const wanted = Math.max(0, Math.min(billed - written, billed - written - Math.max(net(ar), 0)));
    const delta = wanted + net(revenue);
    if (!delta) continue;
    const version = await JournalEntry.countDocuments({ 'source.model': 'Balance', 'source.id': balance._id, eventType: 'RECOGNITION' }).session(session);
    const office = original.lines.find(l => l.office)?.office;
    const dims = { partnerId: new mongoose.Types.ObjectId(String(balance.owner)), arKey: key, office, label: balance.notes };
    await postEntry({
      eventType: 'RECOGNITION', eventKey: `SERVICE_REVENUE:${balance._id}:${version + 1}`,
      date: options.date || new Date(), description: `إيراد خدمة مسدد: ${balance.notes}`,
      source: { model: 'Balance', id: balance._id }, isHistorical: !!options.isHistorical, migrationRunId: options.migrationRunId,
      lines: delta > 0
        ? [{ accountId: deferred._id, debit: delta, ...dims }, { accountId: revenue._id, credit: delta, ...dims }]
        : [{ accountId: deferred._id, credit: -delta, ...dims }, { accountId: revenue._id, debit: -delta, ...dims }],
    }, { session, user: options.user });
  }
}

module.exports = { syncServiceDebts };
