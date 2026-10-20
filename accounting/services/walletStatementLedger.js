// Only undo an identifiable historical wallet adjustment. An unexplained difference is
// never turned into income, cash, or a balancing entry merely to clear an exception.
const mongoose = require('mongoose');
const { Account, Currency, AccountingSettings, AccountingEvent, JournalEntry } = require('../models');
const { roleProblem } = require('./roles');
const { postEntry } = require('./ledger');
const { today, addDays } = require('./dates');
const { getBalance } = require('./carrying');

async function context({ userIds, session } = {}) {
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session || null).lean();
  const currencies = await Currency.find({ code: { $in: ['USD', 'LYD'] } }).session(session || null).lean();
  const roles = settings?.accountRoles || {};
  const accounts = await Account.find({ _id: { $in: ['wallet_usd', 'wallet_lyd', 'migration_suspense', 'opening_balance'].map(role => roles[role]).filter(Boolean) } }).sort({ _id: 1 }).session(session || null).lean();
  const byId = new Map(accounts.map(account => [String(account._id), account]));
  const walletIds = [roles.wallet_usd, roles.wallet_lyd].filter(Boolean).map(id => new mongoose.Types.ObjectId(String(id)));
  const match = { 'lines.accountId': { $in: walletIds }, ...(userIds && { 'lines.partnerId': { $in: userIds.map(id => new mongoose.Types.ObjectId(String(id))) } }) };
  const balances = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' }, { $match: match },
    { $group: { _id: { account: '$lines.accountId', partner: '$lines.partnerId' },
      foreign: { $sum: '$lines.amountCurrency' }, usd: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
      count: { $sum: 1 }, lastUpdated: { $max: '$updatedAt' }, lastId: { $max: '$_id' } } },
  ]).session(session || null);
  const originals = await JournalEntry.find({ eventType: 'MIGRATION_ADJUST', eventKey: /^WALLET_ADJUST:/, status: 'posted', ...match }).sort({ _id: 1 }).session(session || null).lean();
  const runs = [...new Set(originals.map(entry => entry.migrationRunId).filter(Boolean))];
  const closures = await JournalEntry.find({ eventKey: { $in: runs.map(run => `SUSPENSE_CLOSE:${run}`) }, status: 'posted' }).session(session || null).lean();
  // A queued wallet operation must post normally before anyone tries to reconcile it.
  const pending = await AccountingEvent.exists({ type: { $in: ['statement', 'statementUpdated', 'statementDeleted', 'paymentRate'] }, status: { $in: ['pending', 'failed'] } }).session(session || null);
  const day = settings?.lockDate && today() <= settings.lockDate ? addDays(settings.lockDate, 1) : today();
  return { settings, roles, byId, currencies: new Map(currencies.map(c => [c.code, c])),
    balances: new Map(balances.map(b => [`${b._id.account}:${b._id.partner}`, b])), originals,
    closures: new Map(closures.map(e => [e.migrationRunId, e])), pending: !!pending, day };
}

function plan(userId, currency, target, ctx) {
  const role = `wallet_${currency.toLowerCase()}`;
  const account = ctx.byId.get(String(ctx.roles[role]));
  const balance = ctx.balances.get(`${account?._id}:${userId}`);
  const ledgerMinor = -(balance?.foreign || 0);
  const ledgerDifference = target - ledgerMinor;
  const entries = ctx.originals.filter(e => e.lines.some(l => String(l.accountId) === String(account?._id) && String(l.partnerId) === String(userId)));
  const corrections = [];
  let undo = 0;
  let problem = !ctx.settings?.liveEnabled ? 'يجب تفعيل الترحيل المحاسبي قبل التسوية المتكاملة' :
    roleProblem(role, account) || (account?.isCash ? 'حساب محافظ العملاء معرّف كحساب نقدي؛ صحح الإعداد قبل التسوية' : '') ||
    (ctx.pending ? 'توجد عمليات محفظة تنتظر الترحيل أو فشلت؛ عالجها ثم حدّث المعاينة' : '');
  if (!problem && ctx.settings?.migrationGuardDay && ctx.day <= ctx.settings.migrationGuardDay) problem = 'توجد فترة محجوزة لترحيل تاريخي قيد المراجعة';
  if (!Number.isSafeInteger(ledgerMinor) || !Number.isSafeInteger(balance?.usd || 0)) problem ||= 'رصيد الدفاتر غير صالح للمعالجة الآلية';
  for (const entry of entries) {
    const wallet = entry.lines.find(l => String(l.accountId) === String(account?._id) && String(l.partnerId) === String(userId));
    const other = entry.lines.find(l => l !== wallet);
    const suspense = ctx.byId.get(String(other?.accountId));
    const closure = ctx.closures.get(entry.migrationRunId);
    const opening = ctx.byId.get(String(ctx.roles.opening_balance));
    const valid = entry.isHistorical && !entry.reversalOf && !entry.reversedBy && entry.lines.length === 2 &&
      entry.source?.model === 'User' && String(entry.source.id) === String(userId) &&
      entry.eventKey === `WALLET_ADJUST:${entry.migrationRunId}:${userId}:${currency}` &&
      String(other?.accountId) === String(ctx.roles.migration_suspense) && !roleProblem('migration_suspense', suspense) && !suspense.isCash &&
      (!suspense.currency || suspense.currency === 'USD') && !suspense.requires?.length &&
      wallet.currency === currency && Number.isSafeInteger(wallet.amountCurrency) && wallet.amountCurrency !== 0 && wallet.debit + wallet.credit > 0 &&
      [wallet.debit, wallet.credit, other?.debit, other?.credit].every(n => Number.isSafeInteger(n) && n >= 0) &&
      wallet.debit + other.debit === wallet.credit + other.credit &&
      (wallet.debit > 0 ? wallet.amountCurrency > 0 && !wallet.credit : wallet.amountCurrency < 0 && !wallet.debit);
    if (!valid) { problem ||= 'قيد تسوية تاريخي غير قابل للعكس تلقائيًا؛ يحتاج مراجعة'; continue; }
    if (closure && (roleProblem('opening_balance', opening) || opening?.isCash || (opening?.currency && opening.currency !== 'USD') || opening?.requires?.length ||
      closure.lines.length !== 2 || !closure.lines.some(l => String(l.accountId) === String(suspense._id)) ||
      !closure.lines.some(l => String(l.accountId) === String(opening?._id)))) {
      problem ||= 'إقفال فروقات الترحيل يحتاج مراجعة قبل عكس تسوية المحفظة'; continue;
    }
    undo += wallet.amountCurrency;
    corrections.push({ entryId: String(entry._id), number: entry.number, day: entry.day,
      foreign: wallet.amountCurrency, usd: wallet.debit - wallet.credit,
      suspenseId: String(suspense._id), closureId: closure ? String(closure._id) : null,
      openingId: closure ? String(opening._id) : null,
      counterpart: closure ? `${opening.code} · ${opening.name}` : `${suspense.code} · ${suspense.name}` });
  }
  if (ledgerDifference && (!corrections.length || undo !== ledgerDifference)) problem ||= 'فرق الدفاتر لا يساوي أثر قيود التسوية التاريخية؛ راجع مصدره قبل المعالجة';
  const used = ledgerDifference ? corrections : [];
  return { ledgerMinor, ledgerDifference, corrections: used, blocked: problem,
    postingDay: ctx.day, mode: ledgerDifference ? 'reverse-historical-adjustment' : 'cache-only',
    signature: { balance, entries: ledgerDifference ? entries : [],
      closures: used.map(p => ctx.closures.get(entries.find(e => String(e._id) === p.entryId)?.migrationRunId)),
      settings: { live: ctx.settings?.liveEnabled, lock: ctx.settings?.lockDate, guard: ctx.settings?.migrationGuardDay, roles: ctx.roles },
      accounts: [...ctx.byId.values()], currency: ctx.currencies.get(currency), day: ctx.day, pending: ctx.pending } };
}

async function apply(row, ctx, { session, user, reason, batchId }) {
  const entries = [];
  for (const correction of row.corrections) {
    const original = ctx.originals.find(e => String(e._id) === correction.entryId);
    const suspenseBefore = correction.closureId ? await getBalance(correction.suspenseId, { session }) : null;
    const reversal = await postEntry({ eventType: 'WALLET_RECONCILIATION', eventKey: `WALLET_CASHFLOW_REVERSE:${original._id}`,
      date: row.postingDay, journalCode: 'GEN', reversalOf: original._id,
      source: { model: 'User', id: row.userId },
      description: `تصحيح محفظة العميل: عكس ${original.number} — ${reason}`,
      notes: [`دفعة التسوية ${batchId}`, 'تصحيح تسوية تاريخية للمحفظة حسب كشف العميل؛ لا يمثل حركة نقدية جديدة'],
      lines: original.lines.map(line => ({ ...line, debit: line.credit, credit: line.debit, amountCurrency: -line.amountCurrency })),
    }, { session, user, onLocked: 'reject' });
    const changed = await JournalEntry.updateOne({ _id: original._id, status: 'posted', reversedBy: { $exists: false } }, { $set: { status: 'reversed', reversedBy: reversal._id } }, { session });
    if (changed.modifiedCount !== 1) throw new Error('Historical wallet adjustment changed; refresh the preview');
    entries.push({ id: reversal._id, number: reversal.number, reverses: original._id });
    if (correction.closureId) {
      // The original suspense was already closed into opening equity. Keep it closed:
      // this transfer cancels only the suspense effect of THIS reversal, not other history.
      const amount = Math.abs(correction.usd);
      const transfer = await postEntry({ eventType: 'WALLET_RECONCILIATION', eventKey: `WALLET_CASHFLOW_CLOSE:${original._id}`,
        date: row.postingDay, journalCode: 'GEN', source: { model: 'User', id: row.userId },
        description: `أثر تصحيح ${original.number} على الرصيد الافتتاحي — ${reason}`,
        notes: [`دفعة التسوية ${batchId}`, `إقفال تاريخي مرجعي ${correction.closureId}`],
        lines: [
          { accountId: correction.suspenseId, debit: correction.usd < 0 ? amount : 0, credit: correction.usd > 0 ? amount : 0 },
          { accountId: correction.openingId, debit: correction.usd > 0 ? amount : 0, credit: correction.usd < 0 ? amount : 0 },
        ],
      }, { session, user, onLocked: 'reject' });
      entries.push({ id: transfer._id, number: transfer.number, closureOf: correction.closureId });
      const suspenseAfter = await getBalance(correction.suspenseId, { session });
      if (suspenseAfter.usd !== suspenseBefore.usd || suspenseAfter.foreign !== suspenseBefore.foreign) {
        throw new Error('Wallet reconciliation must preserve previously closed suspense balances');
      }
    }
  }
  return entries;
}

module.exports = { context, plan, apply };
