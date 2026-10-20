// The suspense account (399000) as a work list: every amount the system could not direct to its
// real account is one item, and the accountant settles items (one or many) by naming the account.
const crypto = require('crypto');
const mongoose = require('mongoose');
const ErrorHandler = require('../../utils/errorHandler');
const { JournalEntry } = require('../models');
const User = require('../../models/user');
const { getConfig } = require('./config');
const { resolveAccount } = require('./roles');
const { getRate } = require('./rates');
const { today, isDay } = require('./dates');
const { createManualEntry } = require('./manualEntry');

const SETTLE_PREFIX = 'SETTLE:';
const fail = (message) => new ErrorHandler(400, message);

// Why the amount is in suspense, in words the accountant can group by
function causeOf(entry) {
  const noted = (entry.fallbacks || []).find((text) => /المعلّق|خزينة/.test(text));
  if (noted) return noted.split('؛')[0];
  if (entry.eventType === 'VENDOR_PAYMENT' || entry.eventType === 'BILL') return 'تكلفة قديمة دُفعت من خزينة غير معروفة';
  if (entry.eventType === 'MIGRATION_ADJUST') return entry.description?.includes('محفظة') ? 'فرق بين رصيد محفظة وتاريخ حركاتها' : 'تسوية ترحيل';
  if (entry.eventType === 'CASH_PAYMENT') return 'دفع نقدي على طلب بلا خزينة محددة';
  return 'أخرى';
}

// Items already settled: a posted settlement entry carries the item id in its key
async function settledIds(session) {
  const entries = await JournalEntry.find({ eventKey: new RegExp(`^MANUAL:${SETTLE_PREFIX}`), status: 'posted' }).select('eventKey').session(session || null).lean();
  return new Set(entries.map((e) => e.eventKey.split(':').slice(2, 4).join(':')));
}

// A wallet correction reverses a historical adjustment and transfers its suspense
// effect back to opening equity. Only a complete, posted, zero-net pair is resolved.
// Unpaired or nonzero corrections remain visible; never hide a whole event type.
async function resolvedWalletCorrections(suspenseId, session) {
  const entries = await JournalEntry.find({ status: 'posted', eventType: 'WALLET_RECONCILIATION',
    eventKey: /^WALLET_CASHFLOW_(REVERSE|CLOSE|CLOSE_FIX):/ }).session(session || null).lean();
  const byKey = new Map(entries.map(entry => [entry.eventKey, entry]));
  const resolved = new Set();
  const net = entry => entry.lines.filter(line => String(line.accountId) === String(suspenseId))
    .reduce((sum, line) => sum + line.debit - line.credit, 0);
  for (const transfer of entries) {
    const match = /^WALLET_CASHFLOW_(?:CLOSE|CLOSE_FIX):([a-f0-9]{24})$/.exec(transfer.eventKey);
    if (!match) continue;
    const reversal = byKey.get(`WALLET_CASHFLOW_REVERSE:${match[1]}`);
    if (!reversal || String(reversal.reversalOf) !== match[1] || transfer.reversalOf ||
      !transfer.source?.id || transfer.source.model !== 'User' || reversal.source?.model !== 'User' ||
      String(transfer.source.id) !== String(reversal.source.id)) continue;
    if (Number.isSafeInteger(net(transfer)) && net(transfer) !== 0 && net(transfer) + net(reversal) === 0) {
      resolved.add(String(transfer._id)); resolved.add(String(reversal._id));
    }
  }
  return resolved;
}

async function resolvedHistoricalBankSettlements(suspenseId, session) {
  const entries = await JournalEntry.find({ status: 'posted', eventType: { $in: ['BANK_HISTORICAL_SETTLEMENT', 'BANK_HISTORICAL_SETTLEMENT_CLOSE'] } })
    .session(session || null).lean();
  const byId = new Map(entries.map(entry => [String(entry._id), entry]));
  const resolved = new Set();
  for (const correction of entries) {
    const match = /^BANK_HISTORICAL_SETTLEMENT_CLOSE:([a-f0-9]{24})$/.exec(correction.eventKey);
    if (!match || correction.reversalOf || correction.lines.length !== 2) continue;
    const original = byId.get(match[1]);
    if (!original || original.eventType !== 'BANK_HISTORICAL_SETTLEMENT' || original.reversalOf ||
      original.source?.model !== 'AccountingBankStatementLine' || correction.source?.model !== 'AccountingBankStatementLine' ||
      !original.source.id || String(original.source.id) !== String(correction.source.id)) continue;
    const net = entry => entry.lines.filter(line => String(line.accountId) === String(suspenseId))
      .reduce((sum, line) => sum + line.debit - line.credit, 0);
    const amount = net(original);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount + net(correction) !== 0) continue;
    const linked = await require('../models/documents').BankStatementLine.exists({ _id: original.source.id,
      entryId: original._id, lineStatus: 'created_entry', historicalSettlementPaymentId: { $ne: null } }).session(session || null);
    if (!linked) continue;
    resolved.add(String(original._id)); resolved.add(String(correction._id));
  }
  return resolved;
}

// Every open item, newest first, with totals per cause
async function listOpen({ cause, search, from, to, limit = 500 } = {}) {
  const suspense = await resolveAccount('migration_suspense');
  const closed = await JournalEntry.findOne({ eventKey: /^SUSPENSE_CLOSE:/, status: 'posted' }).select('migrationRunId').lean();
  const match = {
    'lines.accountId': suspense._id, status: 'posted', reversalOf: { $exists: false },
    eventKey: { $not: /^(MANUAL|CANCEL|SUSPENSE_CLOSE):/ },
    // History folded into the opening balance at migration is no longer open
    ...(closed && { migrationRunId: { $ne: closed.migrationRunId } }),
  };
  if (from || to) match.day = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const entries = await JournalEntry.find(match).select('number day description eventType fallbacks isHistorical lines source').sort({ day: -1, createdAt: -1 }).lean();
  const settled = await settledIds();
  const resolvedWallet = await resolvedWalletCorrections(suspense._id);
  const resolvedHistorical = await resolvedHistoricalBankSettlements(suspense._id);

  const term = String(search || '').trim().toLowerCase();
  const items = [];
  entries.forEach((entry) => entry.lines.forEach((line, lineIndex) => {
    if (resolvedWallet.has(String(entry._id))) return;
    if (resolvedHistorical.has(String(entry._id))) return;
    if (String(line.accountId) !== String(suspense._id)) return;
    const id = `${entry._id}:${lineIndex}`;
    if (settled.has(id)) return;
    const partnerId = entry.lines.find((l) => l.partnerId)?.partnerId;
    // The amount as it was typed, when the operation was in dinars or another currency
    const original = entry.lines.find((l) => l.currency && l.currency !== 'USD' && l.amountCurrency);
    items.push({
      foreign: original ? { amount: Math.abs(original.amountCurrency), currency: original.currency } : null,
      id, entryId: entry._id, number: entry.number, day: entry.day, description: line.label || entry.description, eventType: entry.eventType,
      cause: causeOf(entry), debit: line.debit, credit: line.credit, partnerId, sourceModel: entry.source?.model,
    });
  }));

  const groups = new Map();
  items.forEach((item) => {
    const group = groups.get(item.cause) || { cause: item.cause, count: 0, net: 0 };
    group.count++;
    group.net += item.debit - item.credit;
    groups.set(item.cause, group);
  });

  const filtered = items.filter((item) => (!cause || item.cause === cause)
    && (!term || `${item.number} ${item.description}`.toLowerCase().includes(term)));
  const page = filtered.slice(0, Math.min(Number(limit) || 500, 2000));
  const users = new Map((await User.find({ _id: { $in: page.map((i) => i.partnerId).filter(Boolean) } }).select('firstName lastName customerId').lean()).map((u) => [String(u._id), u]));
  return {
    results: page.map((item) => ({ ...item, partner: users.get(String(item.partnerId)) || null })),
    total: filtered.length,
    net: items.reduce((sum, item) => sum + item.debit - item.credit, 0),
    count: items.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    closedAtMigration: !!closed,
  };
}

// Settles one item: the suspense line is reversed against `accountId`. For customer receivables
// the customer of the original operation is used unless one is given.
async function settleItem(id, { accountId, partnerId, arKey, office, day, note }, { session, req }) {
  const [entryId, index] = String(id).split(':');
  if (!mongoose.isValidObjectId(entryId)) throw fail('بند غير صالح');
  const suspense = await resolveAccount('migration_suspense');
  const entry = await JournalEntry.findById(entryId).session(session).lean();
  const line = entry?.lines?.[Number(index)];
  if (!entry || entry.status !== 'posted' || !line || String(line.accountId) !== String(suspense._id)) throw fail('البند غير موجود في حساب المعلّق');
  if ((await settledIds(session)).has(`${entryId}:${Number(index)}`)) throw fail('البند سُوّي مسبقاً');
  if ((await resolvedWalletCorrections(suspense._id, session)).has(String(entryId))) throw fail('هذا البند عولج تلقائيًا ضمن تسوية المحفظة؛ حدّث القائمة');
  if ((await resolvedHistoricalBankSettlements(suspense._id, session)).has(String(entryId))) throw fail('هذا البند عولج مع إقفال السداد التاريخي؛ حدّث القائمة');

  const { accountsById, currencies } = await getConfig();
  const target = accountsById.get(String(accountId || ''));
  if (!target || target.isGroup) throw fail('اختر الحساب الذي يُوجَّه إليه المبلغ');
  if (String(target._id) === String(suspense._id)) throw fail('اختر حساباً غير حساب المعلّق');

  const date = day === 'original' ? entry.day : (isDay(day) ? day : today());
  const usd = line.debit || line.credit;
  // The suspense line is undone; the target account takes its place
  const side = line.debit ? 'debit' : 'credit';
  let amount = usd / 100;
  let rate;
  if (target.currency && target.currency !== 'USD') {
    const found = await getRate(target.currency, date, { session });
    const decimals = currencies.get(target.currency)?.decimals ?? 2;
    rate = found.rate;
    amount = Number(((usd / 100) * rate).toFixed(decimals));
  }
  const customer = partnerId || entry.lines.find((l) => l.partnerId)?.partnerId;
  return createManualEntry({
    date,
    description: `تسوية معلّق (${entry.number}): ${note || line.label || entry.description || ''}`.trim(),
    idempotencyKey: `${SETTLE_PREFIX}${entryId}:${Number(index)}:${crypto.randomBytes(4).toString('hex')}`,
    lines: [
      { accountId: suspense._id, side: side === 'debit' ? 'credit' : 'debit', amount: usd / 100, label: 'تسوية' },
      {
        accountId: target._id, side, amount, rate, label: note || line.label,
        office: office || target.office || line.office || entry.lines.find((l) => l.office)?.office,
        partnerId: customer ? String(customer) : undefined, arKey: arKey || undefined,
      },
    ],
  }, { session, req });
}

module.exports = { listOpen, settleItem };
