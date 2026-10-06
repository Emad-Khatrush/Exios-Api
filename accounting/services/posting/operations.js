// The system's own money movements (spec E1-E5, E8-E10, debts): customer wallet statements,
// cash payments on orders, and customer debts (Balance).
const mongoose = require('mongoose');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const Order = require('../../../models/order');
const Balance = require('../../../models/balance');
const User = require('../../../models/user');
const { JournalEntry, AccountingEvent } = require('../../models');
const { postEntry, reverseEntry } = require('../ledger');
const { lockClaimAllocations } = require('../claims/locks');
const { getConfig } = require('../config');
const { walletRole, resolveCashAccount, resolveStaffCashAccount } = require('../roles');
const { reverseSourceEntries } = require('../cancel');
const { syncOrder } = require('../claims/sync');
const { purchaseKey, shipmentKey, generalDebtKey, PACKAGE_FEES } = require('../claims/keys');
const { fail, toCurrencyMinor, RateBook, valueOut, moneyLine, addFxLine, resolveAccount, getAccount, lockPostingAccounts, isBeforeCashCount } = require('./common');const { roundHalfAway } = require('../money');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const CURRENCY_ALIASES = { EURO: 'EUR' };

// Open (still owed) balance per claim key
async function openBalances(keys, session) {
  if (!keys.length) return new Map();
  const receivable = await resolveAccount('customer_receivable');
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.arKey': { $in: keys } } },
    { $unwind: '$lines' },
    { $match: { 'lines.arKey': { $in: keys }, 'lines.accountId': receivable._id } },
    { $group: { _id: '$lines.arKey', open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]).session(session || null);
  return new Map(rows.map((row) => [row._id, row.open]));
}

// Which claims a payment pays. `target` comes from the screen that made the payment:
// { orderId, category: 'invoice' | 'receivedGoods', packageIds, balanceId, arKeys }
async function resolveClaimKeys(target, session) {
  // null = the payment could not be linked to any order or debt (old statements in the replay)
  target = target || {};
  if (target.arKeys?.length) return target.arKeys;
  if (target.balanceId) {
    const balance = await Balance.findById(target.balanceId).session(session).lean();
    if (balance && (!balance.order || balance.debtType === 'general')) return [generalDebtKey(balance._id)];
    if (balance?.order) target = { ...target, orderId: balance.order, category: target.category || balance.debtType };
  }
  if (!target.orderId) return [];
  const order = await Order.findById(target.orderId).select('paymentList._id paymentList.deliveredPackages.domesticFee paymentList.deliveredPackages.customsFee isPayment').session(session).lean();
  if (!order) return [];
  if (target.category === 'invoice' || (!target.category && !target.packageIds?.length && order.isPayment)) return [purchaseKey(order._id)];
  const packageIds = target.packageIds?.length ? target.packageIds : (order.paymentList || []).map((p) => p._id);
  // A package with fees (transport, customs clearance) is paid for all: its shipping, then its fees
  const byId = new Map((order.paymentList || []).map((p) => [String(p._id), p]));
  const feeKeys = (id) => PACKAGE_FEES.filter(({ field }) => Number(byId.get(String(id))?.deliveredPackages?.[field]?.usd) > 0).map(({ key }) => key(order._id, id));
  const keys = packageIds.flatMap((id) => [shipmentKey(order._id, id), ...feeKeys(id)]);
  if (target.packageIds?.length) return keys;
  // "received goods" without packages: the ones still owed, oldest first
  const open = await openBalances(keys, session);
  const owed = keys.filter((key) => (open.get(key) || 0) > 0);
  return owed.length ? owed : keys.slice(0, 1);
}

// Splits `usd` over the claims by what is still owed on each; anything beyond goes to the last
// one (an overpayment, shown in the exceptions report)
async function splitOverClaims(keys, usd, session) {
  const open = await openBalances(keys, session);
  let rest = usd;
  const parts = keys.map((key, index) => {
    const take = index === keys.length - 1 ? rest : Math.min(rest, Math.max(open.get(key) || 0, 0));
    rest -= take;
    return { key, usd: take };
  });
  return parts.filter((part) => part.usd > 0);
}

function claimLines(parts, side, partnerId) {
  return parts.map(({ key, usd }) => {
    const [, orderId, packageId] = key.split(':');
    return {
      accountId: null, // filled by the caller
      [side]: usd,
      partnerId,
      arKey: key,
      ...(key.startsWith('GEN:') ? {} : { orderId: oid(orderId) }),
      ...(packageId && { packageId: oid(packageId) }),
    };
  });
}

// A payment beyond what is owed on an order is the company's profit, not the customer's credit
// (owner's decision 2026-10-04): dinars because the customer is charged a higher rate than the
// market on purpose (exchange profit), and any other excess too (other revenue, labelled). Up to
// 5 cents is left to the rounding rule. Live posting only: the historical replay keeps decision 77.
// account: where the excess goes (exchange gain/loss for a foreign currency, other revenue for dollars)
const OVERPAID_LABEL = 'دفع زائد على الطلب: مكسب (قرار 119)';
// Above this a dollar overpayment is also listed for the accountant to confirm (exceptions: overpaidProfit)
const OVERPAID_REVIEW_CENTS = 500;

async function rateMargin(keys, usd, currency, options, session) {
  if (options.isHistorical || options.migrationRunId) return { claimUsd: usd, margin: 0 };
  // A claim written off is owed again by what is paid on it (the order sync takes the write-off back)
  const { ClaimWriteOff } = require('../../models/documents');
  if (await ClaimWriteOff.exists({ arKey: { $in: keys }, status: 'posted' }).session(session)) return { claimUsd: usd, margin: 0 };
  const open = await openBalances(keys, session);
  const owed = keys.reduce((sum, key) => sum + Math.max(open.get(key) || 0, 0), 0);
  const margin = usd - owed;
  if (margin <= 5) return { claimUsd: usd, margin: 0 };
  return { claimUsd: owed, margin, role: currency === 'USD' ? 'revenue_other' : 'fx_gain_loss' };
}

const ordersOf = (keys) => [...new Set(keys.filter((k) => !k.startsWith('GEN:')).map((k) => k.split(':')[1]))];

// The office of a staff member: the one set by the owner, else their city when it is an office
async function officeOfCreator(userId, session) {
  if (!userId || !mongoose.isValidObjectId(String(userId))) return null;
  const user = await User.findById(userId).select('office city').session(session || null).lean();
  const { offices } = await getConfig();
  return [user?.office, user?.city].find((code) => code && offices.has(code)) || null;
}

// The rate written on the operation: the statement's own, the one the migration found on the
// matching payment, or the one on the payment this statement made
async function operationRate(statement, options, session) {
  if (Number(statement.rate) > 0) return Number(statement.rate);
  if (Number(options.target?.rate) > 0) return Number(options.target.rate);
  if (!statement.currency || statement.currency === 'USD') return undefined;
  const payment = await OrderPaymentHistory.findOne({ statementId: statement._id }).select('rate').session(session).lean();
  if (Number(payment?.rate) > 0) return Number(payment.rate);
  // A debt paid from the wallet keeps its rate in the debt's own payment history: the payment of
  // the same amount and currency closest in time
  if (options.target?.balanceId) {
    const balance = await Balance.findById(options.target.balanceId).select('paymentHistory').session(session).lean();
    const time = new Date(statement.createdAt).getTime();
    const match = (balance?.paymentHistory || [])
      .filter((p) => Number(p.rate) > 0 && p.currency === statement.currency && Math.abs(Number(p.amount) - Number(statement.amount)) < 0.011)
      .sort((a, b) => Math.abs(new Date(a.createdAt).getTime() - time) - Math.abs(new Date(b.createdAt).getTime() - time))[0];
    if (match) return Number(match.rate);
  }
  return undefined;
}

// Whose office box live cash lands in (spec v8): a clerk's cash is in their own office, whatever
// the screen says; the owner and the accountant record for any office, so the office written on
// the operation decides (and changing it on the operation moves the money to that office's box)
async function cashOffice(createdBy, recordOffice, session) {
  if (createdBy && mongoose.isValidObjectId(String(createdBy))) {
    const user = await User.findById(createdBy).select('roles').session(session || null).lean();
    const { isOwner } = require('../access');
    if (recordOffice && (user?.roles?.isAccountant || await isOwner({ _id: createdBy }))) return recordOffice;
  }
  return (await officeOfCreator(createdBy, session)) || recordOffice || null;
}

const DOMESTIC_NOTE = /نقل\s*داخلي|النقل\s*الداخلي|ديلفري|دليفري|delivery/i;

const statementKind = (s) => {
  if (s.calculationType === '-') return s.actionType === 'withdrawal' || s.paymentType === 'withdrawal' ? 'WITHDRAWAL' : 'WALLET_PAYMENT';
  if (s.actionType === 'compensation') return 'COMPENSATION';
  if (s.actionType === 'refund') return 'REFUND';
  if (s.actionType === 'cancellation' || s.actionType === 'wallet') return 'SETTLEMENT_CANCEL';
  return 'DEPOSIT';
};

// A customer wallet statement line. `options.target` says which claims a payment is for;
// `options.reverses` is the statement a cancellation gives back (its entry is reversed exactly).
async function postStatement(statementId, options = {}) {
  const { session } = options;
  const statement = await UserStatement.findById(statementId).session(session).lean();
  if (!statement) return { skipped: 'statement not found' };
  if (statement.accountingSource?.model) return { skipped: 'posted by accounting itself' };

  // The historical migration may say what an old statement was when its kind was never saved
  // (a payment given back to the wallet, saved as a plain deposit by the old screens)
  let kind = options.kind || statementKind(statement);
  // A deduction with no order or debt whose note says it is for transport to another office or a
  // delivery: domestic shipping revenue, live as in the historical replay (decision 76, spec v8)
  const target = options.target || {};
  const linked = target.orderId || target.arKeys?.length || target.balanceId;
  if (!options.kind && kind === 'WALLET_PAYMENT' && !linked && DOMESTIC_NOTE.test(String(statement.note || ''))) {
    kind = 'SERVICE_FEE';
    options = { ...options, target: { ...target, revenueRole: 'revenue_shipping_domestic' } };
  }
  const version = options.version ? `:v${options.version}` : '';
  const eventKey = `${kind}:${statement._id}${version}`;

  // A cancellation that gives back a known payment: its entry is reversed exactly. It posts no
  // entry under eventKey; reversing is itself once only (a reversed entry is not reversed again).
  if (kind === 'SETTLEMENT_CANCEL' && options.reverses) {
    const reversals = await reverseSourceEntries('UserStatement', options.reverses, {
      session, user: options.user, reason: statement.description, migrationRunId: options.migrationRunId, isHistorical: options.isHistorical,
    });
    const keys = reversals.flatMap((r) => r.lines.map((l) => l.arKey).filter(Boolean));
    for (const orderId of ordersOf(keys)) await syncOrder(orderId, { ...options, date: statement.createdAt });
    return { reversed: reversals.length };
  }
  if (await JournalEntry.exists({ eventKey }).session(session)) return { skipped: 'already posted' };

  const { settings, offices } = await getConfig();
  const currency = CURRENCY_ALIASES[statement.currency] || statement.currency;
  const minor = await toCurrencyMinor(statement.amount, currency);
  if (!minor) return { skipped: 'zero amount' };
  const day = statement.createdAt || new Date();
  const rates = new RateBook(session);
  const wallet = await resolveAccount(walletRole(currency));
  const partnerId = oid(statement.user);
  const fallbacks = [];
  // The operation's own rate first (owner's rule): written on the statement, else on the payment
  // it made (old wallet payments kept the rate on the payment only), else the day's system rate
  const docRate = await operationRate(statement, options, session);
  // Old deposit screens did not save the office: the office of the staff member who entered the
  // statement (set in Accounting > Access, else the city on their account) stands for it
  const creatorOffice = statement.office ? null : await officeOfCreator(statement.createdBy, session);
  if (creatorOffice) fallbacks.push(`العملية بدون مكتب؛ اعتُبر مكتب الموظف الذي أدخلها (${creatorOffice})`);
  const statementOffice = statement.office || creatorOffice;
  const officeCode = settings.officeAliases?.[statementOffice] || statementOffice;
  const office = offices.has(officeCode) ? officeCode : settings.defaultOffice;
  const lines = [];
  let affectedKeys = [];

  const walletIn = async () => {
    const usd = await rates.toUsd(minor, currency, day, docRate);
    lines.push(moneyLine(wallet, 'credit', minor, usd, { partnerId, label: statement.description }));
    return usd;
  };
  const walletOut = async () => {
    const usd = await valueOut(wallet, minor, { day, docRate: docRate, rates, partnerId });
    lines.push(moneyLine(wallet, 'debit', minor, usd, { partnerId, label: statement.description }));
    return usd;
  };
  // Cash box of the office/currency, or the suspense account when the statement has no office
  const cashAccount = async () => {
    // The account chosen on the deposit screen (a bank, or a partner's current account like Wasl)
    if (statement.accountId) {
      const chosen = (await getConfig()).accountsById.get(String(statement.accountId));
      if (chosen?.isCash && chosen.isActive && (chosen.currency || 'USD') === currency) return chosen;
      fallbacks.push('الحساب المختار في الإيداع غير صالح لهذه العملة؛ استُخدمت خزينة المكتب');
    }
    // Live: a sub cash box (see cashOffice); history: the main box of the statement's office
    const historical = !!options.isHistorical;
    const boxOffice = historical ? statementOffice : await cashOffice(statement.createdBy, statementOffice, session);
    const account = await resolveStaffCashAccount(boxOffice, currency, { historical });
    if (account) return account;
    if (!historical && boxOffice) throw fail(`لا توجد خزينة ${currency} للمكتب ${boxOffice || '-'}. أضفها من المحاسبة ← المكاتب والخزائن ثم أعد المحاولة من الترحيل الحي.`);
    fallbacks.push(statementOffice ? `لا توجد خزينة ${currency} للمكتب ${statementOffice}` : 'العملية بدون مكتب؛ سُجّلت في حساب المعلّق حتى يحددها المحاسب');
    return getAccount((await resolveAccount('migration_suspense'))._id);
  };

  if (kind === 'DEPOSIT') {
    const usd = await walletIn();
    const cash = await cashAccount();
    // A cash box always matches the currency; the suspense account is kept in USD only
    lines.push(moneyLine(cash, 'debit', minor, usd, { office, label: statement.description }));
  } else if (kind === 'COMPENSATION' || kind === 'REFUND' || kind === 'SETTLEMENT_CANCEL') {
    const usd = await walletIn();
    // A refund tied to an order (money the supplier gave back, spec 19.6) lowers that order's sale:
    // the claim line here, then the order sync bills the customer that much less
    const linked = kind === 'SETTLEMENT_CANCEL' || (kind === 'REFUND' && (options.target?.orderId || options.target?.arKeys?.length));
    const keys = linked ? await resolveClaimKeys(options.target, session) : [];
    if (keys.length) await lockClaimAllocations(keys, session);
    if (keys.length) {
      // Money given back for a payment: the claim is owed again (for a refund: until the sync
      // lowers the claim by the same amount)
      const receivable = await resolveAccount('customer_receivable');
      const parts = [{ key: keys[0], usd }];
      claimLines(parts, 'debit', partnerId).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
      affectedKeys = keys;
    } else {
      const role = kind === 'COMPENSATION' ? 'compensation_expense' : 'customer_refunds';
      if (kind === 'SETTLEMENT_CANCEL') fallbacks.push('إرجاع للمحفظة غير مربوط بدفعة معروفة؛ سُجّل كمبلغ مسترد');
      lines.push({ accountId: (await resolveAccount(role))._id, debit: usd, office, label: statement.description });
    }
  } else if (kind === 'SERVICE_FEE') {
    // A charge taken from the wallet for a service with no order (domestic transport, delivery):
    // revenue of the office that entered it
    const usd = await walletOut();
    lines.push({ accountId: (await resolveAccount(options.target?.revenueRole || 'revenue_other'))._id, credit: usd, office, label: statement.description });
  } else if (kind === 'WITHDRAWAL') {
    await walletOut();
    const cash = await cashAccount();
    if (!options.isHistorical && !(await isBeforeCashCount(require('../dates').toDay(day)))) {
      await lockPostingAccounts([cash], session);
    }
    const cashUsd = cash.currency === currency
      ? await valueOut(cash, minor, { day, docRate: docRate, rates })
      : await rates.toUsd(minor, currency, day, docRate);
    lines.push(moneyLine(cash, 'credit', minor, cashUsd, { office, label: statement.description }));
  } else {
    const recoveryBalance = target.balanceId && await Balance.findById(target.balanceId).select('status sourceBalance').session(session).lean();
    if (recoveryBalance?.status === 'lost' && recoveryBalance.sourceBalance) {
      await walletOut();
      const recoveredUsd = await rates.toUsd(minor, currency, day, docRate);
      const badDebt = await resolveAccount('bad_debt_expense');
      lines.push({ accountId: badDebt._id, credit: recoveredUsd, partnerId, office, arKey: generalDebtKey(recoveryBalance.sourceBalance), label: 'Recovery of a written-off debt' });
    } else {
    // WALLET_PAYMENT: the claims are paid at the operation's rate; the wallet gives up the
    // dinars at its average rate; the difference is an exchange gain/loss (spec 2.4, E8)
    await walletOut();
    const atRate = await rates.toUsd(minor, currency, day, docRate);
    const keys = await resolveClaimKeys(options.target, session);
    if (keys.length) {
      await lockClaimAllocations(keys, session);
      const receivable = await resolveAccount('customer_receivable');
      // What is paid beyond what is owed is profit, not the customer's credit
      const { claimUsd, margin, role } = await rateMargin(keys, atRate, currency, options, session);
      const parts = await splitOverClaims(keys, claimUsd, session);
      claimLines(parts, 'credit', partnerId).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
      if (margin) lines.push({ accountId: (await resolveAccount(role))._id, credit: margin, office, label: OVERPAID_LABEL, partnerId, ...(ordersOf(keys)[0] && { orderId: oid(ordersOf(keys)[0]) }) });
      affectedKeys = keys;
    } else {
      fallbacks.push('دفعة من المحفظة غير مربوطة بطلب أو دين؛ سُجّلت في حساب المعلّق');
      lines.push({ accountId: (await resolveAccount('migration_suspense'))._id, credit: atRate, label: statement.description });
    }
    }
  }
  await addFxLine(lines, office);

  const entry = await postEntry({
    eventType: kind,
    eventKey,
    date: day,
    description: `${statement.description}${statement.note ? ` (${statement.note})` : ''}`,
    source: { model: 'UserStatement', id: statement._id },
    isHistorical: !!options.isHistorical,
    migrationRunId: options.migrationRunId,
    fallbacks: [...rates.fallbacks, ...fallbacks],
    lines,
  }, { session, user: options.user });
  await rates.lock();

  for (const orderId of ordersOf(affectedKeys)) await syncOrder(orderId, { ...options, date: day });
  // A general debt paid and left a few cents over or under (dinars turned into dollars at the
  // payment's rate) is closed on the rounding account, as order claims are (spec 2.5)
  const generalKeys = affectedKeys.filter((key) => String(key).startsWith('GEN:'));
  if (generalKeys.length) {
    const open = await openBalances(generalKeys, session);
    const lines = [];
    for (const key of generalKeys) {
      const left = open.get(key) || 0;
      if (!left || Math.abs(left) > 5) continue;
      const receivable = await resolveAccount('customer_receivable');
      const rounding = await resolveAccount('rounding');
      const claim = { accountId: receivable._id, partnerId, arKey: key, label: 'فرق تقريب' };
      const other = { accountId: rounding._id, office, label: 'فرق تقريب' };
      lines.push(...(left > 0 ? [{ ...other, debit: left }, { ...claim, credit: left }] : [{ ...claim, debit: -left }, { ...other, credit: -left }]));
    }
    if (lines.length) {
      await postEntry({
        eventType: 'ROUNDING', eventKey: `ROUNDING:${statement._id}${version}`, date: day, description: 'فرق تقريب على دين',
        source: { model: 'UserStatement', id: statement._id }, isHistorical: !!options.isHistorical, migrationRunId: options.migrationRunId, lines,
      }, { session, user: options.user });
    }
  }
  return { entryId: entry._id };
}

// A statement edited after posting (E21): its entries are reversed and it is posted again
async function repostStatement(statementId, options = {}) {
  const { session } = options;
  const statement = await UserStatement.findById(statementId).session(session).lean();
  const reversals = await reverseSourceEntries('UserStatement', statementId, { session, user: options.user, reason: 'تعديل العملية' });
  if (!statement) return { reversed: reversals.length };
  // The edit keeps what the line was for: the order or debt given when it was first recorded,
  // else the claims its old entry touched (a refund linked to an order stays on that order)
  const oldKeys = [...new Set(reversals.flatMap((r) => r.lines.map((l) => l.arKey).filter(Boolean)))];
  let target = options.target;
  if (!target) {
    const first = await AccountingEvent.findOne({ type: 'statement', refId: statement._id }).sort({ createdAt: 1 }).session(session).lean();
    target = first?.payload?.target;
  }
  if (!target && oldKeys.length) target = { arKeys: oldKeys };
  // Each re-post gets a version no entry of this line has used yet. Taken from the edit count it
  // collided when two edits were queued before either was processed: the second reversed the
  // entry, found its version taken and left the line with no entry at all
  const made = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': statement._id, reversalOf: null }).select('eventKey').session(session).lean();
  const taken = new Set(made.map((entry) => Number(String(entry.eventKey).match(/:v(\d+)$/)?.[1] || 1)));
  let version = made.length + 1;
  while (taken.has(version)) version += 1;
  const result = await postStatement(statementId, { ...options, target, version });
  // Orders the old entry touched are brought up to date too
  for (const orderId of ordersOf(oldKeys)) await syncOrder(orderId, options);
  return { reversed: reversals.length, ...result };
}

// A statement deleted from the customer's cashflow: its entries are reversed
async function reverseStatement(statementId, options = {}) {
  const reversals = await reverseSourceEntries('UserStatement', statementId, { ...options, reason: options.reason || 'حذف العملية من كشف العميل' });
  const keys = reversals.flatMap((r) => r.lines.map((l) => l.arKey).filter(Boolean));
  for (const orderId of ordersOf(keys)) await syncOrder(orderId, options);
  return { reversed: reversals.length };
}

// E10: cash paid directly on an order (not through the wallet)
async function postCashPayment(paymentId, options = {}) {
  const { session } = options;
  const payment = await OrderPaymentHistory.findById(paymentId).session(session).lean();
  if (!payment) return { skipped: 'payment not found' };
  if (payment.paymentType !== 'cash') return { skipped: 'wallet payments are posted from the statement' };
  const eventKey = `CASH_PAYMENT:${payment._id}`;
  if (await JournalEntry.exists({ eventKey }).session(session)) return { skipped: 'already posted' };

  const { settings, offices } = await getConfig();
  const currency = CURRENCY_ALIASES[payment.currency] || payment.currency;
  const minor = await toCurrencyMinor(payment.receivedAmount, currency);
  if (!minor) return { skipped: 'zero amount' };
  const rates = new RateBook(session);
  const day = payment.createdAt || new Date();
  const usd = await rates.toUsd(minor, currency, day, payment.rate);
  const fallbacks = [];

  // Live: a sub cash box (see cashOffice); history: the main box
  const historical = !!options.isHistorical;
  const boxOffice = historical ? options.office : await cashOffice(payment.createdBy, options.office, session);
  let cash = await resolveStaffCashAccount(boxOffice, currency, { historical });
  // Live: an office with no box in that currency waits, with the reason, until one is added
  if (!cash && !historical && boxOffice) throw fail(`لا توجد خزينة ${currency} للمكتب ${boxOffice || '-'}. أضفها من المحاسبة ← المكاتب والخزائن ثم أعد المحاولة من الترحيل الحي.`);
  if (!cash) {
    fallbacks.push('الدفع النقدي على الطلب لا يحدد الخزينة؛ سُجّل في حساب المعلّق حتى يحددها المحاسب');
    cash = await getAccount((await resolveAccount('migration_suspense'))._id);
  }
  const order = payment.order && await Order.findById(payment.order).select('placedAt user').session(session).lean();
  const office = offices.has(options.office || order?.placedAt) ? (options.office || order?.placedAt) : settings.defaultOffice;
  const cashLine = moneyLine(cash, 'debit', minor, usd, { office, label: 'دفع نقدي على الطلب' });

  const keys = await resolveClaimKeys({
    orderId: payment.order, category: payment.category === 'receivedGoods' ? 'receivedGoods' : 'invoice',
    packageIds: (payment.list || []).map((p) => p?._id || p?.id).filter(Boolean),
  }, session);
  if (keys.length) await lockClaimAllocations(keys, session);
  const receivable = await resolveAccount('customer_receivable');
  const lines = [cashLine];
  if (keys.length) {
    const { claimUsd, margin, role } = await rateMargin(keys, usd, currency, options, session);
    const parts = await splitOverClaims(keys, claimUsd, session);
    claimLines(parts, 'credit', oid(order?.user || payment.customer)).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
    if (margin) lines.push({ accountId: (await resolveAccount(role))._id, credit: margin, office, label: OVERPAID_LABEL, partnerId: oid(order?.user || payment.customer), ...(payment.order && { orderId: oid(payment.order) }) });
  } else {
    fallbacks.push('الدفعة غير مربوطة بطلب');
    lines.push({ accountId: (await resolveAccount('migration_suspense'))._id, credit: usd });
  }

  await postEntry({
    eventType: 'CASH_PAYMENT', eventKey, date: day, description: `دفع نقدي على الطلب`,
    source: { model: 'OrderPaymentHistory', id: payment._id }, isHistorical: !!options.isHistorical,
    migrationRunId: options.migrationRunId, fallbacks: [...rates.fallbacks, ...fallbacks], lines,
  }, { session, user: options.user });
  await rates.lock();
  for (const orderId of ordersOf(keys)) await syncOrder(orderId, { ...options, date: day });
  return { posted: true };
}

// A cash payment removed from an order: its entry is reversed
async function reverseCashPayment(paymentId, options = {}) {
  const reversals = await reverseSourceEntries('OrderPaymentHistory', paymentId, { ...options, reason: options.reason || 'إلغاء الدفعة' });
  const keys = reversals.flatMap((r) => r.lines.map((l) => l.arKey).filter(Boolean));
  for (const orderId of ordersOf(keys)) await syncOrder(orderId, options);
  return { reversed: reversals.length };
}

// A debt not tied to an order becomes its own claim on the customer
async function postGeneralDebt(balanceId, options = {}) {
  const { session } = options;
  const balance = await Balance.findById(balanceId).session(session).lean();
  if (!balance || balance.balanceType !== 'debt' || balance.status === 'lost') return { skipped: 'not a debt' };
  if (balance.order && balance.debtType !== 'general') return { skipped: 'follows its order' };
  const eventKey = `GENERAL_DEBT:${balance._id}`;
  if (await JournalEntry.exists({ eventKey }).session(session)) return { skipped: 'already posted' };

  const { settings, offices } = await getConfig();
  const office = offices.has(balance.createdOffice) ? balance.createdOffice : settings.defaultOffice;
  const minor = await toCurrencyMinor(balance.initialAmount, balance.currency);
  const rates = new RateBook(session);
  const day = balance.createdAt || new Date();
  const usd = await rates.toUsd(minor, balance.currency, day);
  const key = generalDebtKey(balance._id);
  const lines = [{ accountId: (await resolveAccount('customer_receivable'))._id, debit: usd, partnerId: oid(balance.owner), arKey: key, office }];
  const fallbacks = [];
  // The money of the debt left a cash box, or a partner paid it for us on their current account
  // (spec 19.8). A debt with no recorded source (all old ones) is money that left some box nobody
  // recorded: the suspense account, folded into the opening balance with the rest of history.
  const from = balance.source?.accountId && (await getConfig()).accountsById.get(String(balance.source.accountId));
  if (from && (from.currency || 'USD') === balance.currency) {
    const fromAccount = await getAccount(from._id, 'مصدر الدين');
    const out = await valueOut(fromAccount, minor, { day, rates });
    lines.push(moneyLine(fromAccount, 'credit', minor, out, { office: fromAccount.office || office, label: `دين على العميل: ${balance.notes}` }));
    await addFxLine(lines, office);
  } else {
    fallbacks.push('دين بلا مصدر مسجل؛ سُجّل مقابل حساب المعلّق');
    lines.push({ accountId: (await resolveAccount('migration_suspense'))._id, credit: usd, label: balance.notes });
  }
  await postEntry({
    eventType: 'GENERAL_DEBT', eventKey, date: day, description: `دين على العميل: ${balance.notes}`,
    source: { model: 'Balance', id: balance._id }, isHistorical: !!options.isHistorical, migrationRunId: options.migrationRunId,
    fallbacks: [...rates.fallbacks, ...fallbacks],
    lines,
  }, { session, user: options.user });
  await rates.lock();
  return { posted: true };
}

// A debt closed by hand: the written-off remainder is a bad debt
async function postDebtWriteOff(balanceId, options = {}) {
  const { session } = options;
  const balance = await Balance.findById(balanceId).session(session).lean();
  const amount = balance?.manualClosure?.writtenOffAmount;
  if (!amount) return { skipped: 'nothing written off' };
  const eventKey = `DEBT_WRITEOFF:${balance._id}`;
  if (await JournalEntry.exists({ eventKey }).session(session)) return { skipped: 'already posted' };

  const { settings, offices } = await getConfig();
  const office = offices.has(balance.createdOffice) ? balance.createdOffice : settings.defaultOffice;
  const rates = new RateBook(session);
  const day = balance.manualClosure.closedAt || new Date();
  const keys = await resolveClaimKeys({ balanceId: balance._id }, session);
  // A manual close writes off all that is left: its value is what the claim still holds (valued at
  // the debt's and its payments' own rates); the day's rate only when nothing is left to read
  const open = keys.length ? [...(await openBalances(keys, session)).values()].reduce((sum, v) => sum + Math.max(v, 0), 0) : 0;
  const usd = open > 0 && balance.currency !== 'USD' ? open : await rates.toUsd(await toCurrencyMinor(amount, balance.currency), balance.currency, day);
  const receivable = await resolveAccount('customer_receivable');
  const lines = [{ accountId: (await resolveAccount('bad_debt_expense'))._id, debit: usd, office, label: balance.manualClosure.note }];
  if (keys.length) {
    claimLines(await splitOverClaims(keys, usd, session), 'credit', oid(balance.owner)).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
  } else {
    lines.push({ accountId: (await resolveAccount('migration_suspense'))._id, credit: usd });
  }
  await postEntry({
    eventType: 'DEBT_WRITEOFF', eventKey, date: day, description: `شطب باقي دين: ${balance.manualClosure.note}`,
    source: { model: 'Balance', id: balance._id }, isHistorical: !!options.isHistorical, migrationRunId: options.migrationRunId,
    fallbacks: rates.fallbacks, lines,
  }, { session, user: options.user });
  await rates.lock();
  for (const orderId of ordersOf(keys)) await syncOrder(orderId, { ...options, date: day });
  return { posted: true };
}

async function reverseBalance(balanceId, options = {}) {
  return { reversed: (await reverseSourceEntries('Balance', balanceId, { ...options, reason: options.reason || 'حذف الدين' })).length };
}

// A rate written on an old dinar wallet payment (services/paymentRate.js): its wallet line is posted
// again at that rate, and what the migration took for an overpayment on the order (the dinars
// counted at the wallet's average) is undone; the order is then brought up to date. The
// overpayment goes first: posted again before it, the payment looked short for a moment and the
// revenue of that part was taken back from its month and recognised again today (6458-2723)
async function repostPaymentRate(paymentId, options = {}) {
  const { session } = options;
  const { statementId, orderId, category } = options;
  if (!statementId || !orderId) return { skipped: 'nothing to post' };
  const overpaid = await JournalEntry.find({ eventKey: new RegExp(`^OVERPAID:[^:]+:(PUR|SHP):${orderId}(:|$)`), status: 'posted', reversalOf: null }).session(session);
  for (const entry of overpaid) await reverseEntry(entry._id, { session, user: options.user, reason: 'كُتب سعر الدفعة: لم يكن دفعاً زائداً' });
  const result = await repostStatement(statementId, { ...options, target: { orderId, category: category || 'invoice' } });
  await syncOrder(orderId, options);
  return { ...result, overpaidReversed: overpaid.length };
}

module.exports = {
  OVERPAID_LABEL, OVERPAID_REVIEW_CENTS,
  repostPaymentRate,
  postStatement, repostStatement, reverseStatement, postCashPayment, reverseCashPayment,
  postGeneralDebt, postDebtWriteOff, reverseBalance, resolveClaimKeys, splitOverClaims, openBalances, statementKind,
};
