// Bank lines nobody can explain yet ("لا أعرف بعد"). Parking posts the bank side now against a
// clearing account, so the bank balance and the statement agree, while nothing reaches profit:
// money out waits on "unidentified payments" (an asset), money in on "unidentified receipts" (a
// liability: it may be a customer's), a supplier refund on the existing pending-refunds account.
// After its waiting period (90 days out, a year in) the owner decides where it goes, with a
// reason, by one entry dated on the decision day. Nothing is ever classified automatically.
const { BankStatementLine } = require('../../models/documents');
const { Account, AccountingSettings } = require('../../models');
const { postEntry } = require('../ledger');
const { logAudit } = require('../audit');
const { resolveAccount } = require('../roles');
const { addDays, toDay, today } = require('../dates');
const { fail, currencyOf, moneyLine, RateBook, valueOut, addFxLine } = require('./common');

const HINTS = {
  purchase: 'غالباً مشتريات',
  shipping: 'غالباً شحن أو رحلة',
  refund: 'غالباً ريفاند من مورد',
  customer: 'غالباً إيداع عميل',
  expense: 'غالباً مصروف أو رسوم',
  unknown: 'لا فكرة',
};

// The owner's final choices. `role` is the account the clearing amount moves to.
const DECISIONS = {
  out: {
    unallocated_purchase: { role: 'cost_unallocated_purchase', label: 'تكلفة مشتريات غير موزعة على طلبية' },
    unallocated_shipping: { role: 'cost_unallocated_shipping', label: 'تكلفة شحن غير موزعة على رحلة' },
    unknown_expense: { role: 'unknown_expense', label: 'مصروفات غير معروفة المصدر' },
    bank_claim: { role: 'bank_claims', label: 'مطالبة على البنك (عملية لم تقم بها الشركة)' },
    account: { label: 'حساب آخر: جاري شريك أو قرض' },
  },
  in: {
    unclaimed_revenue: { role: 'revenue_unclaimed', label: 'إيرادات أموال غير مطالب بها' },
    purchase_cost_reduction: { role: 'cost_unallocated_purchase', label: 'تخفيض تكلفة مشتريات غير موزعة (ريفاند مورد)' },
    account: { label: 'حساب آخر: جاري شريك أو قرض' },
  },
};

const directionOf = (line) => (line.amount < 0 ? 'out' : 'in');

// A line parked before this screen existed (a pending supplier refund) is listed the same way
const isPendingRefund = (line) => line.pendingRefund && line.lineStatus === 'created_entry' && !line.customerRefundId;

function stateOf(line) {
  if (line.unidentified?.status === 'decided') return 'decided';
  if (line.customerRefundId || line.unidentified?.status === 'resolved') return 'resolved';
  return 'open';
}

async function waitingDays(direction) {
  const settings = await AccountingSettings.findOne({ key: 'main' }).select('unidentifiedOutDays unidentifiedInDays').lean();
  return direction === 'out' ? settings?.unidentifiedOutDays ?? 90 : settings?.unidentifiedInDays ?? 365;
}

async function park(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  require('./alipayReconciliation').assertWallet(line);
  const hint = input.hint || 'unknown';
  if (!HINTS[hint]) throw fail('اختر ما تظنه عن هذه الحركة');
  const direction = directionOf(line);
  if (direction === 'out' && ['refund', 'customer'].includes(hint)) throw fail('هذه حركة صادرة؛ الريفاند والإيداع حركات واردة');
  if (direction === 'in' && ['purchase', 'shipping', 'expense'].includes(hint)) throw fail('هذه حركة واردة؛ المشتريات والشحن والمصروف حركات صادرة');
  if (!input.confirmNotDuplicate) {
    const twins = await require('./bank').possibleDuplicates(line, session);
    if (twins.length) throw fail(`قد يكون هذا السطر مسجلاً في الدفاتر: ${twins.slice(0, 3).map((t) => `${t.number} (${t.day})`).join('، ')}. طابقه معه بدل تعليقه، أو أكّد أنه مختلف.`);
  }
  const meta = {
    status: 'open', hint, note: String(input.note || '').trim() || undefined,
    assigneeId: input.assigneeId || undefined, parkedAt: new Date(), parkedDay: today(), parkedBy: req?.user?._id,
  };

  // A supplier refund keeps its own account, so the order's refund form can still pick it up
  if (hint === 'refund') {
    await require('./pendingRefund').post(line, { session, req });
    line.unidentified = { ...meta, clearingAccountId: line.pendingRefundAccountId };
    await line.save({ session });
    return line;
  }

  const bank = await Account.findById(line.accountId).session(session).lean();
  if (!bank?.isCash) throw fail('حساب الكشف غير صالح');
  const clearing = await resolveAccount(direction === 'out' ? 'unidentified_payments' : 'unidentified_receipts');
  const rates = new RateBook(session, { nearest: true });
  const minor = Math.abs(line.amount);
  // The dollars the statement prints are the truth (spec 19.13); else the day's rate for money in,
  // and the account's carrying value for money out
  const printed = Number(line.settlementUsd) > 0 ? Math.round(line.settlementUsd * 100)
    : line.originalCurrency === 'USD' && Number(line.originalAmount) > 0 ? Math.round(line.originalAmount * 100) : null;
  const bankUsd = direction === 'out'
    ? await valueOut(bank, minor, { day: line.day, rates })
    : currencyOf(bank) === 'USD' ? minor : printed ?? await rates.toUsd(minor, currencyOf(bank), line.day);
  const usd = currencyOf(bank) === 'USD' ? minor : printed ?? bankUsd;
  const label = `قيد التحديد (${HINTS[hint]}): ${line.description || ''}`.trim();
  const clearingLine = { accountId: clearing._id, [direction === 'out' ? 'debit' : 'credit']: usd, label };
  const lines = direction === 'out'
    ? [clearingLine, moneyLine(bank, 'credit', minor, bankUsd, { label })]
    : [moneyLine(bank, 'debit', minor, bankUsd, { label }), clearingLine];
  // Money out at the statement's dollars and the account's average apart: an exchange difference
  await addFxLine(lines, bank.office);
  const entry = await postEntry({
    eventType: 'BANK_LINE', eventKey: `UNIDENTIFIED:${line._id}:${line.postingAttempt || 0}`, date: line.day,
    description: `حركة قيد التحديد من كشف ${bank.name}: ${line.description || ''}`,
    source: { model: 'AccountingBankStatementLine', id: line._id }, fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  Object.assign(line, { entryId: entry._id, lineStatus: 'created_entry', valuationUsd: usd / 100, unidentified: { ...meta, clearingAccountId: clearing._id } });
  await line.save({ session });
  await logAudit({ req, action: 'bank.park', model: 'AccountingBankStatementLine', docId: line._id, after: { entryId: entry._id, hint, usd } }, session);
  return line;
}

async function list(query = {}) {
  const filter = { $or: [{ 'unidentified.status': { $exists: true } }, { pendingRefund: true, lineStatus: 'created_entry' }] };
  if (query.accountId) filter.accountId = query.accountId;
  const rows = await BankStatementLine.find(filter)
    .populate('accountId', 'code name currency')
    .populate('unidentified.clearingAccountId', 'code name')
    .populate('pendingRefundAccountId', 'code name')
    .populate('unidentified.assigneeId', 'firstName lastName')
    .populate('unidentified.decision.accountId', 'code name')
    .populate('unidentified.decision.entryId', 'number')
    .populate('entryId', 'number')
    .sort({ day: 1 }).lean();
  const days = { out: await waitingDays('out'), in: await waitingDays('in') };
  const now = today();
  const results = rows.map((line) => {
    const direction = directionOf(line);
    const parkedDay = line.unidentified?.parkedDay || toDay(line.updatedAt || line.createdAt);
    const dueDay = addDays(parkedDay, days[direction]);
    const age = Math.round((Date.parse(now) - Date.parse(line.day)) / 86400000);
    return {
      _id: line._id, day: line.day, description: line.description, reference: line.reference, amount: line.amount,
      bank: line.accountId, direction, usd: line.valuationUsd, state: stateOf(line),
      hint: line.unidentified?.hint || (line.pendingRefund || line.customerRefundId ? 'refund' : 'unknown'),
      note: line.unidentified?.note, assignee: line.unidentified?.assigneeId, parkedDay, dueDay, age,
      overdue: stateOf(line) === 'open' && now >= dueDay,
      clearingAccount: line.unidentified?.clearingAccountId || line.pendingRefundAccountId, entry: line.entryId, decision: line.unidentified?.decision,
    };
  }).filter((row) => (!query.state || row.state === query.state) && (!query.direction || row.direction === query.direction));
  const open = results.filter((row) => row.state === 'open');
  return {
    results,
    summary: {
      openOut: open.filter((r) => r.direction === 'out').reduce((s, r) => s + Math.round((r.usd || 0) * 100), 0),
      openIn: open.filter((r) => r.direction === 'in').reduce((s, r) => s + Math.round((r.usd || 0) * 100), 0),
      overdue: open.filter((r) => r.overdue).length,
      count: open.length,
    },
    waitingDays: days,
    hints: HINTS,
    decisions: Object.fromEntries(Object.entries(DECISIONS).map(([dir, map]) => [dir, Object.entries(map).map(([kind, d]) => ({ kind, label: d.label }))])),
  };
}

// The owner's final decision: one entry moving the clearing amount to where it now belongs
async function decide(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || !(line.unidentified?.status === 'open' || isPendingRefund(line))) throw fail('هذه الحركة ليست قيد التحديد');
  if (line.lineStatus !== 'created_entry' || line.customerRefundId) throw fail('رُبطت هذه الحركة بعملية؛ لا تحتاج قراراً');
  const reason = String(input.reason || '').trim();
  if (!reason) throw fail('سبب القرار مطلوب');
  const direction = directionOf(line);
  const choice = DECISIONS[direction][input.kind];
  if (!choice) throw fail('اختر التصنيف المناسب لاتجاه الحركة');
  const clearingId = line.unidentified?.clearingAccountId || line.pendingRefundAccountId;
  const clearing = clearingId && await Account.findById(clearingId).session(session).lean();
  if (!clearing) throw fail('حساب التعليق غير موجود');
  let target;
  if (input.kind === 'account') {
    target = await Account.findById(input.accountId).session(session).lean();
    if (!target || target.isGroup || !target.isActive) throw fail('اختر حساباً تفصيلياً نشطاً');
    if (target.isCash) throw fail('هذا حساب نقدي؛ إن كانت الحركة تحويلاً بين حسابات الشركة فألغِ التعليق وطابقها مع التحويل');
    if (String(target._id) === String(clearing._id)) throw fail('اختر حساباً غير حساب التعليق');
    if ((target.requires || []).some((dim) => dim !== 'office')) throw fail('هذا الحساب يحتاج طلبية أو رحلة أو عميلاً أو موظفاً؛ ألغِ التعليق واربط الحركة من مراجعة الكشف');
  } else {
    target = await resolveAccount(choice.role);
  }
  const usd = Math.round(Number(line.valuationUsd) * 100);
  if (!(usd > 0)) throw fail('قيمة الحركة بالدولار غير معروفة');
  const bank = await Account.findById(line.accountId).session(session).lean();
  const office = bank?.office || undefined;
  const day = today();
  const label = `${choice.label}: ${line.description || ''}`.trim();
  const targetLine = { accountId: target._id, [direction === 'out' ? 'debit' : 'credit']: usd, label, ...(office && { office }) };
  const clearingLine = { accountId: clearing._id, [direction === 'out' ? 'credit' : 'debit']: usd, label: 'إقفال التعليق بقرار المالك' };
  const entry = await postEntry({
    eventType: 'UNIDENTIFIED_DECISION', eventKey: `UNIDENTIFIED_DECISION:${line._id}:${line.postingAttempt || 0}`, date: day,
    description: `قرار نهائي لحركة قيد التحديد بتاريخ ${line.day} (${bank?.name || ''}): ${reason}`,
    source: { model: 'AccountingBankStatementLine', id: line._id },
    lines: direction === 'out' ? [targetLine, clearingLine] : [clearingLine, targetLine],
  }, { session, user: req?.user });
  const meta = line.unidentified?.status ? line.toObject().unidentified :{ hint: 'refund', parkedDay: toDay(line.updatedAt || line.createdAt), clearingAccountId: clearing._id };
  line.unidentified = { ...meta, status: 'decided',
    decision: { kind: input.kind, accountId: target._id, reason, day, entryId: entry._id, decidedBy: req?.user?._id, decidedAt: new Date() } };
  // A decided refund is no longer offered to an order's refund form
  line.pendingRefund = false;
  await line.save({ session });
  await logAudit({ req, action: 'bank.unidentifiedDecision', model: 'AccountingBankStatementLine', docId: line._id, after: { kind: input.kind, accountId: target._id, reason, entryId: entry._id } }, session);
  return line;
}

module.exports = { park, list, decide, HINTS, DECISIONS };
