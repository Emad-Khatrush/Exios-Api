// The system's own money movements (spec E1-E5, E8-E10, debts): customer wallet statements,
// cash payments on orders, and customer debts (Balance).
const mongoose = require('mongoose');
const UserStatement = require('../../../models/userStatement');
const OrderPaymentHistory = require('../../../models/orderPaymentHistory');
const Order = require('../../../models/order');
const Balance = require('../../../models/balance');
const User = require('../../../models/user');
const { JournalEntry } = require('../../models');
const { postEntry } = require('../ledger');
const { getConfig } = require('../config');
const { walletRole, resolveCashAccount } = require('../roles');
const { reverseSourceEntries } = require('../cancel');
const { syncOrder } = require('../claims/sync');
const { purchaseKey, shipmentKey, generalDebtKey } = require('../claims/keys');
const { fail, toCurrencyMinor, RateBook, valueOut, moneyLine, addFxLine, resolveAccount, getAccount } = require('./common');const { roundHalfAway } = require('../money');

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
  const order = await Order.findById(target.orderId).select('paymentList._id isPayment').session(session).lean();
  if (!order) return [];
  if (target.category === 'invoice' || (!target.category && !target.packageIds?.length && order.isPayment)) return [purchaseKey(order._id)];
  const packageIds = target.packageIds?.length ? target.packageIds : (order.paymentList || []).map((p) => p._id);
  const keys = packageIds.map((id) => shipmentKey(order._id, id));
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

const ordersOf = (keys) => [...new Set(keys.filter((k) => !k.startsWith('GEN:')).map((k) => k.split(':')[1]))];

// The office of a staff member: the one set by the owner, else their city when it is an office
async function officeOfCreator(userId, session) {
  if (!userId || !mongoose.isValidObjectId(String(userId))) return null;
  const user = await User.findById(userId).select('office city').session(session || null).lean();
  const { offices } = await getConfig();
  return [user?.office, user?.city].find((code) => code && offices.has(code)) || null;
}

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
  const kind = options.kind || statementKind(statement);
  const version = options.version ? `:v${options.version}` : '';
  const eventKey = `${kind}:${statement._id}${version}`;
  if (await JournalEntry.exists({ eventKey }).session(session)) return { skipped: 'already posted' };

  // A cancellation that gives back a known payment: its entry is reversed exactly
  if (kind === 'SETTLEMENT_CANCEL' && options.reverses) {
    const reversals = await reverseSourceEntries('UserStatement', options.reverses, {
      session, user: options.user, reason: statement.description, migrationRunId: options.migrationRunId, isHistorical: options.isHistorical,
    });
    const keys = reversals.flatMap((r) => r.lines.map((l) => l.arKey).filter(Boolean));
    for (const orderId of ordersOf(keys)) await syncOrder(orderId, { ...options, date: statement.createdAt });
    return { reversed: reversals.length };
  }

  const { settings, offices } = await getConfig();
  const currency = CURRENCY_ALIASES[statement.currency] || statement.currency;
  const minor = await toCurrencyMinor(statement.amount, currency);
  if (!minor) return { skipped: 'zero amount' };
  const day = statement.createdAt || new Date();
  const rates = new RateBook(session);
  const wallet = await resolveAccount(walletRole(currency));
  const partnerId = oid(statement.user);
  const fallbacks = [];
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
    const usd = await rates.toUsd(minor, currency, day, statement.rate);
    lines.push(moneyLine(wallet, 'credit', minor, usd, { partnerId, label: statement.description }));
    return usd;
  };
  const walletOut = async () => {
    const usd = await valueOut(wallet, minor, { day, docRate: statement.rate, rates, partnerId });
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
    const account = statementOffice && await resolveCashAccount(statementOffice, currency);
    if (account) return account;
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
    const cashUsd = cash.currency === currency
      ? await valueOut(cash, minor, { day, docRate: statement.rate, rates })
      : await rates.toUsd(minor, currency, day, statement.rate);
    lines.push(moneyLine(cash, 'credit', minor, cashUsd, { office, label: statement.description }));
  } else {
    // WALLET_PAYMENT: the claims are paid at the operation's rate; the wallet gives up the
    // dinars at its average rate; the difference is an exchange gain/loss (spec 2.4, E8)
    await walletOut();
    const atRate = await rates.toUsd(minor, currency, day, statement.rate);
    const keys = await resolveClaimKeys(options.target, session);
    if (keys.length) {
      const receivable = await resolveAccount('customer_receivable');
      const parts = await splitOverClaims(keys, atRate, session);
      claimLines(parts, 'credit', partnerId).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
      affectedKeys = keys;
    } else {
      fallbacks.push('دفعة من المحفظة غير مربوطة بطلب أو دين؛ سُجّلت في حساب المعلّق');
      lines.push({ accountId: (await resolveAccount('migration_suspense'))._id, credit: atRate, label: statement.description });
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
  return { entryId: entry._id };
}

// A statement edited after posting (E21): its entries are reversed and it is posted again
async function repostStatement(statementId, options = {}) {
  const { session } = options;
  const statement = await UserStatement.findById(statementId).session(session).lean();
  const reversals = await reverseSourceEntries('UserStatement', statementId, { session, user: options.user, reason: 'تعديل العملية' });
  if (!statement) return { reversed: reversals.length };
  const result = await postStatement(statementId, { ...options, version: (statement.editHistory || []).length + 1 });
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

  let cash = options.office && await resolveCashAccount(options.office, currency);
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
  const receivable = await resolveAccount('customer_receivable');
  const lines = [cashLine];
  if (keys.length) {
    const parts = await splitOverClaims(keys, usd, session);
    claimLines(parts, 'credit', oid(order?.user || payment.customer)).forEach((line) => lines.push({ ...line, accountId: receivable._id }));
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
  const usd = await rates.toUsd(await toCurrencyMinor(amount, balance.currency), balance.currency, day);
  const keys = await resolveClaimKeys({ balanceId: balance._id }, session);
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

module.exports = {
  postStatement, repostStatement, reverseStatement, postCashPayment, reverseCashPayment,
  postGeneralDebt, postDebtWriteOff, reverseBalance, resolveClaimKeys, splitOverClaims, openBalances, statementKind,
};
