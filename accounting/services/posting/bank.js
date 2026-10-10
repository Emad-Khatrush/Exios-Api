// Bank / Alipay statements (E32): import a statement (Excel or PDF), match it with what the books
// already hold, and post what is left to the right account.
//
// Nothing is counted twice:
// - a line already imported from an earlier file (overlapping statements) is recognised by its
//   fingerprint and skipped;
// - a line that is already in the books (typed by hand, or posted by the system) is matched to
//   that entry instead of getting a new one: import matches automatically, and posting a line
//   is refused while an unmatched entry of the same amount sits within a week of it.
const crypto = require('crypto');
const { preferences, permittedHint } = require('./bankMatchingPreferences');
const mongoose = require('mongoose');
const { BankStatementLine, BankRule } = require('../../models/documents');
const { JournalEntry, Account } = require('../../models');
const { SupplierBill, Vendor } = require('../../models/documents');
const { getConfig } = require('../config');
const Order = require('../../../models/order');
const { readKnownFormat } = require('./statementFormats');
const { originalOf, paymentValue, currencyName } = require('./bankAmounts');
const { candidatesFor, brief: briefBill, selectBill } = require('./bankBills');
const bankMerchants = require('./bankMerchants');
const bankTransferHints = require('./bankTransferHints');
const alipayReconciliation = require('./alipayReconciliation');
const { postEntry } = require('../ledger');
const { isDay, addDays, toDay: accountingDay, dayStart: dayStartOf } = require('../dates');
const { logAudit } = require('../audit');
const ErrorHandler = require('../../../utils/errorHandler');
const { fail, currencyOf, getAccount, toCurrencyMinor, RateBook, valueOut, moneyLine, officeExists, resolveAccount, addFxLine, lockPostingAccounts } = require('./common');

// How far apart an entry typed by hand and the bank's line can be and still be the same money
const DUPLICATE_DAYS = 7;

async function bankAccount(id) {
  const account = await getAccount(id, 'الحساب');
  if (!account.isCash) throw fail('اختر بنكاً أو محفظة إلكترونية');
  return account;
}

// Text as the bank prints it varies (spaces, case, Turkish letters, digits in Arabic); only its
// words count. TİCARET / Ticaret / ticaret and ÖDEME / Ödeme / odeme all read the same.
const normalize = (text) => String(text || '')
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  .toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A rule's keyword is in a text when it starts a word ("amzn" in "AMZNMktplace"). A keyword of
// several words is also found when the statement prints them glued ("KrediKartıBorçÖdemesi").
const hasKeyword = (text, keyword) => {
  const key = normalize(keyword);
  if (!key) return false;
  if (` ${text}`.includes(` ${key}`)) return true;
  return key.includes(' ') && text.replace(/ /g, '').includes(key.replace(/ /g, ''));
};
const fingerprintOf = (line, repeat) => crypto.createHash('sha1')
  .update(line.sourceProvider === 'alipay' && line.sourceTransactionId
    ? ['alipay', alipayReconciliation.referenceOf(line.sourceTransactionId)].join('|')
    : [line.day, line.amount, normalize(line.reference), normalize(line.description), repeat].join('|')).digest('hex');
const isPurchaseRefund = line => line.amount > 0 && (line.movementKind === 'purchase_refund'
  || (line.movementKind !== 'card_payment' && Number(line.originalAmount) > 0 && !!line.originalCurrency));
const needsRefundReview = (line, hint) => !hint?.semanticTransfer && (isPurchaseRefund(line) || (line.sourceProvider !== 'alipay' && line.amount > 0 && line.movementKind !== 'card_payment'
  && hint?.bankPurpose !== 'yuan_purchase' && ((!!hint?.vendorId && (hint?.vendorType !== 'service' || hint?.bankPurpose === 'china_services')) || hint?.account?.code === '510400')));

// Statement rows as the lines they become, each with its fingerprint
async function toDocs(account, rows, extra = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw fail('الملف فارغ');
  const docs = [];
  // The same line twice on one day (two identical transfers) is two lines: each gets its repeat
  const repeats = new Map();
  const alipayIds = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.statementCurrency && String(row.statementCurrency).toUpperCase() !== currencyOf(account)) throw fail(`عملة الكشف ${row.statementCurrency} تختلف عن حساب ${account.name} (${currencyOf(account)})؛ اختر حساب الكشف الصحيح`);
    if (!isDay(row.day)) throw fail(`السطر ${index + 1}: التاريخ غير صالح (YYYY-MM-DD)`);
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) throw fail(`السطر ${index + 1}: المبلغ غير صالح`);
    const minor = Math.sign(amount) * await toCurrencyMinor(Math.abs(amount), currencyOf(account));
    const doc = {
      accountId: account._id, day: row.day, description: String(row.description || '').trim(), reference: String(row.reference || '').trim(), amount: minor,
      balanceAfter: row.balanceAfter !== undefined && row.balanceAfter !== '' && row.balanceAfter !== null
        ? await toCurrencyMinor(Math.abs(row.balanceAfter), currencyOf(account)) * Math.sign(row.balanceAfter) : undefined,
      ...(Number(row.counterAmount) > 0 && row.counterCurrency ? { counterAmount: Number(row.counterAmount), counterCurrency: String(row.counterCurrency).toUpperCase() } : {}),
      ...(row.purchaseMatch && { purchaseReviewPending: true }), ...extra,
      ...(['purchase', 'purchase_refund', 'card_payment'].includes(row.movementKind) && { movementKind: row.movementKind }),
    };
    if (row.sourceProvider === 'alipay') {
      if (currencyOf(account) !== 'CNY' || row.sourceCurrency !== 'CNY') throw fail('كشف Alipay يتطلب حسابًا بعملة CNY');
      const id = alipayReconciliation.referenceOf(row.sourceTransactionId);
      if (!id || typeof row.sourceTransactionId !== 'string' || id.length > 160 || /\s|[eE][+-]?\d+$/.test(id)) throw fail(`السطر ${index + 1}: رقم عملية Alipay غير صالح`);
      if (!['balance', 'confirmed', 'unknown'].includes(row.walletImpact)) throw fail('راجع طريقة الدفع في كشف Alipay');
      if (!['交易成功', '支付成功', '退款成功'].includes(row.transactionStatus)) throw fail('لا يمكن استيراد عملية Alipay غير مكتملة');
      if (row.paymentMethod && !/^账户余额(?:[（(].*[）)])?$/.test(row.paymentMethod)) throw fail('هذه العملية ليست مدفوعة من رصيد Alipay؛ استخدم حساب الدفع الفعلي');
      const previous = alipayIds.get(id);
      if (previous && (previous.amount !== minor || previous.day !== row.day)) throw fail('رقم عملية Alipay مكرر ببيانات مختلفة في الملف');
      Object.assign(doc, { sourceProvider: 'alipay', sourceCurrency: 'CNY', sourceTransactionId: id, reference: id,
        walletImpact: row.paymentMethod ? 'balance' : row.walletImpact === 'confirmed' ? 'confirmed' : 'unknown' });
      for (const key of ['merchantOrderId', 'counterparty', 'paymentMethod', 'transactionStatus', 'sourceTime', 'sourceReviewReason']) doc[key] = String(row[key] || '').trim();
      alipayIds.set(id, doc);
    }
    for (const field of ['originalAmount', 'settlementUsd', 'exchangeRate']) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        const value = Number(row[field]);
        if (!Number.isFinite(value) || value <= 0) throw fail(`السطر ${index + 1}: ${field} غير صالح`);
        doc[field] = value;
      }
    }
    if (row.originalCurrency) doc.originalCurrency = String(row.originalCurrency).toUpperCase();
    const exchange = bankTransferHints.exchangeOf(doc.description, currencyOf(account), amount);
    if (exchange && !exchange.error) Object.assign(doc, exchange);
    const base = fingerprintOf(doc, 0);
    const repeat = repeats.get(base) || 0;
    repeats.set(base, repeat + 1);
    doc.fingerprint = fingerprintOf(doc, repeat);
    doc.fingerprintRepeat = repeat;
    docs.push(doc);
  }
  return docs;
}

async function knownFingerprints(accountId, prints, session, docs = []) {
  const alipayDocs = docs.filter(doc => doc.sourceProvider === 'alipay');
  const rows = await BankStatementLine.find({ accountId, $or: [
    { fingerprint: { $in: prints } }, { fingerprintAliases: { $in: prints } },
    ...(alipayDocs.length ? [{ sourceTransactionId: { $in: alipayDocs.map(doc => doc.sourceTransactionId) } }, { reference: { $in: alipayDocs.map(doc => doc.sourceTransactionId) } }] : []),
  ] }).select('day amount reference sourceTransactionId fingerprint fingerprintAliases importedValues').session(session || null).lean();
  const known = new Set(rows.flatMap(row => [row.fingerprint, ...(row.fingerprintAliases || [])]));
  for (const doc of alipayDocs) {
    const previous = rows.find(row => alipayReconciliation.referenceOf(row.sourceTransactionId || row.reference) === doc.sourceTransactionId);
    if (!previous) continue;
    const versions = [previous, previous.importedValues].filter(Boolean);
    if (!versions.some(evidence => evidence.day === doc.day && evidence.amount === doc.amount)) throw fail(`رقم عملية Alipay ${doc.sourceTransactionId} مستورد مسبقًا بمبلغ أو تاريخ مختلف؛ راجع السطر الموجود`);
    known.add(doc.fingerprint);
  }
  return known;
}

// Correct the imported evidence only after its posting/match has been undone.
// Keep original and corrected fingerprints so either version of the file deduplicates.
async function editLine(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line) throw fail('سطر الكشف غير موجود');
  if (!['unmatched', 'ignored'].includes(line.lineStatus)) throw fail('فك المطابقة أو اعكس الترحيل قبل تعديل بيانات الكشف');
  if (!String(input.reason || '').trim()) throw fail('سبب التعديل مطلوب');
  const bank = await bankAccount(line.accountId);
  await Account.updateOne({ _id: bank._id }, { $inc: { postingVersion: 1 } }, { session });
  for (const [amount, currency] of [['originalAmount', 'originalCurrency'], ['counterAmount', 'counterCurrency']]) {
    const hasAmount = input[amount] !== '' && input[amount] != null;
    const hasCurrency = !!String(input[currency] || '').trim();
    if (hasAmount !== hasCurrency || (hasAmount && (!Number.isFinite(Number(input[amount])) || Number(input[amount]) <= 0 || !/^[A-Z]{3}$/.test(String(input[currency]).trim().toUpperCase())))) {
      throw fail('أدخل المبلغ والعملة معاً بقيم صحيحة');
    }
  }
  const fields = ['day', 'description', 'reference', 'amount', 'balanceAfter', 'originalAmount', 'originalCurrency', 'counterAmount', 'counterCurrency', 'settlementUsd'];
  if (line.sourceProvider === 'alipay') {
    if (String(input.reference || '').trim() !== line.sourceTransactionId) throw fail('رقم عملية Alipay ثابت لمنع التكرار؛ راجع المصدر قبل تغييره');
    fields.push('walletImpact');
    input = { ...input, walletImpact: line.walletImpact === 'unknown' && input.confirmWalletImpact === true ? 'confirmed' : line.walletImpact };
  }
  const before = Object.fromEntries(fields.map(key => [key, line[key]]));
  const row = Object.fromEntries(fields.map(key => [key, input[key]]));
  const [doc] = await toDocs(bank, [{ ...line.toObject(), ...row }]);
  if (!doc.amount) throw fail('المبلغ أصغر من دقة العملة');
  const original = line.importedValues || before;
  let repeat = line.fingerprintRepeat;
  if (repeat == null) {
    repeat = 0;
    while (repeat < 10000 && fingerprintOf(original, repeat) !== line.fingerprint) repeat++;
    if (repeat === 10000) repeat = 0;
  }
  const alias = fingerprintOf(doc, repeat);
  if (await BankStatementLine.exists({ accountId: bank._id, _id: { $ne: line._id }, $or: [{ fingerprint: alias }, { fingerprintAliases: alias }] }).session(session)) throw fail('البيانات الجديدة تطابق سطراً موجوداً؛ راجع التكرار');
  line.importedValues = original;
  line.fingerprintRepeat = repeat;
  line.fingerprintAliases = [...new Set([...(line.fingerprintAliases || []), alias])];
  for (const key of fields) line[key] = doc[key];
  for (const key of ['exchangeRate', 'crossRate', 'valuationUsd', 'valuationSource', 'rateBaseCurrency', 'rateQuoteCurrency', 'matchedOriginalAmount', 'matchedOriginalCurrency', 'matchDifferenceConfirmed', 'purchaseReviewPending']) line[key] = undefined;
  await line.save({ session });
  await logAudit({ req, action: 'bank.lineEdit', model: 'AccountingBankStatementLine', docId: line._id, before, after: { ...Object.fromEntries(fields.map(key => [key, line[key]])), reason: input.reason.trim() } }, session);
  return line;
}

// rows: [{ day, description, reference, amount (+ in / - out, in the account currency), balanceAfter,
//          counterAccountId?, office? }]
// Imports what is new, matches what the books already hold, then posts every new line that was
// given an account (from the table shown before importing) and is not in the books yet.
async function importLines(accountId, rows, { session, req, deferPosting = false, matchingSettings }) {
  if (session?.inTransaction()) await require('../periodLock').lockPeriod(session);
  const account = await bankAccount(accountId);
  // Serialize imports per bank account before checking fingerprints. Otherwise two uploads of
  // the same statement can both decide a line is new and each post it.
  const locked = await Account.updateOne(
    { _id: account._id, isCash: true, isActive: true },
    { $inc: { postingVersion: 1 } },
    { session },
  );
  if (locked.modifiedCount !== 1) throw fail('Ø­Ø³Ø§Ø¨ Ø§Ù„Ø¨Ù†Ùƒ ØºÙŠØ± Ù…ØªØ§Ø­ Ù„Ø§Ø³ØªÙŠØ±Ø§Ø¯ Ø§Ù„ÙƒØ´Ù');
  const batchId = crypto.randomUUID();
  const docs = await toDocs(account, rows, { importBatchId: batchId, createdBy: req?.user?._id });

  // Rows marked "ignore" in the table are kept (a later file will not bring them back) but are
  // neither matched nor posted
  docs.forEach((doc, index) => { if (rows[index].ignore) doc.lineStatus = 'ignored'; });
  const existing = await knownFingerprints(account._id, docs.map(d => d.fingerprint), session, docs);
  const fresh = docs.filter((doc, index) => !existing.has(doc.fingerprint) && docs.findIndex(d => d.fingerprint === doc.fingerprint) === index);
  if (fresh.length) await BankStatementLine.insertMany(fresh, { session });
  const { matched } = fresh.length ? await autoMatch(accountId, { session, req, matchingSettings }) : { matched: 0 };

  // The accounts chosen in the table: posted now, line by line; a line the books may already
  // hold, or that cannot be posted (a missing rate, say), stays unmatched with its reason
  let posted = 0;
  const notPosted = [];
  const freshPrints = new Set(fresh.map((doc) => doc.fingerprint));
  for (const [index, doc] of docs.entries()) {
    const row = rows[index];
    if (deferPosting || row.ignore || !(row.counterAccountId || row.link || row.billId || row.purchaseMatch) || !freshPrints.has(doc.fingerprint)) continue;
    const line = await BankStatementLine.findOne({ accountId: account._id, fingerprint: doc.fingerprint, lineStatus: 'unmatched' }).session(session);
    if (!line) continue;
    try {
      if (row.purchaseMatch) await (row.purchaseMatch.refund ? require('./bankRefund').match : require('./bankPurchaseReview').matchPurchase)(line._id, row.purchaseMatch, { session, req });
      else await createEntryForLine(line._id, { counterAccountId: row.counterAccountId, office: row.office || undefined, confirmNotDuplicate: !!row.confirmNotDuplicate, link: row.link || undefined, vendorName: row.vendorName || undefined, billId: row.billId }, { session, req });
      posted++;
    } catch (error) {
      // MongoDB has no savepoints: swallowing a posting failure could commit a bill without
      // its payment. Public bulk imports isolate each row with importStatement below.
      throw error;
    }
  }
  await logAudit({ req, action: 'bank.import', model: 'AccountingBankStatementLine', after: { accountId, batchId, count: fresh.length, skipped: docs.length - fresh.length, matched, posted } }, session);
  return { batchId, count: fresh.length, skipped: docs.length - fresh.length, matched, posted, notPosted };
}

async function importStatement(accountId, rows, { req, matchingSettings }) {
  matchingSettings = preferences(matchingSettings);
  const { runInTransaction } = require('../transaction');
  const result = await runInTransaction(session => importLines(accountId, rows, { session, req, deferPosting: true, matchingSettings }));
  const account = await bankAccount(accountId);
  const docs = await toDocs(account, rows);
  for (const [index, doc] of docs.entries()) {
    const row = rows[index];
    if (row.ignore || !(row.counterAccountId || row.link || row.billId || row.purchaseMatch)) continue;
    const line = await BankStatementLine.findOne({ accountId, fingerprint: doc.fingerprint, importBatchId: result.batchId, lineStatus: 'unmatched' }).lean();
    if (!line) continue;
    try {
      // A unique merchant upsert may lose to another bank import; retry after rollback.
      for (let attempt = 0; ; attempt++) {
        try {
          await runInTransaction(session => row.purchaseMatch
            ? (row.purchaseMatch.refund ? require('./bankRefund').match : require('./bankPurchaseReview').matchPurchase)(line._id, { ...row.purchaseMatch, confirmNotDuplicate: !!row.confirmNotDuplicate }, { session, req })
            : createEntryForLine(line._id, { ...row, confirmNotDuplicate: !!row.confirmNotDuplicate }, { session, req }));
          break;
        } catch (error) { if (attempt >= 2 || error.code !== 11000 || !error.keyPattern?.bankNameKey) throw error; }
      }
      result.posted++;
    } catch (error) { result.notPosted.push({ day: doc.day, description: doc.description, reason: error.message }); }
  }
  return result;
}

// Ledger movements on the account that no statement line is matched to yet
async function unmatchedMovements(accountId, { from, to, session } = {}) {
  const matched = await BankStatementLine.distinct('matchedEntryIds', { accountId, lineStatus: 'matched' }).session(session);
  const created = await BankStatementLine.distinct('entryId', { accountId, lineStatus: 'created_entry' }).session(session);
  const used = new Set([...matched, ...created].filter(Boolean).map(String));
  const dayFilter = {};
  if (from) dayFilter.$gte = from;
  if (to) dayFilter.$lte = to;
  const rows = await JournalEntry.aggregate([
    { $match: { status: 'posted', reversalOf: { $exists: false }, 'lines.accountId': new mongoose.Types.ObjectId(String(accountId)), ...(from || to ? { day: dayFilter } : {}) } },
    { $addFields: { allAccountIds: '$lines.accountId', allLines: '$lines' } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': new mongoose.Types.ObjectId(String(accountId)) } },
    { $group: { _id: '$_id', number: { $first: '$number' }, day: { $first: '$day' }, description: { $first: '$description' },
      allAccountIds: { $first: '$allAccountIds' }, ledgerLines: { $first: '$allLines' }, bankSourceReference: { $first: '$bankSourceReference' }, bankSourceAccountId: { $first: '$bankSourceAccountId' }, amount: { $sum: '$lines.amountCurrency' } } },
    { $sort: { day: 1 } },
  ]).session(session || null);
  return rows.filter((row) => !used.has(String(row._id)) && row.amount !== 0);
}

// One journal entry can match one line per bank account, but never two lines from the same
// account. This transactional write point prevents concurrent reconciliation requests racing.
async function reserveMatchedEntries(accountId, entryIds, session) {
  const uniqueIds = [...new Set(entryIds.map(String))];
  if (uniqueIds.length !== entryIds.length) throw fail('Repeated entry in bank reconciliation');
  for (const id of uniqueIds) {
    const result = await JournalEntry.updateOne(
      { _id: id, bankMatchedAccounts: { $ne: accountId } },
      { $addToSet: { bankMatchedAccounts: accountId } },
      { session },
    );
    if (result.modifiedCount !== 1) throw fail('This journal entry was just matched to another bank line');
  }
}

async function releaseMatchedEntries(accountId, entryIds, session) {
  if (!entryIds?.length) return;
  await JournalEntry.updateMany({ _id: { $in: entryIds } }, { $pull: { bankMatchedAccounts: accountId } }, { session });
}

const dayDistance = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);

// Same account and native amount within three days, only when one candidate is eligible.
async function autoMatch(accountId, { session, req, matchingSettings }) {
  const settings = preferences(matchingSettings);
  if (!settings.engines.includes('ledger')) return { matched: 0 };
  if (session?.inTransaction()) await require('../periodLock').lockPeriod(session);
  await bankAccount(accountId);
  const lines = await BankStatementLine.find({ accountId, lineStatus: 'unmatched', purchaseReviewPending: { $ne: true } }).sort({ day: 1 }).session(session);
  if (!lines.length) return { matched: 0 };
  const firstDay = lines[0].day;
  const lastDay = lines[lines.length - 1].day;
  const candidates = await unmatchedMovements(accountId, { from: addDays(firstDay, -settings.automaticDays), to: addDays(lastDay, settings.automaticDays), session });
  const taken = new Set();
  let matched = 0;
  const guess = await guesser(accountId);
  // Merchant credits need approval against their original purchase/refund document.
  const matchableLines = lines.filter(line => alipayReconciliation.walletReady(line) && !needsRefundReview(line, guess(line)));
  const compatible = (line, candidate) => candidate.amount === line.amount && dayDistance(candidate.day, line.day) <= settings.automaticDays
    && (line.sourceProvider !== 'alipay' || alipayReconciliation.exactMatch(line, candidate, accountId))
    && bankTransferHints.matchesMovement(line, guess(line), candidate);
  for (const line of matchableLines) {
    const eligible = candidates
      .filter((c) => !taken.has(String(c._id)) && compatible(line, c))
      .sort((a, b) => dayDistance(a.day, line.day) - dayDistance(b.day, line.day));
    let best;
    // Amount and proximity alone cannot choose between several plausible transactions.
    if (eligible.length !== 1) continue;
    // A single ledger movement must not be assigned arbitrarily between two statement rows.
    if (matchableLines.filter(other => compatible(other, eligible[0])).length !== 1) continue;
    for (const candidate of eligible) {
      try {
        await reserveMatchedEntries(accountId, [candidate._id], session);
        best = candidate;
        break;
      } catch (error) {
        if (!error.message.includes('just matched to another bank line')) throw error;
      }
    }
    if (!best) continue;
    taken.add(String(best._id));
    line.matchedEntryIds = [best._id];
    line.lineStatus = 'matched';
    await line.save({ session });
    matched++;
  }
  if (matched && lines.some(line => line.sourceProvider === 'alipay')) require('./alipayValuation').queue(session, accountId, req?.user);
  await logAudit({ req, action: 'bank.autoMatch', model: 'AccountingBankStatementLine', after: { accountId, matched } }, session);
  return { matched };
}

async function manualMatch(lineId, entryIds, { session, req }) {
  if (session?.inTransaction()) await require('../periodLock').lockPeriod(session);
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح للمطابقة');
  alipayReconciliation.assertWallet(line);
  const movements = await unmatchedMovements(line.accountId, { session });
  const chosen = movements.filter((m) => entryIds.map(String).includes(String(m._id)));
  if (chosen.length !== entryIds.length) throw fail('بعض القيود غير متاحة أو مطابقة مسبقاً');
  const semantic = bankTransferHints.describe(line, await bankAccount(line.accountId), [...(await getConfig()).accountsById.values()]);
  if (semantic?.semanticTransfer
    && !bankTransferHints.matchesMovement(line, semantic, { ledgerLines: chosen.flatMap(m => m.ledgerLines || []) }))
    throw fail('القيد المختار لا يحتوي الحساب المقابل الصحيح لهذه الحركة؛ راجع التحويل أو السداد الأصلي');
  if (line.sourceProvider === 'alipay' && chosen.some(m => String(m.bankSourceAccountId) === String(line.accountId)
    && m.bankSourceReference && m.bankSourceReference !== line.sourceTransactionId)) throw fail('رقم عملية Alipay في القيد يختلف عن رقم العملية في الكشف');
  const total = chosen.reduce((sum, m) => sum + m.amount, 0);
  if (total !== line.amount) throw fail('مجموع القيود المختارة لا يساوي مبلغ سطر الكشف');
  await reserveMatchedEntries(line.accountId, chosen.map((m) => m._id), session);
  line.matchedEntryIds = chosen.map((m) => m._id);
  line.lineStatus = 'matched';
  const orderRefund = await require('../../models/documents').CustomerRefund.findOne({ entryId: { $in: line.matchedEntryIds }, accountId: line.accountId, status: 'posted' }).session(session).lean();
  if (orderRefund) {
    const reconciled = await require('./refundBankValuation').reconcile(orderRefund._id, line, { session, req });
    line.valuationUsd = reconciled.usd / 100;
    line.customerRefundId = orderRefund._id; line.orderId = orderRefund.orderId; line.movementKind = 'purchase_refund';
  }
  const supplierReceipt = await require('../../models/documents').SupplierReceipt.findOne({ entryId: { $in: line.matchedEntryIds }, toAccountId: line.accountId, status: 'posted' }).session(session).lean();
  if (supplierReceipt) { line.receiptId = supplierReceipt._id; line.movementKind = 'purchase_refund'; }
  await line.save({ session });
  if (line.sourceProvider === 'alipay') require('./alipayValuation').queue(session, line.accountId, req?.user);
  await logAudit({ req, action: 'bank.match', model: 'AccountingBankStatementLine', docId: line._id, after: line }, session);
  return line;
}

// Entries already in the books that could be this very line (same amount, within a week)
async function possibleDuplicates(line, session) {
  const movements = await unmatchedMovements(line.accountId, { from: addDays(line.day, -DUPLICATE_DAYS), to: addDays(line.day, DUPLICATE_DAYS), session });
  return movements.filter((m) => m.amount === line.amount)
    .sort((a, b) => dayDistance(a.day, line.day) - dayDistance(b.day, line.day));
}

// ---- Linking a website purchase to its order ----

// "(107.73 US Dollar)" at the end of a card line: what was paid on the website, in its currency
function paidAbroad(line, bankCurrency) {
  return originalOf(line, bankCurrency);
}

// For each statement line: the purchase cost typed on an order that is the same payment (same
// amount and currency, bought within a week), preferring the closest date for review. Purchase costs already
// linked to another line are not offered again.
async function exactLinks(bank, lines) {
  const wanted = lines.map((line) => (line.amount < 0 ? paidAbroad(line, currencyOf(bank)) : null));
  const amounts = [...new Set(wanted.filter(Boolean).map((w) => w.amount))];
  if (!amounts.length) return lines.map(() => null);
  const [orders, used] = await Promise.all([
    Order.find({ 'purchaseItems.unitPrice': { $in: amounts }, isCanceled: { $ne: true } }).select('orderId placedAt purchaseItems').lean(),
    BankStatementLine.distinct('purchaseItemId', { purchaseItemId: { $ne: null }, lineStatus: 'created_entry' }),
  ]);
  const taken = new Set(used.map(String));
  const items = orders.flatMap((order) => (order.purchaseItems || []).map((item) => ({ order, item })));
  return lines.map((line, index) => {
    const want = wanted[index];
    if (!want) return null;
    const found = items.filter(({ item }) => !taken.has(String(item._id))
      && Math.abs(Number(item.unitPrice) - want.amount) < 0.005
      && (item.currency || 'USD') === want.currency
      && item.date && dayDistance(accountingDay(item.date), line.day) <= DUPLICATE_DAYS);
    if (!found.length) return null;
    found.sort((a, b) => dayDistance(accountingDay(a.item.date), line.day) - dayDistance(accountingDay(b.item.date), line.day)
      || String(a.item._id).localeCompare(String(b.item._id)));
    const { order, item } = found[0];
    taken.add(String(item._id));
    return { orderId: order._id, orderNumber: order.orderId, itemId: item._id, itemDescription: item.description, amount: want.amount, currency: want.currency,
      day: accountingDay(item.date), exactDayCandidates: found.filter(candidate => accountingDay(candidate.item.date) === line.day).length };
  });
}

// Exact matches first (amount and currency), then the near dollar ones
async function findLinks(bank, lines) {
  return findNearLinks(bank, lines, await exactLinks(bank, lines));
}

// Lines the exact match left alone: a dollar purchase typed on an order whose amount is within 2%
// of the line's dollars and bought within a week, preferring the closest date for review (spec 19.13)
const NEAR = 0.02;
async function findNearLinks(bank, lines, links) {
  const bankCurrency = currencyOf(bank);
  const wanted = lines.map((line, index) => {
    if (links[index] || line.amount >= 0) return null;
    const abroad = paidAbroad(line, bankCurrency);
    if (abroad.currency === 'USD') return Math.abs(abroad.amount);
    return null;
  });
  const values = wanted.filter(Boolean);
  if (!values.length) return links;
  const [orders, used] = await Promise.all([
    Order.find({ isCanceled: { $ne: true }, $or: values.map((v) => ({ 'purchaseItems.unitPrice': { $gte: v * (1 - NEAR), $lte: v * (1 + NEAR) } })) })
      .select('orderId placedAt purchaseItems').lean(),
    BankStatementLine.distinct('purchaseItemId', { purchaseItemId: { $ne: null }, lineStatus: 'created_entry' }),
  ]);
  const taken = new Set([...used.map(String), ...links.filter(Boolean).map((l) => String(l.itemId))]);
  const items = orders.flatMap((order) => (order.purchaseItems || []).filter((item) => !item.currency || item.currency === 'USD').map((item) => ({ order, item })));
  return links.map((link, index) => {
    const usd = wanted[index];
    if (link || !usd) return link;
    const line = lines[index];
    const found = items.filter(({ item }) => !taken.has(String(item._id))
      && Math.abs(Number(item.unitPrice) - usd) <= usd * NEAR
      && item.date && dayDistance(accountingDay(item.date), line.day) <= DUPLICATE_DAYS);
    if (!found.length) return null;
    found.sort((a, b) => dayDistance(accountingDay(a.item.date), line.day) - dayDistance(accountingDay(b.item.date), line.day)
      || Math.abs(Number(a.item.unitPrice) - usd) - Math.abs(Number(b.item.unitPrice) - usd)
      || String(a.item._id).localeCompare(String(b.item._id)));
    const { order, item } = found[0];
    taken.add(String(item._id));
    return { orderId: order._id, orderNumber: order.orderId, itemId: item._id, itemDescription: item.description, amount: Number(item.unitPrice), currency: 'USD', near: true, day: accountingDay(item.date) };
  });
}

// Where a linked purchase is posted. Normally on the order as a purchase cost; if the historical
// migration already recorded this purchase cost as paid from suspense, the line clears that
// suspense instead, so the cost is not counted twice.
async function linkTarget(link, session) {
  const order = await Order.findOne({ _id: link.orderId, 'purchaseItems._id': link.itemId }).select('orderId placedAt isCanceled').session(session || null).lean();
  if (!order) throw fail('المشتريات المرتبطة لم تعد موجودة في الطلب');
  if (await BankStatementLine.exists({ purchaseItemId: link.itemId, lineStatus: 'created_entry' }).session(session || null)) throw fail(`مشتريات الطلب ${order.orderId} مرتبطة بسطر كشف آخر`);
  const recorded = await SupplierBill.findOne({ idempotencyKey: `MIG:PURCH:${link.itemId}`, status: { $ne: 'canceled' } }).session(session || null).lean();
  if (recorded) {
    const suspense = await resolveAccount('migration_suspense');
    if (String(recorded.paidImmediatelyFrom) !== String(suspense._id)) throw fail(`مشتريات الطلب ${order.orderId} مسجلة مدفوعة من حساب آخر؛ راجعها قبل الربط`);
    return { account: suspense, orderId: null, itemId: link.itemId, office: order.placedAt };
  }
  return { account: await resolveAccount('purchase_cost_wip'), orderId: order._id, itemId: link.itemId, office: order.placedAt };
}

// A statement line with nothing in the books (fees, interest, a transfer...): post it against the
// chosen account. Refused while the books hold an unmatched entry that could be the same money,
// unless `confirmNotDuplicate` says it is not.
async function createEntryForLine(lineId, input, { session, req }) {
  if (input.link?.orderId && input.link?.itemId) {
    throw fail('اقتراح الطلبية يحتاج مراجعة واعتماد؛ اختر بند المشتريات من قائمة المطابقة لتتحقق العملة والمبلغ والتاريخ قبل الربط');
  }
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح');
  alipayReconciliation.assertWallet(line);
  if (line.sourceProvider === 'alipay' && line.amount > 0 && !isPurchaseRefund(line)) throw fail('وارد Alipay لا يُسجل إيرادًا تلقائيًا؛ سجّل شراء اليوان أو التحويل أو إيداع العميل من قسمه ثم طابق قيده مع الكشف');
  if (!input.pendingRefund && !input.confirmNotRefund && line.amount > 0 && needsRefundReview(line, (await guesser(line.accountId))(line))) throw fail('هذا السطر استرداد مشتريات؛ اربطه بريفاند الطلبية أو الفاتورة الأصلية، أو أكد أنه ليس استرداداً');
  if (!input.confirmNotDuplicate) {
    const twins = await possibleDuplicates(line, session);
    if (twins.length) {
      const error = new ErrorHandler(409, `قد يكون هذا السطر مسجلاً في الدفاتر: ${twins.slice(0, 3).map((t) => `${t.number} (${t.day})`).join('، ')}. طابقه معه بدل إنشاء قيد جديد، أو أكّد أنه مختلف.`);
      error.duplicates = twins.slice(0, 5).map((t) => ({ _id: t._id, number: t.number, day: t.day, description: t.description, amount: t.amount }));
      throw error;
    }
  }
  const bank = await bankAccount(line.accountId);
  const exchange = bankTransferHints.exchangeOf(line.description, currencyOf(bank), line.amount / 100);
  if (exchange && !exchange.error) Object.assign(line, exchange);
  const semantic = bankTransferHints.describe(line, bank, [...(await getConfig()).accountsById.values()]);
  if (semantic?.semanticTransfer) {
    if (input.target || input.link || input.billId || input.pendingRefund) throw fail('هذه حركة تحويل أو تسوية؛ لا تربطها كتكلفة شراء جديدة أو استرداد');
    if ((semantic.account && String(input.counterAccountId) !== String(semantic.account._id))
      || (!semantic.account && !['cash_deposit', 'investment_transfer'].includes(semantic.source))) throw fail(semantic.reason);
    if (semantic.source === 'investment_transfer') {
      const target = await getAccount(input.counterAccountId, 'حساب الاستثمار أو المشاركة');
      if (target.type !== 'asset') throw fail('شراء الصندوق أو فتح حساب المشاركة يحتاج حساب أصل، وليس مصروف مشتريات');
    }
    if (semantic.source === 'cash_deposit') {
      const source = await getAccount(input.counterAccountId, 'مصدر الإيداع النقدي');
      if (source.isCash ? !['cash', 'current'].includes(source.cashKind) : !['equity', 'liability'].includes(source.type))
        throw fail('اختر مصدر النقد الحقيقي: خزينة نقدية أو حساب تمويل المالك، وليس إيراد بيع أو حساب بنك آخر');
    }
  }
  if (input.pendingRefund) return require('./pendingRefund').post(line, { session, req });
  const rates = new RateBook(session, { nearest: true });
  const minor = Math.abs(line.amount);
  const label = input.description || line.description || 'حركة من كشف البنك';
  const outOfBank = line.amount < 0;

  // Match the original invoice currency before considering creation of another cost.
  const chosenCounter = input.counterAccountId && await Account.findById(input.counterAccountId).session(session).lean();
  const config = await getConfig();
  if (outOfBank && chosenCounter && !input.billId && !input.target && !input.link
    && config.count?.accountIds.has(String(bank._id))
    && (line.day < config.count.day || (line.day === config.count.day && config.count.endOfDay))
    && String(chosenCounter._id) === String((await resolveAccount('cost_purchase_invoices'))._id)) {
    // Before the count the purchase may already be a historical bill on its order (unpaid until its
    // real payment is matched): offer it. With none, a person may confirm it is a cost never recorded.
    const possible = await candidatesFor(line, bank, { session });
    if (possible.length) throw fail(`مشتريات قبل الجرد، وتوجد فاتورة محتملة (${possible.slice(0, 3).map((b) => b.number).join('، ')}): اختر «سداد مشتريات / تكلفة طلب على الفاتورة الأصلية» حتى لا تتكرر التكلفة`);
    if (!input.confirmBeforeCountPurchase) throw fail('مشتريات قبل الجرد: ابحث أولاً في «متابعة مشتريات الطلبيات». إن لم تكن مسجلة في أي فاتورة أو طلبية، أكّد أنها تكلفة جديدة قبل الجرد');
  }
  if (outOfBank && input.target && !input.confirmNewBill && (await candidatesFor(line, bank, { session })).length) {
    throw fail('توجد فاتورة أصلية محتملة؛ راجع المطابقة أو أكد أن هذه عملية جديدة قبل إنشاء تكلفة أخرى');
  }
  const existingBill = !semantic?.semanticTransfer && outOfBank && !input.target && !chosenCounter?.isCash
    ? await selectBill(line, bank, input, session) : null;
  if (existingBill) {
    const payables = require('./payables');
    let bill = await SupplierBill.findById(existingBill._id).session(session);
    await require('./bankMatchValidation').assertMerchant(line, bank, bill.vendorId, session, { confirmed: input.confirmMerchant === true, req });
    const billAmount = bill.total ?? bill.lines.reduce((s, l) => s + Number(l.amount), 0);
    const knownOriginal = originalOf(line, bank.currency);
    const value = await paymentValue(input.manualBillMatch && !line.originalCurrency && knownOriginal.currency === bank.currency
      ? { ...line.toObject(), originalAmount: billAmount, originalCurrency: bill.currency } : line, bank, input, session);
    if (input.manualBillMatch && !line.originalCurrency && knownOriginal.currency === bank.currency && value.valuationSource === 'statement') value.valuationSource = 'invoice';
    if (bill.status === 'draft') {
      if (bill.paidImmediatelyFrom) throw fail('الفاتورة المسودة محددة للدفع الفوري؛ راجعها قبل ربط كشف البنك');
      await payables.updateDraftBill(bill._id, { ...(bill.currency !== 'USD' && { rate: billAmount / value.usd }) }, { session, req });
      bill = await payables.postDraftBill(bill._id, { session, req });
    }
    const open = await payables.apBalance(payables.billKey(bill._id), session);
    if (open <= 0) throw fail('الفاتورة الأصلية مسددة بالفعل؛ طابق قيد سدادها مع الكشف ولا تنشئ فاتورة أخرى');
    if (open !== bill.totalUsd) throw fail('الفاتورة مسددة جزئياً؛ خصص هذه الدفعة من شاشة دفعات الموردين ثم طابق قيدها');
    const attempts = await require('../../models/documents').SupplierPayment.countDocuments({ idempotencyKey: new RegExp(`^BANK_EXISTING_PAY:${line._id}:`) }).session(session);
    const payment = await payables.createPayment({ vendorId: bill.vendorId, day: line.day, fromAccountId: bank._id, amount: value.paid, rate: value.rate,
      differenceTo: 'cost', allocations: [{ billId: bill._id, amountUsd: open }], idempotencyKey: `BANK_EXISTING_PAY:${line._id}:${attempts}`,
      note: `سداد الفاتورة الأصلية ${bill.number} من كشف ${bank.name}` }, { session, req });
    await bankMerchants.learn(line, bill.vendorId, bill.lines.length === 1 ? bill.lines[0].accountId : null, session);
    await value.rates.lock();
    const orderIds = [...new Set(bill.lines.filter(l => l.orderId).map(l => String(l.orderId)))];
    Object.assign(line, { entryId: payment.entryId, billId: bill._id, paymentId: payment._id, billCreatedFromStatement: false,
      ...(orderIds.length === 1 && { orderId: orderIds[0] }),
      ...(input.manualBillMatch && { matchedOriginalAmount: billAmount, matchedOriginalCurrency: bill.currency, matchDifferenceConfirmed: !!input.confirmDifference }),
      lineStatus: 'created_entry', ...(value.valuationSource === 'statement' ? { settlementUsd: value.usd } : {}), exchangeRate: value.rate, valuationSource: value.valuationSource,
      crossRate: value.crossRate, rateBaseCurrency: value.baseCurrency, rateQuoteCurrency: value.quoteCurrency, valuationUsd: value.usd });
    await line.save({ session });
    if (value.rates.fallbacks.length) await JournalEntry.updateOne({ _id: payment.entryId }, { $addToSet: { fallbacks: { $each: value.rates.fallbacks } } }, { session });
    await logAudit({ req, action: 'bank.payExistingBill', model: 'AccountingBankStatementLine', docId: line._id, after: { billId: bill._id, paymentId: payment._id } }, session);
    return line;
  }

  const vendorHint = (await bankMerchants.matcher(bank._id, session))(line);
  if (outOfBank && vendorHint?.bankPurpose === 'yuan_purchase') throw fail('هذه دفعة لشراء اليوان؛ سجّلها من صفحة Alipay ثم طابق قيدها مع الكشف، ولا تنشئ تكلفة مشتريات ثانية');

  // A line of a partner's current account (Aswaq, a funder...) or a bank that paid for a trip, an
  // order or a customer (spec 19.4): a supplier bill on the trip or order paid from this account,
  // or a debt on the customer whose money came from it
  if (['trip', 'order', 'debt'].includes(input.target)) return postToTarget(line, bank, { ...input, label }, { session, req });

  // Linked to the purchase cost typed on an order: the cost goes on that order
  const link = input.link?.orderId && input.link?.itemId ? await linkTarget(input.link, session) : null;
  const counter = link ? link.account : await getAccount(input.counterAccountId, 'الحساب المقابل');
  if (counter.isGroup) throw fail('اختر حساباً تفصيلياً لا مجموعة');
  if (String(counter._id) === String(bank._id)) throw fail('الحساب المقابل هو نفس حساب الكشف');
  const office = link?.office || input.office || bank.office;
  if (counter.requires?.includes('office') && !(await officeExists(office))) throw fail('اختر المكتب');

  // A purchase or an expense paid from the bank: a supplier bill in dollars and its payment in
  // the bank's currency, at the rate of this very payment (lira paid / dollars bought)
  if (outOfBank && !counter.isCash && (counter.type === 'expense' || link?.orderId)) {
    const result = await postAsBill(line, bank, counter, link, { ...input, office, label }, { session, req });
    line.entryId = result.payment.entryId;
    line.billId = result.bill._id;
    line.paymentId = result.payment._id;
    line.billCreatedFromStatement = true;
    line.lineStatus = 'created_entry';
    if (link) { line.orderId = link.orderId; line.purchaseItemId = link.itemId; }
    await line.save({ session });
    if (link?.orderId) await require('../claims/sync').syncOrder(link.orderId, { session, user: req?.user });
    await rememberRule(line, bank, counter, input, req, session);
    await logAudit({ req, action: 'bank.createBill', model: 'AccountingBankStatementLine', docId: line._id, after: { billId: result.bill._id, paymentId: result.payment._id } }, session);
    return line;
  }

  let lines;
  const monetaryCounter = semantic?.semanticTransfer && ['investment_transfer', 'owner_loan'].includes(semantic.source);
  if (counter.isCash || monetaryCounter) {
    await lockPostingAccounts([bank, counter], session);
    if (monetaryCounter && currencyOf(counter) !== currencyOf(bank)) throw fail('حساب الاستثمار أو قرض المالك يجب أن يكون بنفس عملة الكشف');
    if (semantic?.source === 'owner_loan' && counter.type !== 'liability') throw fail('قرض عماد يحتاج حساب التزام، وليس إيراداً أو رأس مال');
    if (semantic?.source === 'owner_loan' && outOfBank) {
      const debt = await require('../carrying').getBalance(counter._id, { session, upToDay: line.day });
      const outstanding = currencyOf(counter) === 'USD' ? debt.usd : debt.foreign;
      if (outstanding >= 0 || minor > -outstanding) throw fail('قيمة رد قرض عماد أكبر من الدين المسجل؛ طابق السداد السابق أو سجّل أصل القرض أولاً');
    }
    // Money between two of the company's own accounts (the bank paying the card, dollars sold
    // for lira): each side moves its own amount, both at the value that left
    let counterMinor = minor;
    if (currencyOf(counter) !== currencyOf(bank)) {
      if (!(line.counterAmount > 0) || line.counterCurrency !== currencyOf(counter)) {
        throw fail(`الحسابان بعملتين مختلفتين ولا يذكر السطر المبلغ المقابل بـ${currencyOf(counter)}: سجّلها تحويلاً من شاشة الخزينة`);
      }
      counterMinor = await toCurrencyMinor(line.counterAmount, currencyOf(counter));
    }
    const source = outOfBank ? bank : counter, destination = outOfBank ? counter : bank;
    const sourceMinor = outOfBank ? minor : counterMinor, destinationMinor = outOfBank ? counterMinor : minor;
    let docRate;
    if (currencyOf(source) !== 'USD' && currencyOf(destination) === 'USD') {
      const { currencies } = await getConfig();
      docRate = (sourceMinor / 10 ** currencies.get(currencyOf(source)).decimals) / (destinationMinor / 100);
      line.exchangeRate = docRate;
    } else if (currencyOf(source) === 'USD' && currencyOf(destination) !== 'USD') {
      const { currencies } = await getConfig();
      line.exchangeRate = (destinationMinor / 10 ** currencies.get(currencyOf(destination)).decimals) / (sourceMinor / 100);
    }
    const sourceUsd = semantic?.source === 'owner_loan' && !outOfBank
      ? await rates.toUsd(sourceMinor, currencyOf(source), line.day)
      : await valueOut(source, sourceMinor, { day: line.day, rates, docRate });
    // Dollars received must be exactly their face amount, even when the sold lira had a
    // different carrying value. The difference belongs on the exchange account.
    let destinationUsd = currencyOf(destination) === 'USD' ? destinationMinor : sourceUsd;
    if (destination.type === 'liability' && currencyOf(destination) !== 'USD') {
      // Repaying a funded purchase/card closes the debt at its own carrying value.
      // Any difference from the bank's carrying value is FX, not another purchase cost.
      const debt = await require('../carrying').getBalance(destination._id, { session, ...(semantic?.source === 'owner_loan' && { upToDay: line.day }) });
      if (debt.foreign < 0) {
        const carried = require('../carrying').valueOutflow(debt, destinationMinor);
        if (carried !== null) destinationUsd = carried;
      }
    }
    lines = [moneyLine(destination, 'debit', destinationMinor, destinationUsd, { label }), moneyLine(source, 'credit', sourceMinor, sourceUsd, { label })];
    await addFxLine(lines, office);
  } else {
    const dims = { office, label, ...(link?.orderId ? { orderId: link.orderId } : {}) };
    if (counter.requires?.includes('vendor')) {
      // Kept on the vendor's own balance (its advance key), like a payment made to it in advance
      const name = vendorFor(input.vendorName, line, bank.name);
      if (!name) throw fail('اكتب اسم المورد');
      const vendor = await vendorNamed(name, session);
      Object.assign(dims, { vendorId: vendor._id, apKey: require('./payables').advanceKey(vendor._id) });
    }
    if (outOfBank) {
      const usd = await valueOut(bank, minor, { day: line.day, rates });
      lines = [{ accountId: counter._id, debit: usd, ...dims }, moneyLine(bank, 'credit', minor, usd, { label })];
    } else {
      const usd = await rates.toUsd(minor, currencyOf(bank), line.day);
      lines = [moneyLine(bank, 'debit', minor, usd, { label }), { accountId: counter._id, credit: usd, ...dims }];
    }
  }
  const entry = await postEntry({
    eventType: 'BANK_LINE', eventKey: `BANK_LINE:${line._id}${line.postingAttempt ? `:REPOST:${line.postingAttempt}` : ''}`, date: line.day, description: `${label} (كشف ${bank.name})`,
    source: { model: 'AccountingBankStatementLine', id: line._id }, fallbacks: rates.fallbacks, lines,
  }, { session, user: req?.user });
  await rates.lock();
  line.entryId = entry._id;
  line.lineStatus = 'created_entry';
  if (link) {
    line.orderId = link.orderId;
    line.purchaseItemId = link.itemId;
  }
  await line.save({ session });
  // The order's profit follows its costs (moved to cost of sales once its sale is recognised)
  if (link?.orderId) await require('../claims/sync').syncOrder(link.orderId, { session, user: req?.user });
  await rememberRule(line, bank, counter, input, req, session);
  await logAudit({ req, action: 'bank.createEntry', model: 'AccountingBankStatementLine', docId: line._id, after: { entryId: entry._id } }, session);
  return line;
}

// A statement line posted as a trip cost, an order cost, or a debt on a customer
async function postToTarget(line, bank, input, { session, req }) {
  if (line.amount > 0) throw fail('هذا السطر دخل إلى الحساب؛ التوجيه إلى رحلة أو طلب أو دين للمبالغ الخارجة فقط');
  if (input.target === 'debt') {
    const Balance = require('../../../models/balance');
    const User = require('../../../models/user');
    const currency = currencyOf(bank);
    if (!['USD', 'LYD'].includes(currency)) throw fail('الدين على العميل بالدولار أو الدينار فقط');
    if (!input.partnerId || !mongoose.isValidObjectId(input.partnerId) || !(await User.exists({ _id: input.partnerId }).session(session))) throw fail('اختر العميل');
    const { decimals } = (await getConfig()).currencies.get(currency) || { decimals: 2 };
    const amount = Math.abs(line.amount) / 10 ** decimals;
    const office = ['tripoli', 'benghazi'].includes(input.office || bank.office) ? (input.office || bank.office) : 'tripoli';
    const [balance] = await Balance.create([{
      owner: input.partnerId, createdBy: req?.user?._id, createdOffice: office, balanceType: 'debt', debtType: 'general',
      amount, initialAmount: amount, currency, status: 'open', notes: input.label,
      source: { kind: bank.cashKind === 'current' ? 'partner' : 'cash', accountId: bank._id }, createdAt: dayStartOf(line.day),
    }], { session });
    const operations = require('./operations');
    await operations.postGeneralDebt(balance._id, { session, user: req?.user });
    const entry = await JournalEntry.findOne({ eventKey: `GENERAL_DEBT:${balance._id}` }).session(session);
    line.entryId = entry._id;
    line.lineStatus = 'created_entry';
    await line.save({ session });
    await logAudit({ req, action: 'bank.createDebt', model: 'AccountingBankStatementLine', docId: line._id, after: { balanceId: balance._id, entryId: entry._id } }, session);
    return line;
  }
  const billTarget = input.target === 'trip' ? { target: 'trip', tripId: input.tripId } : { target: 'order', orderId: input.orderId };
  if (!billTarget.tripId && !billTarget.orderId) throw fail(input.target === 'trip' ? 'اختر الرحلة' : 'اختر الطلب');
  const result = await postAsBill(line, bank, null, null, { ...input, billTarget }, { session, req });
  line.entryId = result.payment.entryId;
  line.billId = result.bill._id;
  line.paymentId = result.payment._id;
  line.billCreatedFromStatement = true;
  line.lineStatus = 'created_entry';
  if (billTarget.orderId) line.orderId = billTarget.orderId;
  await line.save({ session });
  await logAudit({ req, action: 'bank.createBill', model: 'AccountingBankStatementLine', docId: line._id, after: { billId: result.bill._id, target: input.target } }, session);
  return line;
}

// "Always post this text here": the next statements are suggested (and posted in bulk) alone
async function rememberRule(line, bank, counter, input, req, session) {
  if (!input.remember || !String(input.keyword || '').trim()) return;
  await BankRule.create([{
    accountId: input.ruleForAllBanks ? null : bank._id, keyword: String(input.keyword).trim(), direction: line.amount < 0 ? 'out' : 'in',
    counterAccountId: counter._id, office: input.office || undefined, vendorName: input.vendorName || undefined, priority: 1, createdBy: req?.user?._id,
  }], { session });
}

// The vendor a rule names for one line: '@bank' is the bank itself; "{party:1414}" is the other
// client number on the line (Al Mutaheda prints "1414 // -1207": 1414 is the company, 1207 the
// supplier), so every client of the exchange office is its own vendor without a rule each
function vendorFor(template, line, bankName) {
  if (!template) return null;
  if (template === '@bank') return bankName || null;
  const slot = template.match(/\{party(?::(\d+))?\}/);
  if (!slot) return template;
  const party = (String(line.description || '').match(/\d{3,}/g) || []).find((code) => code !== slot[1]);
  return party ? template.replace(slot[0], party) : null;
}

// The vendor of a purchase: found by name, created the first time
async function vendorNamed(name, session) {
  const clean = String(name || '').trim().slice(0, 80) || 'مورد من كشف البنك';
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = await Vendor.findOne({ name: new RegExp(`^${escaped}$`, 'i') }).session(session);
  if (found) return found;
  const bankNameKey = normalize(clean);
  return Vendor.findOneAndUpdate({ bankNameKey }, { $setOnInsert: { name: clean, type: 'supplier', defaultCurrency: 'USD', bankNameKey } }, { upsert: true, new: true, session });
}

// The merchant written on a card line, without the country and the amount paid abroad
const merchantOf = (description) => String(description || '').replace(/\(.*\)\s*$/, '')
  .replace(/[\d.,]+\s*[A-Z]{3}\s*$/, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');

// Bill (in dollars) + payment (in the bank's currency) for one statement line
async function postAsBill(line, bank, counter, link, input, { session, req }) {
  const payables = require('./payables');
  const { currencies } = await getConfig();
  const bankCurrency = currencyOf(bank);
  const value = await paymentValue(line, bank, input, session);
  const { paid, usd, rate } = value;
  // The dollars bought: printed on the line, or the line itself on a dollar account, or the
  // bank's amount at the day's rate when the line gives nothing else
  const abroad = value.original;
  // A line cancelled and posted again gets a new bill and payment
  const attempt = await SupplierBill.countDocuments({ idempotencyKey: new RegExp(`^BANK_LINE_BILL:${line._id}`) }).session(session);
  const suffix = attempt ? `:${attempt}` : '';

  const knownMerchant = (await bankMerchants.matcher(bank._id, session))(line);
  const vendor = await vendorNamed(vendorFor(input.vendorName, line, bank.name) || knownMerchant?.vendorName || merchantOf(line.description), session);
  const description = input.label || line.description;
  // Bought in another currency (KWD, OMR, EUR...): the bill is in that currency at the rate the
  // bank's dollars give (original ÷ dollars), so it reads like the supplier's invoice (spec 19.13)
  if (!currencies.has(abroad.currency)) throw fail(`العملة الأصلية ${abroad.currency} غير معرّفة`);
  const original = abroad.currency !== 'USD' && Math.abs(abroad.amount) > 0
    ? { currency: abroad.currency, amount: Math.abs(abroad.amount), rate: Math.abs(abroad.amount) / usd }
    : null;
  const billAmount = original ? original.amount : usd;
  const billLine = input.billTarget
    ? { description, amount: billAmount, ...input.billTarget }
    : link?.orderId
    ? { description, amount: billAmount, target: 'order', orderId: link.orderId, purchaseItemId: link.itemId }
    : { description, amount: billAmount, target: 'expense', accountId: counter._id, office: input.office };
  const duplicateInput = { vendorId: vendor._id, day: line.day, currency: original ? original.currency : 'USD', vendorRef: line.reference || undefined, vendorRefKind: 'bank', lines: [billLine] };
  const duplicatePreview = input.confirmNewBill ? await require('../costDuplicates').preview(duplicateInput, { session }) : null;
  const bill = await payables.createBill({
    vendorId: vendor._id, day: line.day, currency: original ? original.currency : 'USD', ...(original && { rate: original.rate }), vendorRef: line.reference || undefined,
    vendorRefKind: 'bank',
    note: `من كشف ${bank.name}، دُفعت ${paid} ${bankCurrency} مقابل ${abroad.amount} ${abroad.currency} بسعر مباشر ${value.crossRate.toFixed(6)} ${bankCurrency}/${abroad.currency}`,
    idempotencyKey: `BANK_LINE_BILL:${line._id}${suffix}`, lines: [billLine],
    duplicateDecision: input.duplicateDecision, duplicateReason: input.duplicateReason, duplicateFingerprint: input.duplicateFingerprint,
    ...(!input.duplicateDecision && duplicatePreview?.results.length ? { duplicateDecision: 'independent', duplicateFingerprint: duplicatePreview.fingerprint,
      duplicateReason: `أكد المستخدم أن حركة الكشف ${line.description} عملية جديدة مستقلة عن الفواتير المقترحة` } : {}),
  }, { session, req });
  await bankMerchants.learn(line, vendor._id, counter?._id, session);
  const payment = await payables.createPayment({
    vendorId: vendor._id, day: line.day, fromAccountId: bank._id, amount: paid, rate,
    allocations: [{ billId: bill._id, amountUsd: bill.totalUsd }],
    idempotencyKey: `BANK_LINE_PAY:${line._id}${suffix}`, note: `سداد ${bill.number} من كشف ${bank.name}`,
  }, { session, req });
  await value.rates.lock();
  if (value.valuationSource === 'statement') line.settlementUsd = usd;
  line.exchangeRate = rate;
  line.valuationSource = value.valuationSource;
  line.crossRate = value.crossRate;
  line.rateBaseCurrency = value.baseCurrency;
  line.rateQuoteCurrency = value.quoteCurrency;
  line.valuationUsd = usd;
  if (value.rates.fallbacks.length) await JournalEntry.updateOne({ _id: payment.entryId }, { $addToSet: { fallbacks: { $each: value.rates.fallbacks } } }, { session });
  return { bill, payment };
}

// Undoes an entry created from a statement line: the entry is reversed, the line is unmatched again
async function cancelLineEntry(lineId, { session, req, reason }) {
  const { reverseSourceEntries } = require('../cancel');
  const line = await BankStatementLine.findById(lineId).session(session);
  if (line?.tripCostSettlementId) throw fail('هذا السطر ضمن تسوية جماعية؛ ألغِ التسوية كاملة من تكاليف الرحلات');
  if (!line || line.lineStatus !== 'created_entry') throw fail('لا يوجد قيد لهذا السطر');
  if (!String(reason || '').trim()) throw fail('سبب الإلغاء مطلوب');
  const previousEntryIds = [line.entryId].filter(Boolean);
  const others = line.paymentId ? await BankStatementLine.countDocuments({ billId: line.billId, lineStatus: 'created_entry', _id: { $ne: line._id } }).session(session) : 0;
  const willCancelBill = !!line.paymentId && !others && line.billCreatedFromStatement !== false;
  const reversedEntryIds = [...previousEntryIds];
  if (line.billId) {
    const previousBill = await SupplierBill.findById(line.billId).select('entryId').session(session).lean();
    if (previousBill?.entryId) {
      previousEntryIds.push(previousBill.entryId);
      if (willCancelBill) reversedEntryIds.push(previousBill.entryId);
    }
  }
  if (line.creditNoteId) {
    const credit = await SupplierBill.findById(line.creditNoteId).select('entryId').session(session).lean();
    if (credit?.entryId) { previousEntryIds.push(credit.entryId); reversedEntryIds.push(credit.entryId); }
  }
  // Another statement account may have matched this same transfer. Require that
  // match to be released before reversing its journal, rather than leave it stale.
  if (await BankStatementLine.exists({ _id: { $ne: line._id }, lineStatus: 'matched', matchedEntryIds: { $in: reversedEntryIds } }).session(session)) {
    throw fail('القيد مرتبط بسطر كشف آخر؛ فك مطابقته أولاً ثم صحح هذا السطر');
  }
  if (line.customerRefundId) {
    await require('../cancel').cancelDocument('AccountingCustomerRefund', line.customerRefundId, { session, req, reason, fromBankLineId: line._id });
    if (line.pendingRefundAccountId) await reverseSourceEntries('AccountingBankStatementLine', line._id, { session, user: req?.user, reason });
    line.customerRefundId = undefined;
    line.billId = undefined;
  } else if (line.receiptId) {
    await require('../cancel').cancelDocument('AccountingSupplierReceipt', line.receiptId, { session, req, reason, fromBankLineId: line._id });
    if (line.refundCreditCreated && line.creditNoteId) await require('../cancel').cancelDocument('AccountingSupplierBill', line.creditNoteId, { session, req, reason });
    line.receiptId = undefined; line.creditNoteId = undefined; line.billId = undefined;
  } else if (line.paymentId) {
    const { cancelDocument } = require('../cancel');
    await cancelDocument('AccountingSupplierPayment', line.paymentId, { session, req, reason });
    // Several lines paying one purchase (a grouped link): the bill goes with the last of them
    if (willCancelBill) await cancelDocument('AccountingSupplierBill', line.billId, { session, req, reason });
    line.paymentId = undefined;
    line.billId = undefined;
    line.customerRefundId = undefined;
    line.receiptId = undefined;
    line.creditNoteId = undefined;
  } else if ((await JournalEntry.findById(line.entryId).select('source').session(session).lean())?.source?.model === 'Balance') {
    // A debt made from this line: undone while nothing was paid on it
    const Balance = require('../../../models/balance');
    const entry = await JournalEntry.findById(line.entryId).select('source').session(session).lean();
    const balance = await Balance.findById(entry.source.id).session(session);
    if (balance && (balance.paymentHistory || []).length) throw fail('دُفع جزء من هذا الدين؛ احذف دفعاته أولاً');
    await reverseSourceEntries('Balance', entry.source.id, { session, user: req?.user, reason });
    if (balance) await Balance.deleteOne({ _id: balance._id }, { session });
  } else {
    await reverseSourceEntries('AccountingBankStatementLine', line._id, { session, user: req?.user, reason });
  }
  line.lineStatus = 'unmatched';
  line.pendingRefund = false; line.pendingRefundAccountId = undefined;
  // Parking and the owner's decision (both entries of this line) were reversed above
  line.unidentified = undefined;
  line.historicalPurchase = false; line.historicalCovered = false;
  if (line.historicalSettlementPaymentId) {
    line.historicalSettlementPaymentId = undefined; line.historicalSettlementUsd = undefined; line.billId = undefined;
  }
  line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...previousEntryIds.map(String)])];
  line.postingAttempt = (line.postingAttempt || 0) + 1;
  line.entryId = undefined;
  line.orderId = undefined;
  line.purchaseItemId = undefined;
  line.matchedOriginalAmount = undefined;
  line.matchedOriginalCurrency = undefined;
  line.matchDifferenceConfirmed = undefined;
  await line.save({ session });
  await logAudit({ req, action: 'bank.cancelEntry', model: 'AccountingBankStatementLine', docId: line._id, after: { reason, entryIds: previousEntryIds } }, session);
  return line;
}

async function setIgnored(lineId, ignored, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line) throw fail('سطر الكشف غير موجود');
  if (ignored && line.lineStatus !== 'unmatched') throw fail('السطر مطابق مسبقاً');
  if (!ignored && line.lineStatus === 'created_entry') throw fail('لهذا السطر قيد؛ ألغِ القيد من شاشة القيود');
  if (!ignored && line.lineStatus === 'matched') {
    await releaseMatchedEntries(line.accountId, line.matchedEntryIds, session);
    // A difference booked when it was matched to a partner's deposits goes with the match
    const own = await JournalEntry.countDocuments({ 'source.model': 'AccountingBankStatementLine', 'source.id': line._id, status: 'posted' }).session(session);
    if (own) {
      await require('../cancel').reverseSourceEntries('AccountingBankStatementLine', line._id, { session, user: req?.user, reason: 'فك المطابقة' });
      line.postingAttempt = (line.postingAttempt || 0) + 1;
    }
    line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...line.matchedEntryIds.map(String)])];
    line.billId = undefined;
    line.paymentId = undefined;
    line.historicalCovered = false;
    line.orderId = undefined;
    line.customerRefundId = undefined;
    line.receiptId = undefined;
    line.creditNoteId = undefined;
    line.purchaseItemId = undefined;
    line.matchedOriginalAmount = undefined;
    line.matchedOriginalCurrency = undefined;
    line.matchDifferenceConfirmed = undefined;
  }
  line.lineStatus = ignored ? 'ignored' : 'unmatched';
  const groupPayments = !ignored ? [...(line.groupPaymentIds || [])] : [];
  if (!ignored) { line.matchedEntryIds = []; line.partnerStatementIds = []; line.coveredNote = undefined; line.groupPaymentIds = []; }
  await line.save({ session });
  // The payments it made for a partner's Alipay transfers go with it: the bills are unpaid again
  for (const paymentId of groupPayments) {
    await require('../cancel').cancelDocument('AccountingSupplierPayment', paymentId, { session, req, reason: 'فك مطابقة حوالات الشريك' });
  }
  if (groupPayments.length) { line.postingAttempt = (line.postingAttempt || 0) + 1; await line.save({ session }); }
  await logAudit({ req, action: ignored ? 'bank.ignore' : 'bank.unmatch', model: 'AccountingBankStatementLine', docId: line._id, after: { reason: req?.body?.reason } }, session);
  return line;
}

// Which months each paying account has a statement for (banks, cards, Alipay, partners' current
// accounts). With purchase costs taken from statements, a missing month is a missing cost.
async function coverage({ from, to } = {}) {
  const { today, addDays: add } = require('../dates');
  const end = isDay(to) ? to : today();
  const start = isDay(from) ? from : `${end.slice(0, 4)}-01-01`;
  const months = [];
  for (let m = start.slice(0, 7); m <= end.slice(0, 7); m = add(`${m}-01`, 32).slice(0, 7)) months.push(m);
  const accounts = await Account.find({ isCash: true, isActive: true, isGroup: { $ne: true }, cashKind: { $in: ['bank', 'ewallet', 'current'] } })
    .select('code name currency cashKind').sort({ code: 1 }).lean();
  const rows = await BankStatementLine.aggregate([
    { $match: { accountId: { $in: accounts.map((a) => a._id) }, day: { $gte: start, $lte: end } } },
    { $group: { _id: { accountId: '$accountId', month: { $substrBytes: ['$day', 0, 7] } }, lines: { $sum: 1 } } },
  ]);
  const last = await BankStatementLine.aggregate([{ $match: { accountId: { $in: accounts.map((a) => a._id) } } }, { $group: { _id: '$accountId', day: { $max: '$day' } } }]);
  const lastBy = new Map(last.map((l) => [String(l._id), l.day]));
  return {
    months,
    accounts: accounts.map((a) => {
      const byMonth = Object.fromEntries(months.map((m) => [m, rows.find((r) => String(r._id.accountId) === String(a._id) && r._id.month === m)?.lines || 0]));
      return { _id: a._id, code: a.code, name: a.name, currency: a.currency, kind: a.cashKind, lastDay: lastBy.get(String(a._id)) || null,
        months: byMonth, missing: months.filter((m) => !byMonth[m]) };
    }),
  };
}

// A line dated before the count on a counted account: the counted balance already holds it (a
// transfer between two counted boxes, for instance), so it is closed with its reason and no entry
async function coverBeforeCount(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح');
  const { count } = await getConfig();
  const before = count && (line.day < count.day || (line.day === count.day && count.endOfDay));
  if (!before || !count.accountIds.has(String(line.accountId))) throw fail('هذا السطر ليس قبل جرد هذا الحساب؛ رحّله أو طابقه');
  const note = String(input.note || '').trim();
  if (!note) throw fail('اكتب ما كانت هذه الحركة');
  Object.assign(line, { lineStatus: 'ignored', coveredNote: note });
  await line.save({ session });
  await logAudit({ req, action: 'bank.coverBeforeCount', model: 'AccountingBankStatementLine', docId: line._id, after: { note } }, session);
  return line;
}

// Removes a line imported by mistake. Only a line with nothing in the books behind it; a later file
// holding the same line imports it again.
async function deleteLine(lineId, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line) throw fail('سطر الكشف غير موجود');
  if (line.lineStatus === 'created_entry') throw fail('لهذا السطر قيد؛ ألغِ القيد أولاً ثم احذفه');
  if (line.lineStatus === 'matched') await releaseMatchedEntries(line.accountId, line.matchedEntryIds, session);
  await BankStatementLine.deleteOne({ _id: line._id }, { session });
  await logAudit({ req, action: 'bank.lineDelete', model: 'AccountingBankStatementLine', docId: line._id, before: line }, session);
  return { deleted: true };
}

// ---- Where each line goes ----

// For every unmatched line: the account it most likely belongs to. A rule whose keyword is in the
// text wins; otherwise the account the same text was posted to last time; otherwise nothing.
// Also flags the lines that may already be in the books.
async function suggestions(accountId, { lineIds, matchingSettings } = {}) {
  const settings = preferences(matchingSettings);
  const lines = await BankStatementLine.find({ accountId, lineStatus: 'unmatched', ...(lineIds && { _id: { $in: lineIds } }) }).lean();
  if (!lines.length) return {};
  const guess = await guesser(accountId, settings);
  const safetyGuess = settings.engines.includes('classification') && settings.engines.includes('history') ? guess : await guesser(accountId);
  const links = await findLinks(await bankAccount(accountId), lines);
  const tripHints = await require('./bankTripCostHints').hints(lines, await bankAccount(accountId), settings, safetyGuess);
  const wip = await resolveAccount('purchase_cost_wip');
  const movements = await unmatchedMovements(accountId);
  const result = {};
  for (const [index, line] of lines.entries()) {
    if (!alipayReconciliation.walletReady(line)) {
      result[line._id] = { account: null, requiresConfirmation: true, source: 'alipay', isRefund: isPurchaseRefund(line), reason: line.sourceReviewReason, duplicates: [] };
      continue;
    }
    if (line.sourceProvider === 'alipay' && line.amount > 0 && !isPurchaseRefund(line)) {
      const twins = movements.filter(m => m.amount === line.amount && dayDistance(m.day, line.day) <= DUPLICATE_DAYS);
      result[line._id] = { account: null, requiresConfirmation: true, source: 'alipay', reason: 'شراء يوان أو تحويل أو إيداع؛ طابق القيد الموجود أو سجل العملية من قسمها ثم طابقها',
        duplicates: twins.map(t => ({ _id: t._id, number: t.number, day: t.day, description: t.description })) };
      continue;
    }
    const twins = movements.filter((m) => m.amount === line.amount && dayDistance(m.day, line.day) <= DUPLICATE_DAYS);
    const link = settings.engines.includes('purchases') && !settings.requireIdentity && links[index] && dayDistance(links[index].day, line.day) <= settings.proposalDays ? links[index] : null;
    const billHint = guess(line).semanticTransfer || !settings.engines.includes('purchases') ? null : await existingBillHint(line, await bankAccount(accountId), guess(line).vendorName, settings);
    result[line._id] = {
      ...(guess(line).semanticTransfer ? guess(line) : billHint || (link ? { account: { _id: wip._id, code: wip.code, name: wip.name }, office: null, source: 'order', keyword: null, link,
        requiresConfirmation: true, reason: 'اقتراح بالمبلغ والعملة وقرب التاريخ فقط؛ راجع هوية المورد والطلبية من قائمة المطابقة قبل الاعتماد.' } : guess(line))),
      duplicates: twins.map((t) => ({ _id: t._id, number: t.number, day: t.day, description: t.description })),
    };
    if (needsRefundReview(line, safetyGuess(line))) Object.assign(result[line._id], {
      ...guess(line), isRefund: true, source: 'refund', requiresConfirmation: true, refundAccount: guess(line).account, account: null, link: null,
      reason: 'مبلغ وارد من مورد مشتريات؛ راجع الفاتورة أو الريفاند الأصلي قبل الاعتماد',
    });
    result[line._id] = permittedHint(result[line._id], settings);
    result[line._id].tripCandidates = tripHints[index];
    const hint = result[line._id];
    if (hint.tripCandidates.length) Object.assign(hint, { account: null, requiresConfirmation: true });
    const sameDayLedger = twins.filter(m => m.day === line.day && bankTransferHints.matchesMovement(line, guess(line), m)
      && (line.sourceProvider !== 'alipay' || alipayReconciliation.exactMatch(line, m, accountId)));
    if (settings.engines.includes('ledger') && !hint.isRefund && sameDayLedger.length === 1) hint.exactMatch = { kind: 'ledger', entryId: sameDayLedger[0]._id };
    if (!hint.tripCandidates.length && !hint.isRefund && !guess(line).semanticTransfer && line.amount < 0 && !twins.length) {
      const exactBills = (hint.billCandidates || []).filter(b => b.day === line.day);
      const identity = guess(line).vendorId;
      if (exactBills.length === 1 && (!identity || String(identity) === String(exactBills[0].vendorId)))
        hint.exactMatch = { kind: 'bill', billId: exactBills[0]._id };
      else if (!hint.billCandidates?.length && link?.day === line.day && link.exactDayCandidates === 1)
        hint.exactMatch = { kind: 'order_item', orderId: link.orderId, itemId: link.itemId };
    }
  }
  // Two statement rows competing for one proposal need an individual review.
  const targets = new Map();
  const competingRows = new Map();
  for (const line of lines) {
    const key = `${line.day}:${line.amount}`;
    competingRows.set(key, (competingRows.get(key) || 0) + 1);
  }
  for (const hint of Object.values(result)) if (hint.exactMatch) {
    const choice = hint.exactMatch, key = String(choice.entryId || choice.billId || choice.itemId);
    targets.set(key, (targets.get(key) || 0) + 1);
  }
  for (const hint of Object.values(result)) if (hint.exactMatch && targets.get(String(hint.exactMatch.entryId || hint.exactMatch.billId || hint.exactMatch.itemId)) > 1) delete hint.exactMatch;
  for (const line of lines) if (competingRows.get(`${line.day}:${line.amount}`) > 1) delete result[line._id].exactMatch;
  return result;
}

async function existingBillHint(line, bank, vendorName, settings = preferences()) {
  const candidates = (await candidatesFor(line, bank, { vendorName })).filter(b => b.dayDifference <= settings.proposalDays && (!settings.requireIdentity || b.identified));
  if (!candidates.length) return null;
  const bill = candidates[0];
  return { source: 'bill', billId: null, suggestedBillId: bill?._id || null, requiresConfirmation: true, billCandidates: candidates.map(briefBill),
    account: null,
    vendorName: bill?.vendorId?.name || null, office: null };
}

// Where a statement line goes: a rule whose keyword is in its text, else the account the same
// text was posted to last time, else nothing
async function guesser(accountId, settings = preferences()) {
  const sourceBank = await bankAccount(accountId);
  const bankName = sourceBank.name || '';
  const [rules, history] = await Promise.all([
    BankRule.find({ $or: [{ accountId }, { accountId: null }] }).populate('counterAccountId', 'code name isActive').lean(),
    BankStatementLine.find({ accountId, lineStatus: 'created_entry' }).sort({ updatedAt: -1 }).limit(500).populate('entryId', 'lines').populate('billId', 'lines').lean(),
  ]);
  const learned = new Map();
  const merchant = await bankMerchants.matcher(accountId);
  const merchantAccounts = new Map((await Account.find({ isActive: true, isGroup: { $ne: true } }).select('code seedKey name currency type isCash cashKind office isActive').lean()).map(a => [String(a._id), a]));
  const purchaseAccount = [...merchantAccounts.values()].find(a => a.code === '510400');
  const serviceRoleId = (await getConfig()).settings?.accountRoles?.cost_services;
  const serviceAccount = serviceRoleId && merchantAccounts.get(String(serviceRoleId));
  history.forEach((old) => {
    const key = normalize(old.description);
    if (!key || learned.has(key) || !old.entryId) return;
    if (old.billId) {
      // A bill payment debits payable; learn the original expense rather than payable.
      const costs = old.billId.lines || [];
      const costAccounts = new Set(costs.map(l => l.accountId && String(l.accountId)));
      const costOffices = new Set(costs.map(l => l.office).filter(Boolean));
      if (costs.length && costs.every(l => l.target === 'expense' && l.accountId) && costAccounts.size === 1 && costOffices.size <= 1) {
        learned.set(key, { accountId: costs[0].accountId, office: costs[0].office });
      }
      return;
    }
    const other = (old.entryId.lines || []).find((l) => String(l.accountId) !== String(accountId));
    if (other) learned.set(key, { accountId: other.accountId, office: other.office });
  });
  const learnedAccounts = new Map((await Account.find({ _id: { $in: [...learned.values()].map((v) => v.accountId) }, isActive: true }).select('code name').lean()).map((a) => [String(a._id), a]));

  return (line) => {
    const transferHint = bankTransferHints.describe(line, sourceBank, [...merchantAccounts.values()]);
    if (transferHint) return { ...transferHint, vendorName: transferHint.vendorName || null, vendorId: transferHint.vendorId || null, office: transferHint.office || sourceBank.office || null };
    const identified = merchant(line);
    if (identified?.bankPurpose === 'yuan_purchase') return { ...identified, account: null, office: null,
      source: 'yuan', requiresConfirmation: true, reason: 'شراء يوان من AlQFILA؛ سجّل شراء اليوان من صفحة Alipay ثم طابق قيده مع الكشف. ليست تكلفة بضائع.' };
    if (identified?.bankPurpose === 'china_services') {
      const serviceAccount = [...merchantAccounts.values()].find(a => a.code === (identified.bankAccountCode || '531700'));
      return { ...identified, account: serviceAccount || null, office: identified.bankOffice || 'china', source: 'service',
        reason: 'خدمات الصين: زيارة مصنع أو إرسال شاحنة. إذا وجدت فاتورة مرتبطة تُستخدم بدل إنشاء تكلفة جديدة.' };
    }
    const text = normalize(`${line.description} ${line.reference || ''}`);
    if (settings.engines.includes('classification') && line.amount < 0 && /خدمية|خدميه|service\s*invoice/i.test(text)) {
      return { account: serviceAccount || null, office: sourceBank.office || null, source: 'service_invoice',
        reason: 'فاتورة خدمية: تكلفة خدمات مستقلة عن سعر بيع الخدمة للعميل. راجع الفاتورة الموجودة قبل إنشاء تكلفة جديدة.', vendorName: bankName };
    }
    const direction = line.amount < 0 ? 'out' : 'in';
    const rule = (settings.engines.includes('classification') ? rules : [])
      .filter((r) => r.counterAccountId?.isActive && (r.direction === 'any' || r.direction === direction) && hasKeyword(text, r.keyword))
      // A rule for this bank before one for all banks, then the higher priority (a country or a
      // word like "limited" is a weak hint), then the longest keyword
      .sort((a, b) => Number(!!b.accountId) - Number(!!a.accountId) || (b.priority || 0) - (a.priority || 0) || b.keyword.length - a.keyword.length)[0];
    // What was learned for this merchant (a person approved it) comes before a general keyword rule;
    // when both say the same account, the rule is shown, since it names the keyword
    const learnedFirst = settings.engines.includes('history') && identified?.learned && !(rule && String(rule.counterAccountId._id) === String(identified.counterAccountId));
    const past = settings.engines.includes('history') && !rule && learned.get(normalize(line.description));
    const pastAccount = past && learnedAccounts.get(String(past.accountId));
    const purchaseLike = line.amount < 0 && line.movementKind !== 'card_payment'
      && !/transfer|withdraw|top.?up|currency exchange|d[oö]viz|换汇|转账|转出|提现|充值/i.test(text) && (line.movementKind === 'purchase' || Number(line.originalAmount) > 0
      || /purchase|shopping|\bpos\b/i.test(text)
      || (line.sourceProvider === 'alipay' && !/转账|转出|提现|充值|手续费|transfer|withdraw|top.?up/i.test(text)));
    return {
      vendorType: identified?.vendorType,
      vendorId: identified?.vendorId || null,
      vendorName: identified?.vendorName || vendorFor(rule?.vendorName, line, bankName),
      account: learnedFirst ? merchantAccounts.get(String(identified.counterAccountId)) || purchaseAccount || null
        : rule ? { _id: rule.counterAccountId._id, code: rule.counterAccountId.code, name: rule.counterAccountId.name } : pastAccount || (identified && purchaseAccount) || (purchaseLike && purchaseAccount) || null,
      office: rule?.office || (pastAccount && past.office) || null,
      source: learnedFirst ? 'history' : rule ? 'rule' : pastAccount ? 'history' : identified ? 'vendor' : purchaseLike ? 'purchase_default' : null,
      reason: !rule && !pastAccount && !identified && purchaseLike ? 'مشتريات غير مرتبطة بفاتورة مورد؛ المقترح تكلفة شراء. راجع المطابقة قبل إنشاء تكلفة جديدة.' : null,
      keyword: rule?.keyword || null,
    };
  };
}

// The table shown before importing: for every row of the file, whether it was imported before,
// whether the books already hold it (it will be matched, or may be a duplicate), and the
// account it would go to. Nothing is saved.
async function classifyRows(accountId, rows, matchingSettings) {
  const settings = preferences(matchingSettings);
  const account = await bankAccount(accountId);
  const docs = await toDocs(account, rows);
  const known = await knownFingerprints(account._id, docs.map(d => d.fingerprint), null, docs);
  const days = docs.map((d) => d.day).sort();
  const movements = await unmatchedMovements(accountId, { from: addDays(days[0], -DUPLICATE_DAYS), to: addDays(days[days.length - 1], DUPLICATE_DAYS) });
  const guess = await guesser(accountId, settings);
  const safetyGuess = settings.engines.includes('classification') && settings.engines.includes('history') ? guess : await guesser(accountId);
  const links = await findLinks(account, docs);
  const tripHints = await require('./bankTripCostHints').hints(docs, account, settings, safetyGuess);
  const wip = await resolveAccount('purchase_cost_wip');
  const { accountsById } = await getConfig();
  const taken = new Set();
  return Promise.all(docs.map(async (doc, index) => {
    if (known.has(doc.fingerprint)) return { status: 'imported' };
    if (!alipayReconciliation.walletReady(doc)) return { status: 'new', account: null, isRefund: isPurchaseRefund(doc), requiresConfirmation: true, source: 'alipay', reason: doc.sourceReviewReason };
    const near = movements.filter((m) => !taken.has(String(m._id)) && m.amount === doc.amount)
      .sort((a, b) => dayDistance(a.day, doc.day) - dayDistance(b.day, doc.day));
    const identifiedRefund = needsRefundReview(doc, safetyGuess(doc));
    const eligible = !identifiedRefund && settings.engines.includes('ledger') ? near.filter(m => dayDistance(m.day, doc.day) <= settings.automaticDays
      && (doc.sourceProvider !== 'alipay' || alipayReconciliation.exactMatch(doc, m, accountId))
      && bankTransferHints.matchesMovement(doc, safetyGuess(doc), m)) : [];
    const match = eligible.length === 1 && docs.filter(other => other.amount === eligible[0].amount && dayDistance(other.day, eligible[0].day) <= settings.automaticDays).length === 1 ? eligible[0] : null;
    if (match) {
      taken.add(String(match._id));
      return { status: 'match', entry: { _id: match._id, number: match.number, day: match.day, description: match.description } };
    }
    const twin = near.find((m) => dayDistance(m.day, doc.day) <= DUPLICATE_DAYS);
    if (doc.sourceProvider === 'alipay' && doc.amount > 0 && !identifiedRefund) return {
      status: twin ? 'maybeDuplicate' : 'new', account: null, requiresConfirmation: true, source: 'alipay', reason: 'شراء يوان أو تحويل أو إيداع؛ يُطابق مع قيد العملية ولا يُسجل إيرادًا من الكشف',
      entry: twin ? { _id: twin._id, number: twin.number, day: twin.day, description: twin.description } : null,
    };
    const link = settings.engines.includes('purchases') && !settings.requireIdentity && links[index] && dayDistance(links[index].day, doc.day) <= settings.proposalDays ? links[index] : null;
    const billHint = guess(doc).semanticTransfer || !settings.engines.includes('purchases') ? null : await existingBillHint(doc, account, guess(doc).vendorName, settings);
    const target = identifiedRefund ? { ...guess(doc), source: 'refund', isRefund: true, requiresConfirmation: true,
      refundAccount: guess(doc).account, account: null, reason: 'مبلغ وارد من مورد مشتريات؛ يلزم اعتماد المطابقة مع الأصل' } : guess(doc).semanticTransfer ? guess(doc) : billHint || (link
      ? { account: { _id: wip._id, code: wip.code, name: wip.name }, office: null, source: 'order', keyword: null, link,
        requiresConfirmation: true, reason: 'اقتراح بالمبلغ والعملة وقرب التاريخ فقط؛ لا يُربط تلقائيًا دون مراجعة الطلبية والمورد.' }
      : guess(doc));
    // Purchases and expenses leaving the bank are posted as a bill of this vendor and its payment
    const type = target.account && accountsById.get(String(target.account._id))?.type;
    const billed = doc.amount < 0 && (link || type === 'expense');
    // (money received from a vendor keeps the vendor the rule names)
    const vendorName = target.vendorName || (billed ? merchantOf(doc.description) || null : null);
    const reviewTarget = tripHints[index].length ? { ...target, account: null, link: null, source: 'bill', requiresConfirmation: true,
      suggestedBillId: tripHints[index][0].billId, billCandidates: tripHints[index].map(candidate => ({ ...candidate, _id: candidate.billId })) } : target;
    return { status: twin ? 'maybeDuplicate' : 'new', entry: twin ? { _id: twin._id, number: twin.number, day: twin.day, description: twin.description } : null, ...permittedHint(reviewTarget, settings), vendorName, tripCandidates: tripHints[index] };
  }));
}

const listRules = (accountId) => BankRule.find(accountId ? { $or: [{ accountId }, { accountId: null }] } : {})
  .populate('counterAccountId', 'code name').sort({ keyword: 1 }).lean();

async function saveRule(input, { session, req }) {
  if (!String(input.keyword || '').trim()) throw fail('الكلمة المفتاحية مطلوبة');
  const counter = await getAccount(input.counterAccountId, 'الحساب');
  if (counter.isGroup) throw fail('اختر حساباً تفصيلياً لا مجموعة');
  if (input.accountId) await bankAccount(input.accountId);
  if (input.accountId && String(input.accountId) === String(counter._id)) throw fail('الحساب المقابل هو نفس حساب الكشف');
  const [rule] = await BankRule.create([{
    accountId: input.accountId || null, keyword: String(input.keyword).trim(), direction: ['in', 'out'].includes(input.direction) ? input.direction : 'any',
    counterAccountId: counter._id, office: input.office || undefined, vendorName: String(input.vendorName || '').trim() || undefined,
    priority: input.accountId ? 1 : 0, createdBy: req?.user?._id,
  }], { session });
  await logAudit({ req, action: 'bank.rule', model: 'AccountingBankRule', docId: rule._id, after: rule }, session);
  return rule;
}

async function deleteRule(id, { session, req }) {
  const rule = await BankRule.findByIdAndDelete(id, { session });
  if (!rule) throw fail('القاعدة غير موجودة');
  await logAudit({ req, action: 'bank.ruleDelete', model: 'AccountingBankRule', docId: rule._id, before: rule }, session);
  return rule;
}

// ---- Reading a PDF statement ----

// A date as banks print it: 2026-09-30, 30/09/2026, 30.09.2026 (Turkish), 30.09.26, 2026年9月30日
const DATE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?|(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/;
// A whole word that is an amount, with its decimals: 1,234.56 / 1.234,56 (Turkish) / 12,50 /
// -12.5 / 12.50- / (12.50) / ¥1,200.00. Plain integers are references and account numbers.
const AMOUNT = /^[¥₺$€]?\(?[-+]?[¥₺$€]?(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{1,3}|\d+,\d{1,2}|\d+\.\d{1,3})\)?-?(?:TL|TRY|CNY|RMB|USD|元)?$/i;

const toDay = (match) => {
  const [year, month, day] = match[1]
    ? [match[1], match[2], match[3]]
    : [match[6].length === 2 ? `20${match[6]}` : match[6], match[5], match[4]];
  const text = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isDay(text) ? text : null;
};
// Whichever of . and , comes last is the decimal point
const toNumber = (token) => {
  const negative = /^\(.*\)$/.test(token) || /-(?:TL|TRY|CNY|RMB|USD|元)?$/i.test(token) || /^[^\d]*-/.test(token);
  let digits = token.replace(/[^\d.,]/g, '');
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) digits = lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  else if (lastComma >= 0) digits = digits.replace(',', '.');
  const value = Number(digits);
  return Number.isFinite(value) ? (negative ? -value : value) : null;
};

// Rows from the text of a PDF statement: every text line that starts with a date and carries
// amounts. With a running balance the sign of each amount comes from how the balance moved;
// without one, the amount is taken as printed. The screen shows the rows for checking first.
async function parsePdf(buffer) {
  const pdf = require('pdf-parse/lib/pdf-parse.js');
  let text; const pages = [];
  try {
    ({ text } = await pdf(buffer, { pagerender: async page => {
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      pages.push(content.items.map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5] })));
      let lastY, result = '';
      for (const item of content.items) {
        result += lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      return result;
    } }));
  } catch (error) {
    throw fail('تعذّرت قراءة ملف PDF. إن كان محمياً بكلمة مرور أو صورة ممسوحة فاطلب الكشف من البنك Excel.');
  }
  // A bank whose layout is known is read by its own reader
  const known = readKnownFormat(text, { pages });
  if (known && known.rows.length) return known;
  return { rows: rowsFromText(text), creditCard: isCreditCard(text), format: null };
}

// A credit card statement prints spending as positive and payments to the card as negative: the
// opposite of an account, where money out is negative
const isCreditCard = (text) => /kredi kart|credit card|信用卡|بطاقة ائتمان/i.test(String(text || ''));

// The currency written after the movement on each line (the card's own currency)
const CURRENCY_WORD = /^(TL|TRY|₺|USD|LYD|EUR|CNY|RMB|元)$/i;
// "-25.000,00 TL" / "5.130,72TL": an amount in Turkish lira, with or without spaces around it
const SETTLED = /(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:TL|TRY|₺)(?![A-Za-z])/g;
// "107.73 US Dollar" / "1,090.00 Saudi Riyal" / "79.79 Türk Lirası" right before it: what was paid abroad
const FOREIGN = /(-?\d{1,3}(?:,\d{3})*\.\d{2})\s*([A-Za-zÇĞİÖŞÜçğıöşü ]+)$/;

function rowsFromText(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const date = line.match(DATE);
    if (!date || date.index > 12) continue;
    const day = toDay(date);
    if (!day) continue;
    const rest = line.slice(date.index + date[0].length);
    // Card statements put the movement in the card's currency last ("5.130,72 TL"), often glued to
    // the words around it by the PDF ("LUX107.73 US Dollar5.130,72 TL162,00")
    const settledAll = [...rest.matchAll(SETTLED)];
    if (settledAll.length) {
      const settledMatch = settledAll[settledAll.length - 1];
      let head = rest.slice(0, settledMatch.index).trim();
      const foreign = head.match(FOREIGN);
      if (foreign) head = head.slice(0, foreign.index).trim();
      const headWords = head.split(' ').filter(Boolean);
      const reference = headWords.find((word) => /^[A-Z0-9-]{6,}$/.test(word) && /\d/.test(word) && /[A-Z]/.test(word)) || '';
      const description = [headWords.filter((word) => word !== reference).join(' '), foreign && `(${foreign[1]} ${foreign[2].trim()})`].filter(Boolean).join(' ');
      const code = foreign && currencyName(foreign[2].trim());
      rows.push({ day, description, reference, amounts: [toNumber(settledMatch[1])], explicit: true,
        ...(code && { originalAmount: Math.abs(Number(foreign[1].replace(/,/g, ''))), originalCurrency: code,
          ...(code === 'USD' && { settlementUsd: Math.abs(Number(foreign[1].replace(/,/g, ''))) }) }) });
      continue;
    }
    const words = rest.split(' ').filter(Boolean);
    const amountAt = words.map((word, i) => (AMOUNT.test(word) ? i : -1)).filter((i) => i >= 0);
    if (!amountAt.length) continue;
    // "107.73 US Dollar 5.130,72 TL 162,00": the amount followed by its currency is the movement;
    // a foreign amount before it stays in the text, numbers after it (miles, points) are dropped
    const settled = amountAt.filter((i) => CURRENCY_WORD.test(words[i + 1] || '') || /(TL|₺)$/i.test(words[i])).pop();
    if (settled !== undefined) {
      const first = amountAt[0];
      const head = words.slice(0, first);
      const foreign = first < settled ? words.slice(first, settled).join(' ') : '';
      const reference = head.find((word) => /^[A-Z0-9-]{6,}$/.test(word) && /\d/.test(word)) || '';
      const description = [head.filter((word) => word !== reference).join(' '), foreign && `(${foreign})`].filter(Boolean).join(' ');
      rows.push({ day, description, reference, amounts: [toNumber(words[settled])], explicit: true });
      continue;
    }
    const amounts = amountAt.map((i) => toNumber(words[i])).filter((n) => n !== null);
    const others = words.filter((word) => !AMOUNT.test(word));
    // A long code of capitals and digits is the bank's reference
    const reference = others.find((word) => /^[A-Z0-9-]{6,}$/.test(word) && /\d/.test(word)) || '';
    const description = others.filter((word) => word !== reference).join(' ');
    rows.push({ day, description, reference, amounts });
  }
  // The last number is usually the balance; the one before it the movement
  const plain = rows.filter((r) => !r.explicit);
  const withBalance = plain.length > 0 && plain.filter((r) => r.amounts.length >= 2).length >= plain.length * 0.6;
  let previous = null;
  return rows.map((row) => {
    if (row.explicit) return { day: row.day, description: row.description, reference: row.reference, amount: row.amounts[0], balanceAfter: null,
      ...(row.originalCurrency && { originalAmount: row.originalAmount, originalCurrency: row.originalCurrency,
        ...(row.settlementUsd && { settlementUsd: row.settlementUsd }) }) };
    const balanceAfter = withBalance && row.amounts.length >= 2 ? row.amounts[row.amounts.length - 1] : null;
    let amount = withBalance && row.amounts.length >= 2 ? row.amounts[row.amounts.length - 2] : row.amounts[0];
    if (balanceAfter !== null && previous !== null) {
      const moved = Math.round((balanceAfter - previous) * 1000) / 1000;
      if (Math.abs(Math.abs(moved) - Math.abs(amount)) < 0.01) amount = moved;
    }
    if (balanceAfter !== null) previous = balanceAfter;
    return { day: row.day, description: row.description, reference: row.reference, amount, balanceAfter };
  }).filter((row) => row.amount);
}

// ---- Several statement lines for one purchase typed on an order (spec v8) ----
// A website purchase typed once on the order (50$) that the bank charged in two payments (600 and
// 1400 lira): the lines are linked to it together. One supplier bill for the purchase (in its own
// currency at the bank's dollars) and one payment per line, each in the bank's currency.

// The dollars a line is worth: the line itself on a dollar account, the dollars it printed, or the
// bank's amount at the day's rate
async function lineUsd(line, bank, session) {
  return paymentValue(line, bank, {}, session);
}

// The purchases typed on an order, for linking statement lines to one of them
async function orderPurchaseItems(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw fail('الطلب غير موجود');
  const order = await Order.findById(orderId).select('orderId placedAt purchaseItems').lean();
  if (!order) throw fail('الطلب غير موجود');
  const used = new Set((await BankStatementLine.distinct('purchaseItemId', { orderId: order._id, lineStatus: 'created_entry' })).map(String));
  return {
    orderId: order._id, orderNumber: order.orderId,
    items: (order.purchaseItems || []).map((item) => ({ _id: item._id, description: item.description, unitPrice: item.unitPrice, currency: item.currency || 'USD', date: item.date, linked: used.has(String(item._id)) })),
  };
}

async function linkGroup(lineIds, input, { session, req }) {
  const ids = [...new Set((lineIds || []).map(String))];
  if (!ids.length) throw fail('اختر سطور الكشف');
  const lines = await BankStatementLine.find({ _id: { $in: ids } }).sort({ day: 1 }).session(session);
  if (lines.length !== ids.length || lines.some((l) => l.lineStatus !== 'unmatched')) throw fail('بعض السطور غير متاحة (مطابقة أو مرحَّلة)');
  if (new Set(lines.map((l) => String(l.accountId))).size > 1) throw fail('السطور من حسابات مختلفة');
  if (lines.some((l) => l.amount >= 0)) throw fail('الربط بالمشتريات للمبالغ الخارجة فقط');
  const bank = await bankAccount(lines[0].accountId);
  const order = await Order.findOne({ _id: input.orderId, 'purchaseItems._id': input.itemId }).select('orderId placedAt purchaseItems isCanceled').session(session).lean();
  if (!order) throw fail('المشتريات غير موجودة في الطلب');
  const item = order.purchaseItems.find((i) => String(i._id) === String(input.itemId));
  if (await BankStatementLine.exists({ purchaseItemId: item._id, lineStatus: 'created_entry' }).session(session)) throw fail(`مشتريات الطلب ${order.orderId} مرتبطة بسطور كشف أخرى`);

  const values = [];
  for (const line of lines) values.push(await lineUsd(line, bank, session));
  const totalUsd = Math.round(values.reduce((s, v) => s + v.usd, 0) * 100) / 100;
  const itemCurrency = item.currency || 'USD';
  // A dollar purchase that differs from the bank by more than 2% is refused unless confirmed
  if (itemCurrency === 'USD' && Math.abs(totalUsd - Number(item.unitPrice)) > Number(item.unitPrice) * 0.02 && !input.confirmDifference) {
    const error = new ErrorHandler(409, `مجموع السطور ${totalUsd}$ والمشتريات ${item.unitPrice}$ (فرق أكثر من 2%). أكّد إن كانت نفس العملية.`);
    throw error;
  }

  // Already recorded by the historical migration as paid from suspense: the lines clear it
  const recorded = await SupplierBill.findOne({ idempotencyKey: `MIG:PURCH:${item._id}`, status: { $ne: 'canceled' } }).session(session).lean();
  if (recorded) {
    const suspense = await resolveAccount('migration_suspense');
    for (const line of lines) {
      await createEntryForLine(line._id, { counterAccountId: suspense._id, confirmNotDuplicate: true, description: `${line.description} (مشتريات الطلب ${order.orderId})` }, { session, req });
      await BankStatementLine.updateOne({ _id: line._id }, { $set: { orderId: order._id, purchaseItemId: item._id } }, { session });
    }
    return { linked: lines.length, cleared: 'suspense' };
  }

  const payables = require('./payables');
  const { currencies } = await getConfig();
  const inOwnCurrency = itemCurrency !== 'USD' && currencies.has(itemCurrency);
  const knownMerchant = (await bankMerchants.matcher(bank._id, session))(lines[0]);
  const vendor = await vendorNamed(input.vendorName || knownMerchant?.vendorName || merchantOf(lines[0].description), session);
  const description = input.description || item.description || `مشتريات الطلب ${order.orderId}`;
  const bill = await payables.createBill({
    vendorId: vendor._id, day: lines[0].day, currency: inOwnCurrency ? itemCurrency : 'USD',
    duplicateDecision: input.duplicateDecision,
    duplicateReason: input.duplicateReason,
    duplicateFingerprint: input.duplicateFingerprint,
    ...(inOwnCurrency && { rate: Number(item.unitPrice) / totalUsd }),
    note: `من كشف ${bank.name}: ${lines.length} عمليات`, idempotencyKey: `BANK_GROUP_BILL:${item._id}:${lines.map((l) => l._id).join(',')}${lines.some(l => l.postingAttempt) ? `:REPOST:${lines.map(l => l.postingAttempt || 0).join(',')}` : ''}`,
    lines: [{ description, amount: inOwnCurrency ? Number(item.unitPrice) : totalUsd, target: 'order', orderId: order._id, purchaseItemId: item._id }],
  }, { session, req });
  // Each line pays its share of the bill's dollars; the last takes what rounding left
  let left = bill.totalUsd;
  for (const [index, line] of lines.entries()) {
    await bankMerchants.learn(line, vendor._id, null, session);
    const share = index === lines.length - 1 ? left : Math.round((bill.totalUsd * values[index].usd) / totalUsd);
    left -= share;
    const payment = await payables.createPayment({
      vendorId: vendor._id, day: line.day, fromAccountId: bank._id, amount: values[index].paid,
      rate: currencyOf(bank) === 'USD' ? undefined : values[index].paid / (share / 100),
      allocations: [{ billId: bill._id, amountUsd: share }],
      idempotencyKey: `BANK_GROUP_PAY:${line._id}${line.postingAttempt ? `:REPOST:${line.postingAttempt}` : ''}`, note: `سداد ${bill.number} من كشف ${bank.name}`,
    }, { session, req });
    const value = values[index];
    Object.assign(line, { entryId: payment.entryId, billId: bill._id, paymentId: payment._id, lineStatus: 'created_entry', orderId: order._id, purchaseItemId: item._id,
      billCreatedFromStatement: true, valuationSource: value.valuationSource, valuationUsd: value.usd,
      crossRate: value.crossRate, rateBaseCurrency: value.baseCurrency, rateQuoteCurrency: value.quoteCurrency,
      ...(value.valuationSource === 'statement' && { settlementUsd: value.usd }) });
    await line.save({ session });
  }
  await require('../claims/sync').syncOrder(order._id, { session, user: req?.user });
  await logAudit({ req, action: 'bank.linkGroup', model: 'AccountingBankStatementLine', after: { lines: ids, billId: bill._id, orderId: order._id } }, session);
  return { linked: lines.length, billId: bill._id, totalUsd };
}

module.exports = {
  orderPurchaseItems, linkGroup,
  importLines, importStatement, autoMatch, manualMatch, createEntryForLine, cancelLineEntry, setIgnored, coverBeforeCount, coverage, deleteLine, unmatchedMovements, editLine,
  suggestions, classifyRows, listRules, saveRule, deleteRule, parsePdf, rowsFromText, isCreditCard, possibleDuplicates, normalize,
};
