// The historical replay (spec 6-أ): every past record goes through the same posting code as
// live operations, on its own date, oldest first. Nothing here writes opening balances by hand:
// the books are rebuilt from history, and what history cannot explain is listed in the report.
const mongoose = require('mongoose');
const { JournalEntry, MigrationRun, CurrencyRate } = require('../../models');
const { Vendor } = require('../../models/documents');
const Wallet = require('../../../models/wallet');
const { runInTransaction } = require('../transaction');
const { postEntry } = require('../ledger');
const { getConfig } = require('../config');
const { resolveCashAccount, walletRole } = require('../roles');
const { getBalance, valueOutflow } = require('../carrying');
const { toDay } = require('../dates');
const { syncOrder } = require('../claims/sync');
const { purchaseKey, shipmentKey } = require('../claims/keys');
const operations = require('../posting/operations');
const payables = require('../posting/payables');
const { RateBook, moneyLine, toCurrencyMinor, valueOut, getAccount, resolveAccount } = require('../posting/common');
const { loadSources, deriveRates } = require('./sources');

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const PRIORITY = { claim: 1, deposit: 2, bill: 3, payment: 4, delivery: 5, cancel: 6 };
const MAX_PROBLEMS = 1000;

async function suspenseAccount() {
  return getAccount((await resolveAccount('migration_suspense'))._id);
}

// The cash box of an office in a currency, or the suspense account (spec 6-أ.3)
async function cashOrSuspense(office, currency) {
  return (office && await resolveCashAccount(office, currency)) || suspenseAccount();
}

// Order.receivedUSD/LYD and receivedShipmentUSD/LYD: money the old screens recorded as received on
// the order itself (and added to that office's cash). Paid into the office's cash box.
async function postLegacyReceived(order, part, amount, currency, keys, ctx) {
  const eventKey = `LEGACY_RECEIVED:${order._id}:${part}:${currency}`;
  if (await JournalEntry.exists({ eventKey }).session(ctx.session)) return;
  const minor = await toCurrencyMinor(amount, currency);
  if (!minor || !keys.length) return;
  const rates = new RateBook(ctx.session);
  const usd = await rates.toUsd(minor, currency, order.createdAt);
  const cash = await cashOrSuspense(order.placedAt, currency);
  const receivable = await resolveAccount('customer_receivable');
  const parts = await operations.splitOverClaims(keys, usd, ctx.session);
  const lines = [moneyLine(cash, 'debit', minor, usd, { office: order.placedAt, label: 'مبلغ مستلم مسجل على الطلب (النظام القديم)' })];
  parts.forEach(({ key, usd: part_ }) => {
    const [, , packageId] = key.split(':');
    lines.push({ accountId: receivable._id, credit: part_, partnerId: oid(order.user), arKey: key, orderId: order._id, ...(packageId && { packageId: oid(packageId) }) });
  });
  await postEntry({
    eventType: 'CASH_PAYMENT', eventKey, date: order.createdAt, description: `مبلغ مستلم على الطلب ${order.orderId} (من حقول الطلب القديمة)`,
    source: { model: 'Order', id: order._id }, isHistorical: true, migrationRunId: ctx.migrationRunId,
    fallbacks: [...rates.fallbacks, 'مستلم من حقول receivedUSD/LYD في الطلب؛ تحقق أنه غير مكرر مع دفعات أخرى'], lines,
  }, { session: ctx.session });
  await rates.lock();
}

// Old Income records: other income paid into the office's cash
async function postLegacyIncome(income, ctx) {
  const eventKey = `LEGACY_INCOME:${income._id}`;
  if (await JournalEntry.exists({ eventKey }).session(ctx.session)) return;
  const currency = income.cost?.currency || 'USD';
  const minor = await toCurrencyMinor(income.cost?.total || 0, currency);
  if (!minor) return;
  const { offices, settings } = await getConfig();
  const office = offices.has(income.office) ? income.office : settings.defaultOffice;
  const rates = new RateBook(ctx.session);
  const usd = await rates.toUsd(minor, currency, income.createdAt);
  const cash = await cashOrSuspense(income.office, currency);
  await postEntry({
    eventType: 'MIGRATION_ADJUST', eventKey, date: income.createdAt, description: `إيراد (من شاشة الإيرادات القديمة): ${income.description || ''}`,
    source: { model: 'Income', id: income._id }, isHistorical: true, migrationRunId: ctx.migrationRunId, fallbacks: rates.fallbacks,
    lines: [
      moneyLine(cash, 'debit', minor, usd, { office, label: income.description }),
      { accountId: (await resolveAccount('revenue_other'))._id, credit: usd, office, label: income.description },
    ],
  }, { session: ctx.session });
  await rates.lock();
}

function buildTimeline(sources, config, vendors) {
  const events = [];
  const add = (at, kind, source, ref, run) => {
    if (!at) return;
    events.push({ at: new Date(at), day: toDay(at), priority: PRIORITY[kind], source, ref: String(ref), run });
  };
  // Orders with payments recorded on them: their old "received" fields repeat those payments
  const paidOrders = new Set(sources.payments.map((p) => String(p.order)));
  const costAccount = (kind, keys) => (config.costAccounts || []).find((m) => m.kind === kind && keys.map(String).includes(String(m.key)))?.accountId;

  sources.orders.forEach((order) => {
    add(order.createdAt, 'claim', 'order', order._id, (ctx) => syncOrder(order._id, ctx));
    (order.editedAmounts || []).filter((e) => e.status === 'accepted' && e.createdAt)
      .forEach((edit) => add(edit.createdAt, 'claim', 'orderEdit', order._id, (ctx) => syncOrder(order._id, ctx)));
    if (order.isCanceled) add(order.updatedAt, 'cancel', 'orderCancel', order._id, (ctx) => syncOrder(order._id, ctx));

    const purchaseKeys = order.isPayment ? [purchaseKey(order._id)] : [];
    const shipKeys = (order.paymentList || []).map((p) => shipmentKey(order._id, p._id));
    const legacy = [
      ['purchase', order.receivedUSD, 'USD', purchaseKeys], ['purchase', order.receivedLYD, 'LYD', purchaseKeys],
      ['shipment', order.receivedShipmentUSD, 'USD', shipKeys], ['shipment', order.receivedShipmentLYD, 'LYD', shipKeys],
      ...(order.paymentList || []).flatMap((p) => [
        [`package:${p._id}`, p.deliveredPackages?.receivedShipmentUSD, 'USD', [shipmentKey(order._id, p._id)]],
        [`package:${p._id}`, p.deliveredPackages?.receivedShipmentLYD, 'LYD', [shipmentKey(order._id, p._id)]],
      ]),
    ];
    // Only for an order with no payment recorded on it (owner's decision): otherwise the same money
    // would be counted twice
    if (paidOrders.has(String(order._id))) legacy.length = 0;
    // Nor on an unconfirmed order: there they were typed as an estimate, not money received (0048-5097:
    // 2000$ and 1595 LYD on an empty order nobody paid). They are listed in the report for review.
    if (order.unsureOrder) legacy.length = 0;
    legacy.filter(([, amount]) => Number(amount) > 0).forEach(([part, amount, currency, keys]) => {
      add(order.createdAt, 'payment', 'legacyReceived', order._id, async (ctx) => {
        await postLegacyReceived(order, part, amount, currency, keys, ctx);
        await syncOrder(order._id, ctx);
      });
    });

    // A purchase cost is posted and left unpaid (owner's request 2026-10-04): the accountant records
    // how it was really paid (a Turkish bank in lira…) from the supplier payments screen. Only a cost
    // the mapping file ties to a box is paid from it.
    (order.purchaseItems || []).filter((item) => Number(item.unitPrice) > 0).forEach((item) => {
      const paidFrom = costAccount('order', [order._id, order.orderId]);
      add(item.date || order.createdAt, 'bill', 'purchaseItem', item._id, (ctx) => payables.createBill({
        vendorId: vendors.historical_supplier, day: toDay(item.date || order.createdAt), currency: item.currency || 'USD',
        isHistorical: true, migrationRunId: ctx.migrationRunId, idempotencyKey: `MIG:PURCH:${item._id}`,
        ...(paidFrom && { paidImmediatelyFrom: paidFrom }),
        lines: [{ description: item.description || 'شراء من مواقع', amount: Number(item.unitPrice), target: 'order', orderId: order._id }],
      }, { session: ctx.session, sync: ctx }));
    });
  });

  sources.deliveries.forEach((delivery, packageId) => {
    add(delivery.at, 'delivery', 'delivery', packageId, (ctx) => syncOrder(delivery.orderId, ctx));
  });

  sources.statements.forEach((statement) => {
    // A payment given back to the wallet sorts with the payments, by time, so it always comes
    // after the payment it undoes
    const kind = statement.calculationType === '+' && !sources.isPaymentRefund(statement) ? 'deposit' : 'payment';
    add(statement.createdAt, kind, 'statement', statement._id, (ctx) => {
      const target = sources.statementTarget(statement);
      return operations.postStatement(statement._id, { ...ctx, target, kind: target?.kind, reverses: target?.reverses });
    });
  });

  sources.payments.filter((p) => p.paymentType === 'cash').forEach((payment) => {
    add(payment.createdAt, 'payment', 'cashPayment', payment._id, (ctx) => operations.postCashPayment(payment._id, ctx));
  });

  sources.balances.forEach((balance) => {
    if (balance.status !== 'lost') add(balance.createdAt, 'claim', 'debt', balance._id, (ctx) => operations.postGeneralDebt(balance._id, ctx));
    if (balance.manualClosure?.writtenOffAmount) add(balance.manualClosure.closedAt || balance.updatedAt, 'payment', 'debtWriteOff', balance._id, (ctx) => operations.postDebtWriteOff(balance._id, ctx));
  });

  sources.trips.forEach((trip) => (trip.expenses || []).filter((e) => Number(e.amount) > 0).forEach((expense) => {
    add(expense.date || trip.createdAt, 'bill', 'tripExpense', expense._id, (ctx) => payables.createBill({
      vendorId: vendors.historical_carrier, day: toDay(expense.date || trip.createdAt), currency: expense.currency || 'USD',
      rate: Number(expense.rate) > 0 ? Number(expense.rate) : undefined,
      isHistorical: true, migrationRunId: ctx.migrationRunId, idempotencyKey: `MIG:TRIPEXP:${expense._id}`,
      paidImmediatelyFrom: costAccount('trip', [trip._id, trip.voyage]) || ctx.suspenseId,
      lines: [{ description: expense.description || `مصروف رحلة ${trip.voyage}`, amount: Number(expense.amount), target: 'trip', tripId: trip._id }],
    }, { session: ctx.session, sync: ctx }));
  }));

  sources.expenses.filter((e) => Number(e.cost?.total) > 0).forEach((expense) => {
    add(expense.createdAt, 'bill', 'legacyExpense', expense._id, async (ctx) => {
      const { offices, settings } = await getConfig();
      const currency = expense.cost.currency || 'USD';
      const office = offices.has(expense.placedAt) ? expense.placedAt : settings.defaultOffice;
      const cash = await cashOrSuspense(expense.placedAt, currency);
      return payables.createBill({
        vendorId: vendors.cash_expenses, day: toDay(expense.createdAt), currency, isHistorical: true, isQuickExpense: true,
        migrationRunId: ctx.migrationRunId, idempotencyKey: `MIG:EXP:${expense._id}`, paidImmediatelyFrom: cash._id,
        lines: [{ description: expense.description || 'مصروف (من شاشة المصروفات القديمة)', amount: Number(expense.cost.total), target: 'expense', accountId: ctx.generalExpenseId, office }],
      }, { session: ctx.session, sync: ctx });
    });
  });

  sources.incomes.filter((i) => Number(i.cost?.total) > 0).forEach((income) => {
    add(income.createdAt, 'deposit', 'legacyIncome', income._id, (ctx) => postLegacyIncome(income, ctx));
  });

  return events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.priority - b.priority || a.at - b.at || (a.ref < b.ref ? -1 : 1)));
}

async function saveProgress(run, phase, done, total) {
  await MigrationRun.updateOne({ _id: run._id }, { $set: { progress: { phase, done, total } } });
}

async function recordProblem(run, event, error) {
  if (run.problems.length >= MAX_PROBLEMS) return;
  const problem = { at: event.at, source: event.source, ref: event.ref, message: String(error.message || error).slice(0, 500) };
  run.problems.push(problem);
  await MigrationRun.updateOne({ _id: run._id }, { $push: { problems: problem } });
}

// Customer wallets must end where the system says they are (spec 6-أ.8); what history cannot
// explain is adjusted against the suspense account and listed by customer
// What customers paid on an order beyond everything billed on it, at the end of history (extra
// charges such as customs taken from the wallet, or a debt on the order larger than its bill):
// other revenue of that order (owner's decision 2026-10-02). Each one is listed in the report.
async function settleOverpayments(run) {
  const receivable = await resolveAccount('customer_receivable');
  const revenue = await resolveAccount('revenue_other');
  const { offices, settings } = await getConfig();
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.accountId': receivable._id } }, { $unwind: '$lines' },
    { $match: { 'lines.accountId': receivable._id, 'lines.arKey': { $ne: null } } },
    { $group: { _id: { arKey: '$lines.arKey', partnerId: '$lines.partnerId' }, open: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } }, orderId: { $first: '$lines.orderId' }, packageId: { $first: '$lines.packageId' } } },
    { $match: { open: { $lt: 0 } } },
  ]);
  const Order = require('../../../models/order');
  const orders = new Map((await Order.find({ _id: { $in: rows.map((r) => r.orderId).filter(Boolean) } }).select('orderId placedAt unsureOrder').lean()).map((o) => [String(o._id), o]));
  const settled = [];
  for (const row of rows) {
    const order = row.orderId && orders.get(String(row.orderId));
    // Paid on an unsure order: stays the customer's credit, listed for review, never revenue
    if (order?.unsureOrder) continue;
    const office = order && offices.has(order.placedAt) ? order.placedAt : settings.defaultOffice;
    const amount = -row.open;
    try {
      await runInTransaction((session) => postEntry({
        eventType: 'MIGRATION_ADJUST', eventKey: `OVERPAID:${run.runId}:${row._id.arKey}:${row._id.partnerId || ''}`, date: toDay(run.cutoff),
        description: `دفع زائد على ${order ? `الطلب ${order.orderId}` : 'دين'} يُسجَّل إيراداً آخر`, source: { model: order ? 'Order' : 'Balance', id: row.orderId || oid(row._id.arKey.split(':')[1]) },
        isHistorical: true, migrationRunId: run.runId, fallbacks: ['دفع أكثر من قيمة ما عليه؛ الزائد سُجّل إيرادات أخرى للمراجعة'],
        lines: [
          { accountId: receivable._id, debit: amount, partnerId: row._id.partnerId, arKey: row._id.arKey, ...(row.orderId && { orderId: row.orderId }), ...(row.packageId && { packageId: row.packageId }) },
          { accountId: revenue._id, credit: amount, office, ...(row.orderId && { orderId: row.orderId }), label: 'دفع زائد عن قيمة الطلب' },
        ],
      }, { session }));
      settled.push({ arKey: row._id.arKey, orderNumber: order?.orderId || null, orderId: row.orderId || null, amount });
    } catch (error) {
      await recordProblem(run, { at: run.cutoff, source: 'overpaid', ref: row._id.arKey }, error);
    }
  }
  return settled.sort((a, b) => b.amount - a.amount);
}

async function reconcileWallets(run, ctx) {
  const differences = [];
  const wallets = await Wallet.find({}).lean();
  const byKey = new Map(wallets.map((w) => [`${w.user}|${w.currency}`, w]));
  for (const currency of ['USD', 'LYD']) {
    const account = await resolveAccount(walletRole(currency));
    const ledger = await JournalEntry.aggregate([
      { $match: { 'lines.accountId': account._id } }, { $unwind: '$lines' }, { $match: { 'lines.accountId': account._id } },
      { $group: { _id: '$lines.partnerId', foreign: { $sum: '$lines.amountCurrency' } } },
    ]);
    const owedByPartner = new Map(ledger.map((row) => [String(row._id), -row.foreign]));
    const partners = new Set([...owedByPartner.keys(), ...wallets.filter((w) => w.currency === currency).map((w) => String(w.user))]);
    for (const partner of partners) {
      if (!partner || partner === 'null') continue;
      const system = await toCurrencyMinor(Math.max(0, byKey.get(`${partner}|${currency}`)?.balance || 0), currency).catch(() => 0);
      const booked = owedByPartner.get(partner) || 0;
      const difference = system - booked;
      if (!difference) continue;
      differences.push({ partnerId: partner, currency, system, booked, difference });
      try {
        await runInTransaction(async (session) => {
          const rates = new RateBook(session);
          const day = toDay(run.cutoff);
          const suspense = await suspenseAccount();
          const minor = Math.abs(difference);
          // A few dirhams are worth less than a cent: the line still carries one cent so the
          // wallet's dinars are brought in line
          const usd = Math.max(1, difference > 0
            ? await rates.toUsd(minor, currency, day)
            : await valueOut(account, minor, { day, rates, partnerId: partner }));
          const walletLine = moneyLine(account, difference > 0 ? 'credit' : 'debit', minor, usd, { partnerId: oid(partner), label: 'تسوية رصيد المحفظة مع المنظومة' });
          await postEntry({
            eventType: 'MIGRATION_ADJUST', eventKey: `WALLET_ADJUST:${run.runId}:${partner}:${currency}`, date: day,
            description: `تسوية محفظة عميل مع رصيدها في المنظومة (${currency})`, source: { model: 'User', id: oid(partner) },
            isHistorical: true, migrationRunId: run.runId, fallbacks: rates.fallbacks,
            lines: [walletLine, { accountId: suspense._id, [difference > 0 ? 'debit' : 'credit']: usd, label: 'فرق محفظة' }],
          }, { session });
          await rates.lock();
        });
      } catch (error) {
        await recordProblem(run, { at: run.cutoff, source: 'walletAdjust', ref: `${partner}|${currency}` }, error);
      }
    }
  }
  return differences;
}

// E22: each counted cash box is brought to its counted amount on the count day; the difference
// (counted - movements replayed up to that day) goes against the opening balance account
async function postOpeningCash(run) {
  const results = [];
  const countDay = run.config?.countDay || toDay(run.cutoff);
  for (const count of run.config?.openingCounts || []) {
    try {
      await runInTransaction(async (session) => {
        const account = await getAccount(count.accountId, 'الخزينة');
        const currency = account.currency || 'USD';
        const counted = await toCurrencyMinor(Number(count.amount) || 0, currency);
        // The count is the balance at the end of the chosen day; later movements come on top of it
        const bookedBalance = await getBalance(account._id, { session, upToDay: countDay });
        const booked = currency === 'USD' ? bookedBalance.usd : bookedBalance.foreign;
        const opening = counted - booked;
        results.push({ accountId: account._id, code: account.code, name: account.name, currency, counted, booked, opening, countDay });
        if (!opening) return;
        const rates = new RateBook(session);
        // Posted on the count day (owner's decision): before it the box shows exactly what the
        // system recorded, and on that day one entry brings it to the counted amount
        const day = countDay;
        // A currency first used after history began has no rate that early: its first known rate is used
        const fallbacks = [];
        // Money taken out of a box in another currency leaves at the box's average rate (spec 2.4),
        // so a box counted at zero is at zero in dollars too; money added comes in at the day's rate
        let usd = currency !== 'USD' && opening < 0 ? valueOutflow(bookedBalance, -opening) : null;
        try {
          if (usd === null) usd = await rates.toUsd(Math.abs(opening), currency, day);
        } catch (error) {
          const first = await CurrencyRate.findOne({ currency }).sort({ day: 1 }).session(session).lean();
          if (!first) throw error;
          usd = await rates.toUsd(Math.abs(opening), currency, day, first.rate);
          fallbacks.push(`لا يوجد سعر ${currency} في بداية التاريخ؛ استُخدم أول سعر معروف (${first.day})`);
        }
        const entry = await postEntry({
          eventType: 'OPENING_CASH', eventKey: `OPENING_CASH:${account._id}:${run.runId}`, date: day,
          description: `تسوية جرد ${account.name} بتاريخ ${countDay} (الجرد الفعلي ناقص الحركات المُرحَّلة)`, source: { model: 'AccountingAccount', id: account._id },
          isHistorical: true, migrationRunId: run.runId, fallbacks: [...rates.fallbacks, ...fallbacks],
          lines: [
            moneyLine(account, opening > 0 ? 'debit' : 'credit', Math.abs(opening), usd, { label: 'تسوية جرد: فرق لا تفسّره الحركات المسجلة' }),
            { accountId: (await resolveAccount('opening_balance'))._id, [opening > 0 ? 'credit' : 'debit']: usd, label: account.name },
          ],
        }, { session });
        results[results.length - 1].entryId = entry._id;
        await rates.lock();
      });
    } catch (error) {
      const account = (await getConfig()).accountsById.get(String(count.accountId));
      await recordProblem(run, { at: run.historyStart, source: 'openingCash', ref: account ? `${account.code} ${account.name}` : String(count.accountId) }, error);
    }
  }
  // Boxes that hold money in the books but were not counted: the count day must not pass them by
  const counted = new Set((run.config?.openingCounts || []).map((c) => String(c.accountId)));
  for (const account of [...(await getConfig()).accountsById.values()].filter((a) => a.isCash && !a.isGroup && a.isActive !== false && !counted.has(String(a._id)))) {
    const balance = await getBalance(account._id, { upToDay: countDay });
    const booked = (account.currency || 'USD') === 'USD' ? balance.usd : balance.foreign;
    if (booked) results.push({ accountId: account._id, code: account.code, name: account.name, currency: account.currency || 'USD', counted: null, booked, opening: 0, countDay, uncounted: true });
  }
  return results;
}

// "Start from today's counted balances": whatever history left in suspense stands for cash that
// moved through unknown boxes before the start. The boxes open at their counted balances, so
// those unknown legs are folded into the opening balance too and the accountant starts at zero.
async function closeSuspense(run) {
  try {
    return await runInTransaction(async (session) => {
      const suspense = await suspenseAccount();
      const balance = (await getBalance(suspense._id, { session })).usd;
      if (!balance) return { amount: 0 };
      await postEntry({
        eventType: 'MIGRATION_ADJUST', eventKey: `SUSPENSE_CLOSE:${run.runId}`, date: toDay(run.cutoff),
        description: 'إقفال حساب المعلّق التاريخي في الرصيد الافتتاحي (البدء من أرصدة الجرد)',
        source: { model: 'AccountingAccount', id: suspense._id }, isHistorical: true, migrationRunId: run.runId,
        lines: [
          { accountId: suspense._id, [balance > 0 ? 'credit' : 'debit']: Math.abs(balance), label: 'إقفال المعلّق التاريخي' },
          { accountId: (await resolveAccount('opening_balance'))._id, [balance > 0 ? 'debit' : 'credit']: Math.abs(balance), label: 'معلّق تاريخي' },
        ],
      }, { session });
      return { amount: balance };
    });
  } catch (error) {
    await recordProblem(run, { at: run.cutoff, source: 'suspenseClose', ref: run.runId }, error);
    return null;
  }
}

// Replays history up to run.cutoff (or only after `since`, for the catch-up at commit)
async function replay(run, { since } = {}) {
  const sources = await loadSources(run.cutoff);
  if (!since) {
    run.historyStart = sources.historyStart;
    await MigrationRun.updateOne({ _id: run._id }, { $set: { historyStart: sources.historyStart } });
    await saveProgress(run, 'rates', 0, 0);
    run.rateInfo = await deriveRates(sources, run.runId);
  }

  const vendorDocs = await Vendor.find({ seedKey: { $in: ['historical_carrier', 'historical_supplier', 'cash_expenses'] } }).lean();
  const vendors = Object.fromEntries(vendorDocs.map((v) => [v.seedKey, v._id]));
  const ctxBase = {
    migration: true, isHistorical: true, migrationRunId: run.runId, orderAt: sources.orderAt, deliveries: sources.deliveries,
    suspenseId: (await suspenseAccount())._id, generalExpenseId: (await resolveAccount('general_expense'))._id,
  };

  let events = buildTimeline(sources, run.config || {}, vendors);
  if (since) events = events.filter((e) => e.at > since);
  await saveProgress(run, 'replay', 0, events.length);

  let done = 0;
  for (const event of events) {
    try {
      await runInTransaction((session) => event.run({ ...ctxBase, session, date: event.at }));
    } catch (error) {
      await recordProblem(run, event, error);
    }
    done++;
    if (done % 50 === 0) await saveProgress(run, 'replay', done, events.length);
  }

  // Final pass: every order as it stands now, so the books end where the system is
  await saveProgress(run, 'final', 0, sources.orders.length);
  let finalDone = 0;
  for (const order of sources.orders) {
    try {
      await runInTransaction((session) => syncOrder(order._id, { ...ctxBase, session, date: run.cutoff }));
    } catch (error) {
      await recordProblem(run, { at: run.cutoff, source: 'finalSync', ref: String(order._id) }, error);
    }
    finalDone++;
    if (finalDone % 100 === 0) await saveProgress(run, 'final', finalDone, sources.orders.length);
  }

  // Wallets and opening cash only in the dry run: during the commit catch-up, operations waiting in
  // the live queue would look like differences and be adjusted twice
  await saveProgress(run, 'reconcile', 0, 0);
  const overpaidSettled = since ? [] : await settleOverpayments(run);
  const walletDifferences = since ? [] : await reconcileWallets(run, ctxBase);
  const openingCash = since ? [] : await postOpeningCash(run);
  const suspenseClosed = !since && run.config?.closeSuspense ? await closeSuspense(run) : null;
  return { events: events.length, overpaidSettled, walletDifferences, openingCash, suspenseClosed, rateInfo: run.rateInfo };
}

module.exports = { replay, buildTimeline };
