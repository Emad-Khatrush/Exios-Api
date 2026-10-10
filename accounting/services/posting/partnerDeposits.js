// A partner's current account the company holds money in (Wasl): money the partner credits us on
// its statement is the customer deposit we typed in that partner's wallet. Old deposits were often
// typed days apart or on an office box, so they are proposed by AMOUNT first (within TOLERANCE,
// WINDOW days, the nearest first), and one recorded on a box is moved to the current account and
// matched in one step. A person may also pick one or several deposits whose total is the line.
// A line dated before the count is already in the counted balance: it is only tied to its deposits
// for the record (no entry). Nothing is matched without the person's approval.
const { BankStatementLine } = require('../../models/documents');
const { Account, JournalEntry } = require('../../models');
const UserStatement = require('../../../models/userStatement');
const { postEntry } = require('../ledger');
const { resolveAccount } = require('../roles');
const { addDays, toDay } = require('../dates');
const { logAudit } = require('../audit');
const { fail, moneyLine } = require('./common');

const WINDOW = 60;
// Owner's tolerance (2026-10-09): a deposit up to 1$ off the partner's line is the same operation;
// the difference goes to rounding differences
const TOLERANCE = 100;
// Lines a deposit edit must not touch (written by Accounting, or a payment given back)
const PAYMENT_RETURN = /الغاء عملية الدفع كود|واسترجاع قيمة شحن\s+.+?\s+إلى المحفظة/;
const movable = (s) => !s.accountingSource?.model && !['cancellation', 'wallet', 'refund', 'compensation', 'withdrawal'].includes(s.actionType)
  && !(!s.actionType && PAYMENT_RETURN.test(String(s.description || '')));
const daysApart = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);
const customerName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.customerId || '';
const cents = (amount) => Math.round(Number(amount) * 100);

// Only an asset current account (money a partner holds for us), not a card or a payable
const partnerAccount = async (accountId, session) => {
  const account = await Account.findById(accountId).session(session || null).lean();
  return account?.isCash && account.cashKind === 'current' && account.type === 'asset' ? account : null;
};

// Every deposit of the partner that could be behind each unmatched incoming line, any amount
async function candidates(accountId, { session, lineIds } = {}) {
  const account = await partnerAccount(accountId, session);
  if (!account) return { account: null, result: {} };
  const lines = await BankStatementLine.find({ accountId: account._id, lineStatus: 'unmatched', amount: { $gt: 0 }, ...(lineIds && { _id: { $in: lineIds } }) })
    .session(session || null).lean();
  // The partner is the customer whose deposits were made into this account
  const customers = lines.length ? await UserStatement.distinct('user', { accountId: account._id }).session(session || null) : [];
  if (!customers.length) return { account, result: {} };
  const { count } = await require('../config').getConfig();
  const beforeCount = (day) => !!count && (day < count.day || (day === count.day && count.endOfDay));
  // Deposits already tied to a line of the count period
  const covered = new Set((await BankStatementLine.distinct('partnerStatementIds', { accountId: account._id }).session(session || null)).map(String));
  const days = lines.map((l) => l.day).sort();
  const statements = await UserStatement.find({ user: { $in: customers }, calculationType: '+', currency: account.currency || 'USD',
    createdAt: { $gte: new Date(`${addDays(days[0], -WINDOW)}T00:00:00Z`), $lte: new Date(`${addDays(days[days.length - 1], WINDOW + 1)}T00:00:00Z`) } })
    .populate('user', 'firstName lastName customerId').populate('accountId', 'code name').session(session || null).lean();
  const usable = statements.filter(movable);
  // The live entry of each deposit, and whether a statement line already took it
  const entries = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': { $in: usable.map((s) => s._id) }, status: 'posted' })
    .select('number source lines.accountId').session(session || null).lean();
  const taken = new Set((await BankStatementLine.find({ matchedEntryIds: { $in: entries.map((e) => e._id) } }).select('matchedEntryIds').session(session || null).lean())
    .flatMap((l) => l.matchedEntryIds.map(String)));
  const entryOf = new Map(entries.map((e) => [String(e.source.id), e]));
  const result = {};
  for (const line of lines) {
    const found = [];
    const lineCovered = beforeCount(line.day);
    for (const s of usable) {
      const day = toDay(s.createdAt);
      const apart = daysApart(day, line.day);
      if (apart > WINDOW) continue;
      const base = { statementId: s._id, customer: customerName(s.user), day, amount: s.amount, daysApart: apart,
        difference: line.amount - cents(s.amount), recordedOn: s.accountId?.name || s.office || null, description: s.description, note: s.note };
      // A line of the count period: tied to its deposit for the record only
      if (lineCovered) {
        if (!covered.has(String(s._id))) found.push({ ...base, beforeCount: true, onAccount: false });
        continue;
      }
      // A live line needs a live deposit: one before the count went to the counted balance
      if (beforeCount(day)) continue;
      const entry = entryOf.get(String(s._id));
      if (!entry || taken.has(String(entry._id))) continue;
      const onAccount = entry.lines.some((l) => String(l.accountId) === String(account._id));
      found.push({ ...base, entryId: entry._id, entryNumber: entry.number, onAccount });
    }
    result[line._id] = found;
  }
  return { account, result };
}

const nearest = (a, b) => Math.abs(a.difference) - Math.abs(b.difference) || a.daysApart - b.daysApart || Number(b.onAccount) - Number(a.onAccount);

// Proposals: the deposits within 1$ of each line, the closest amount then the nearest date first
async function suggestions(accountId, options = {}) {
  const { result } = await candidates(accountId, options);
  return Object.fromEntries(Object.entries(result)
    .map(([lineId, found]) => [lineId, found.filter((c) => Math.abs(c.difference) <= TOLERANCE).sort(nearest)])
    .filter(([, found]) => found.length));
}

// For picking by hand: every deposit of the partner within the window, the closest amount first
async function options(lineId) {
  const line = await BankStatementLine.findById(lineId).lean();
  if (!line) throw fail('سطر الكشف غير موجود');
  const { result } = await candidates(line.accountId, { lineIds: [line._id] });
  return { results: (result[line._id] || []).sort(nearest), tolerance: TOLERANCE / 100 };
}

// Moves a deposit recorded on a box to the current account (re-posted at once); its new entry
async function moveToAccount(statementId, account, { session, req }) {
  const statement = await UserStatement.findById(statementId).session(session);
  await require('../periodGuard').assertOpenPeriod(req?.user, statement.createdAt, { session });
  const before = { accountId: statement.accountId, actionType: statement.actionType, office: statement.office };
  statement.accountId = account._id;
  if (!['cash', 'bank'].includes(statement.actionType)) statement.actionType = 'bank';
  if (account.office) statement.office = account.office;
  statement.editHistory.push({ editedBy: req?.user?._id, editedAt: new Date(), before });
  await statement.save({ session });
  // Re-posted now (old entry reversed, new one on the current account), as an edit from the wallet
  const event = await require('../events').emitAccountingEvent('statementUpdated', statement._id, {}, req?.user, { session });
  const result = await require('./operations').repostStatement(statement._id, { session, user: req?.user });
  if (event) Object.assign(event, { status: result?.skipped ? 'skipped' : 'done', result, processedAt: new Date() });
  if (event) await event.save({ session });
  const posted = await JournalEntry.findOne({ 'source.model': 'UserStatement', 'source.id': statement._id, status: 'posted', 'lines.accountId': account._id })
    .sort({ createdAt: -1 }).session(session).lean();
  if (!posted) throw fail('تعذّر تسجيل الإيداع على الحساب الجاري');
  return posted._id;
}

// Approve: one or several deposits for the line. Each one on a box is moved to the current account,
// a difference up to 1$ is booked to rounding, and the line is matched with all of them.
async function apply(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  const ids = [...new Set((input.statementIds || [input.statementId]).filter(Boolean).map(String))];
  if (!ids.length) throw fail('اختر الإيداع');
  const { account, result } = await candidates(line.accountId, { session, lineIds: [line._id] });
  const chosen = ids.map((id) => (result[line._id] || []).find((c) => String(c.statementId) === id));
  if (!account || chosen.some((c) => !c)) throw fail('بعض الإيداعات المختارة لم تعد متاحة لهذا السطر؛ حدّث الصفحة');
  const difference = line.amount - chosen.reduce((sum, c) => sum + cents(c.amount), 0);
  if (Math.abs(difference) > TOLERANCE) throw fail(`مجموع الإيداعات يختلف عن السطر بـ ${(difference / 100).toFixed(2)}؛ الحد المسموح 1$`);
  if (difference && (account.currency || 'USD') !== 'USD') throw fail('الفرق مسموح لحساب جارٍ بالدولار فقط؛ اختر إيداعات مجموعها يساوي السطر');
  const far = Math.max(...chosen.map((c) => c.daysApart));
  if ((far > 3 || difference) && !input.confirmDifference) {
    throw fail(`${far > 3 ? `فرق التاريخ ${far} يوماً` : ''}${far > 3 && difference ? ' و' : ''}${difference ? `فرق المبلغ ${(difference / 100).toFixed(2)}$` : ''}؛ راجع وأكد أنها نفس العملية`);
  }

  if (chosen[0].beforeCount) {
    // In the counted balance already: no entry, the line only records which deposits it was
    await BankStatementLine.updateOne({ _id: line._id, lineStatus: 'unmatched' }, { $set: { lineStatus: 'ignored', partnerStatementIds: ids } }, { session });
    await logAudit({ req, action: 'bank.partnerDepositCovered', model: 'AccountingBankStatementLine', docId: line._id,
      after: { statementIds: ids, difference, reason: 'قبل الجرد: الرصيد شمله' } }, session);
    return BankStatementLine.findById(line._id).session(session).lean();
  }

  const entryIds = [];
  for (const c of chosen) entryIds.push(c.onAccount ? c.entryId : await moveToAccount(c.statementId, account, { session, req }));
  if (difference) {
    // What the partner credited differs from the deposits by cents: the account follows the partner's statement
    const rounding = await resolveAccount('rounding');
    const amount = Math.abs(difference);
    const label = `فرق إيداع ${account.name}: ${(difference / 100).toFixed(2)}$`;
    const entry = await postEntry({
      eventType: 'BANK_LINE', eventKey: `PARTNER_DIFF:${line._id}:${line.postingAttempt || 0}`, date: line.day, description: `${label} (${line.description || ''})`,
      source: { model: 'AccountingBankStatementLine', id: line._id },
      lines: difference > 0
        ? [moneyLine(account, 'debit', amount, amount, { label }), { accountId: rounding._id, credit: amount, label, ...(account.office && { office: account.office }) }]
        : [{ accountId: rounding._id, debit: amount, label, ...(account.office && { office: account.office }) }, moneyLine(account, 'credit', amount, amount, { label })],
    }, { session, user: req?.user });
    entryIds.push(entry._id);
  }
  const matched = await require('./bank').manualMatch(line._id, entryIds, { session, req });
  await logAudit({ req, action: 'bank.partnerDepositMatch', model: 'AccountingBankStatementLine', docId: line._id,
    after: { statementIds: ids, moved: chosen.filter((c) => !c.onAccount).length, difference, daysApart: far } }, session);
  return matched;
}

module.exports = { suggestions, options, apply, WINDOW, TOLERANCE };
