// Treasury transfers, currency exchange, Alipay top-ups (E16) and cash counts (E17)
const mongoose = require('mongoose');
const { TreasuryTransfer, CashCount } = require('../../models/documents');
const { postEntry } = require('../ledger');
const { getBalance, valueOutflow } = require('../carrying');
const { isDay } = require('../dates');
const { roundHalfAway } = require('../money');
const { logAudit } = require('../audit');
const {
  fail, currencyOf, isForeign, getAccount, toCurrencyMinor, decimalsOf, RateBook, valueOut, moneyLine, addFxLine,
  nextDocNumber, findExisting, resolveAccount, lockPostingAccounts, isBeforeCashCount,
} = require('./common');

const toId = (value) => new mongoose.Types.ObjectId(String(value));

async function treasuryAccount(id, what, employeeId) {
  const account = await getAccount(id, what);
  // A staff member's custody or loan: kept by employee, in the account's own currency
  const isAdvance = !!(await require('../custody').staffAccountKind(account._id));
  if (!account.isCash && !isAdvance) throw fail(`${what}: اختر خزينة أو بنكاً أو محفظة إلكترونية أو عهدة موظف`);
  if (isAdvance && !employeeId) throw fail('اختر الموظف صاحب العهدة');
  return { account, isAdvance };
}

// Money leaves `from` at its average rate. The receiving account gets:
// - a USD account: exactly the dollars received (any difference is an exchange gain/loss);
// - any other account: the dollar value that left, so its own average rate is what the
//   currency really cost (71,000 CNY bought with 10,000$ is carried at 7.1).
async function createTransfer(input, { session, req }) {
  const existing = await findExisting(TreasuryTransfer, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const { account: from, isAdvance: fromAdvance } = await treasuryAccount(input.fromAccountId, 'الحساب المرسل', input.employeeId);
  const { account: to, isAdvance: toAdvance } = await treasuryAccount(input.toAccountId, 'الحساب المستلم', input.employeeId);
  if (String(from._id) === String(to._id)) throw fail('الحساب المرسل والمستلم متطابقان');

  const feesAmount = input.hasFees === false ? 0 : Number(input.fees || 0);
  if (!Number.isFinite(feesAmount) || feesAmount < 0 || (input.hasFees === true && !feesAmount)) throw fail('أدخل قيمة رسوم تحويل موجبة');
  if (input.hasFees === true && !input.feesFromAccountId) throw fail('اختر الخزينة التي دفعت منها رسوم التحويل');
  const feesFrom = feesAmount ? await getAccount(input.feesFromAccountId || from._id, 'خزينة دفع الرسوم') : null;
  if (feesFrom && !feesFrom.isCash) throw fail('اختر خزينة أو بنكاً أو محفظة إلكترونية لدفع الرسوم');
  const affectsCurrentCash = !(await isBeforeCashCount(input.day));
  if (affectsCurrentCash) await lockPostingAccounts([from, to, feesFrom], session);
  const fromMinor = await toCurrencyMinor(input.fromAmount, currencyOf(from));
  const feesMinor = feesFrom ? await toCurrencyMinor(feesAmount, currencyOf(feesFrom)) : 0;
  if (feesAmount && !feesMinor) throw fail('قيمة الرسوم أصغر من دقة عملة الخزينة');
  if (!fromMinor) throw fail('المبلغ المرسل مطلوب');
  // Custody and loans are given and settled in the same currency (owner's request 2026-10-04): the
  // money comes back at the rate it went out at, and closing it leaves no exchange difference
  const staffMoney = fromAdvance || toAdvance;
  if (staffMoney) {
    if (currencyOf(from) !== currencyOf(to)) throw fail(`العهدة والسلفة تُعطى وتُرجع بنفس عملتها: ${from.name} بعملة ${currencyOf(from)} و${to.name} بعملة ${currencyOf(to)}`);
    if (feesMinor) throw fail('لا رسوم على إعطاء العهدة أو السلفة أو إرجاعها');
  }
  if (fromAdvance) {
    const held = await require('../custody').heldMinor(from, input.employeeId, session);
    if (fromMinor > held) throw fail(`المبلغ أكبر مما على الموظف في ${from.name} (${held / 10 ** await decimalsOf(currencyOf(from))} ${currencyOf(from)})`);
  }

  const rates = new RateBook(session);
  const feesFromSender = feesFrom && String(feesFrom._id) === String(from._id);
  const senderFeesMinor = feesFromSender ? feesMinor : 0;
  const outUsd = await valueOut(from, fromMinor + senderFeesMinor, { day: input.day, docRate: input.rate, rates, ...(fromAdvance && { employeeId: input.employeeId }) });
  let feesUsd = senderFeesMinor ? roundHalfAway((outUsd * senderFeesMinor) / (fromMinor + senderFeesMinor)) : 0;
  const sentUsd = outUsd - feesUsd;

  let toMinor;
  let toUsd;
  if (staffMoney) {
    // Same currency both sides: the same amount, worth what it was worth where it left
    toMinor = fromMinor;
    toUsd = sentUsd;
  } else if (!to.currency) {
    toMinor = sentUsd;
    toUsd = sentUsd;
  } else {
    toMinor = await toCurrencyMinor(input.toAmount, currencyOf(to));
    if (!toMinor) throw fail('المبلغ المستلم مطلوب');
    toUsd = isForeign(to) ? sentUsd : toMinor;
  }

  if (feesMinor && !feesFromSender) {
    if (String(feesFrom._id) === String(to._id) && isForeign(to)) {
      // Fees paid after receiving this transfer leave at the receiving account's new average.
      const held = await getBalance(to._id, { session });
      feesUsd = valueOutflow({ usd: held.usd + toUsd, foreign: held.foreign + toMinor }, feesMinor);
      if (feesUsd === null) feesUsd = await rates.toUsd(feesMinor, currencyOf(feesFrom), input.day, input.feesRate);
    } else {
      feesUsd = await valueOut(feesFrom, feesMinor, { day: input.day, docRate: input.feesRate, rates });
    }
  }

  const [doc] = await TreasuryTransfer.create([{
    day: input.day, fromAccountId: from._id, fromAmount: Number(input.fromAmount), toAccountId: to._id,
    toAmount: staffMoney ? Number(input.fromAmount) : !to.currency ? toMinor / 100 : Number(input.toAmount), fees: feesAmount,
    ...(feesFrom && { feesFromAccountId: feesFrom._id, feesCurrency: currencyOf(feesFrom) }),
    employeeId: input.employeeId || undefined, note: input.note, attachments: input.attachments,
    idempotencyKey: input.idempotencyKey, createdBy: req?.user?._id, status: 'posted',
    number: await nextDocNumber('TRF', input.day, session),
  }], { session });

  const employee = input.employeeId ? { employeeId: toId(input.employeeId) } : {};
  const lines = [
    moneyLine(to, 'debit', toMinor, toUsd, { label: `تحويل من ${from.name}`, ...(toAdvance && employee) }),
    moneyLine(from, 'credit', fromMinor + senderFeesMinor, outUsd, { label: `تحويل إلى ${to.name}`, ...(fromAdvance && employee) }),
  ];
  if (feesMinor) {
    if (!feesFromSender) lines.push(moneyLine(feesFrom, 'credit', feesMinor, feesUsd, { label: `دفع رسوم تحويل ${doc.number}` }));
    const feesAccount = input.feesAccountId ? await getAccount(input.feesAccountId, 'حساب الرسوم') : await resolveAccount('bank_fees');
    if (feesAccount.type !== 'expense' || feesAccount.isCash) throw fail('حساب الرسوم يجب أن يكون حساب مصروف');
    if (feesUsd) lines.push({ accountId: feesAccount._id, debit: feesUsd, office: feesFrom.office || from.office || to.office, label: 'رسوم التحويل' });
    doc.feesAccountId = feesAccount._id;
  }
  await addFxLine(lines, from.office || to.office);

  const entry = await postEntry({
    eventType: 'TRANSFER',
    eventKey: `TRANSFER:${doc._id}`,
    date: input.day,
    description: `تحويل ${doc.number}: ${from.name} ← ${to.name}${input.note ? ` - ${input.note}` : ''}`,
    source: { model: 'AccountingTreasuryTransfer', id: doc._id },
    fallbacks: rates.fallbacks,
    lines,
  }, { session, user: req?.user });
  await rates.lock();
  doc.entryId = entry._id;
  await doc.save({ session });
  await logAudit({ req, action: 'transfer.post', model: 'AccountingTreasuryTransfer', docId: doc._id, after: doc }, session);
  return doc;
}

// Counted cash vs the books; the difference goes to cash over/short. A shortage leaves at the
// box's average rate, an overage comes in at it (or at the day's rate if the box is empty).
async function createCashCount(input, { session, req }) {
  const existing = await findExisting(CashCount, input.idempotencyKey, session);
  if (existing) return existing;
  if (!isDay(input.day)) throw fail('التاريخ غير صالح');
  const account = await getAccount(input.accountId, 'الخزينة');
  if (!account.isCash) throw fail('اختر خزينة أو بنكاً');
  await lockPostingAccounts([account], session);
  const currency = currencyOf(account);
  const counted = await toCurrencyMinor(input.countedAmount, currency);
  const balance = await getBalance(account._id, { session });
  const difference = counted - balance.foreign;

  const [doc] = await CashCount.create([{
    day: input.day, accountId: account._id, countedAmount: Number(input.countedAmount),
    systemAmount: balance.foreign, difference, note: input.note, idempotencyKey: input.idempotencyKey,
    createdBy: req?.user?._id, status: 'posted', number: await nextDocNumber('CNT', input.day, session),
  }], { session });

  if (difference !== 0) {
    const rates = new RateBook(session);
    const overShort = await resolveAccount('cash_over_short');
    const office = account.office;
    let usd;
    if (difference < 0) {
      usd = await valueOut(account, -difference, { day: input.day, rates });
    } else if (isForeign(account) && balance.foreign > 0 && balance.usd > 0) {
      usd = roundHalfAway((difference * balance.usd) / balance.foreign);
    } else {
      usd = await rates.toUsd(difference, currency, input.day);
    }
    const lines = difference < 0
      ? [{ accountId: overShort._id, debit: usd, office, label: 'عجز جرد' }, moneyLine(account, 'credit', -difference, usd, { label: 'عجز جرد' })]
      : [moneyLine(account, 'debit', difference, usd, { label: 'زيادة جرد' }), { accountId: overShort._id, credit: usd, office, label: 'زيادة جرد' }];
    const entry = await postEntry({
      eventType: 'CASHCOUNT',
      eventKey: `CASHCOUNT:${doc._id}`,
      date: input.day,
      description: `جرد ${doc.number} - ${account.name}`,
      source: { model: 'AccountingCashCount', id: doc._id },
      fallbacks: rates.fallbacks,
      lines,
    }, { session, user: req?.user });
    await rates.lock();
    doc.entryId = entry._id;
    await doc.save({ session });
  }
  await logAudit({ req, action: 'cashcount.post', model: 'AccountingCashCount', docId: doc._id, after: doc }, session);
  return doc;
}

module.exports = { createTransfer, createCashCount };
