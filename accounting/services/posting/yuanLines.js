// Yuan bought from a broker (AlQFILA...) arrives in Alipay as an incoming line. It is a yuan
// purchase: dollars (or another currency) out of the account that paid the broker, yuan into
// Alipay at that rate. A line is matched to a purchase already recorded (same yuan ±1, a week
// around), or the purchase is recorded from the line, one line or many at once, and matched by
// its Alipay transaction number. Never revenue; nothing posted without the person's approval.
const { BankStatementLine, YuanPurchase } = require('../../models/documents');
const { Account } = require('../../models');
const { addDays } = require('../dates');
const { logAudit } = require('../audit');
const { fail } = require('./common');

const YUAN = 100;
const alipayAccount = async (accountId, session) => {
  const account = await Account.findById(accountId).session(session || null).lean();
  return account?.isCash && account.currency === 'CNY' ? account : null;
};

// The broker named on an incoming line, or null
async function brokerOf(accountId, session) {
  const merchant = await require('./bankMerchants').matcher(accountId, session);
  return (line) => {
    if (line.amount <= 0) return null;
    const found = merchant(line);
    return found?.bankPurpose === 'yuan_purchase' ? { vendorId: found.vendorId, name: found.vendorName } : null;
  };
}

// For each unmatched incoming line from a broker: the broker, and purchases already recorded for it
async function suggestions(accountId, { session, lineIds } = {}) {
  const account = await alipayAccount(accountId, session);
  if (!account) return {};
  const broker = await brokerOf(account._id, session);
  const lines = (await BankStatementLine.find({ accountId: account._id, lineStatus: 'unmatched', amount: { $gt: 0 }, ...(lineIds && { _id: { $in: lineIds } }) })
    .session(session || null).lean()).map((line) => ({ line, broker: broker(line) })).filter((x) => x.broker);
  if (!lines.length) return {};
  const days = lines.map((x) => x.line.day).sort();
  const purchases = await YuanPurchase.find({ status: 'posted', arrived: true, toAccountId: account._id,
    arrivedDay: { $gte: addDays(days[0], -7), $lte: addDays(days[days.length - 1], 7) } }).populate('vendorId', 'name').session(session || null).lean();
  // A purchase whose entry a statement line already took is not offered again
  const taken = new Set((await BankStatementLine.find({ accountId: account._id, $or: [{ entryId: { $in: purchases.map((p) => p.entryId) } }, { matchedEntryIds: { $in: purchases.map((p) => p.entryId) } }] })
    .select('entryId matchedEntryIds').session(session || null).lean()).flatMap((l) => [l.entryId, ...(l.matchedEntryIds || [])].filter(Boolean).map(String)));
  const { count } = await require('../config').getConfig();
  const result = {};
  for (const { line, broker: found } of lines) {
    const existing = purchases.filter((p) => !taken.has(String(p.entryId)) && Math.abs(Math.round(p.cnyReceived * 100) - line.amount) <= YUAN
      && Math.abs(Date.parse(p.arrivedDay) - Date.parse(line.day)) <= 7 * 86400000)
      .map((p) => ({ _id: p._id, number: p.number, day: p.arrivedDay, cny: p.cnyReceived, usd: p.usd / 100, rate: p.rate, broker: p.vendorId?.name, entryId: p.entryId }));
    result[line._id] = { broker: found, cny: line.amount / 100, existing,
      beforeCount: !!count && (line.day < count.day || (line.day === count.day && count.endOfDay)) };
  }
  return result;
}

// Match a line to a purchase already recorded
async function matchExisting(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched') throw fail('سطر الكشف غير متاح؛ حدّث الصفحة');
  const proposal = ((await suggestions(line.accountId, { session, lineIds: [line._id] }))[line._id]?.existing || [])
    .find((p) => String(p._id) === String(input.yuanPurchaseId));
  if (!proposal) throw fail('عملية شراء اليوان لم تعد متاحة لهذا السطر');
  return require('./bank').manualMatch(line._id, [proposal.entryId], { session, req });
}

// Record the yuan purchase of each line (one or many) and match it: one paying account, the amount
// paid for each line in that account's currency
async function record(input, { session, req }) {
  const ids = [...new Set((input.lineIds || []).map(String))];
  if (!ids.length) throw fail('اختر سطور شراء اليوان');
  const lines = await BankStatementLine.find({ _id: { $in: ids } }).session(session).lean();
  if (lines.length !== ids.length) throw fail('بعض السطور غير موجودة');
  const accountIds = new Set(lines.map((l) => String(l.accountId)));
  if (accountIds.size !== 1) throw fail('اختر سطوراً من حساب Alipay واحد');
  const proposals = await suggestions(lines[0].accountId, { session, lineIds: ids });
  const purchases = [];
  for (const line of lines.sort((a, b) => a.day.localeCompare(b.day))) {
    const proposal = proposals[line._id];
    if (!proposal || line.lineStatus !== 'unmatched') throw fail(`السطر ${line.day} ليس شراء يوان غير مطابق من وسيط معروف`);
    if (proposal.beforeCount) throw fail(`السطر ${line.day} قبل الجرد: رصيد Alipay المجرود يشمله؛ أغلقه «مغطى بالجرد» بدل تسجيل شراء`);
    const amount = Number(input.amounts?.[String(line._id)]);
    if (!(amount > 0)) throw fail(`اكتب المبلغ المدفوع لسطر ${line.day} (${proposal.cny}¥)`);
    const doc = await require('./alipay').createYuanPurchase({
      vendorId: proposal.broker.vendorId, day: line.day, fromAccountId: input.fromAccountId, amount, toAccountId: line.accountId,
      cnyReceived: proposal.cny, transactionReference: line.sourceTransactionId || undefined,
      idempotencyKey: `BANK_YUAN:${line._id}:${line.postingAttempt || 0}`, note: `من كشف Alipay: ${line.description || ''}`,
    }, { session, req });
    // Matched by its transaction number; a line without one is matched to the purchase directly
    const after = await BankStatementLine.findById(line._id).session(session).lean();
    if (after.lineStatus === 'unmatched') await require('./bank').manualMatch(line._id, [doc.entryId], { session, req });
    purchases.push(doc);
  }
  await logAudit({ req, action: 'bank.yuanPurchases', model: 'AccountingBankStatementLine', docId: lines[0]._id,
    after: { lineIds: ids, purchases: purchases.map((p) => p.number), fromAccountId: input.fromAccountId } }, session);
  return { recorded: purchases.length, numbers: purchases.map((p) => p.number) };
}

module.exports = { suggestions, matchExisting, record };
