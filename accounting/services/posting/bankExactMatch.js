const { BankStatementLine, SupplierBill } = require('../../models/documents');
const { Account, JournalEntry } = require('../../models');
const Order = require('../../../models/order');
const { originalOf } = require('./bankAmounts');
const { toDay } = require('../dates');
const { getConfig } = require('../config');
const { fail } = require('./common');

async function match(lineId, input, { session, req }) {
  const line = await BankStatementLine.findById(lineId).session(session).lean();
  if (!line || line.lineStatus !== 'unmatched') throw fail('السطر لم يعد متاحًا؛ حدّث قائمة المطابقة');
  if (await BankStatementLine.exists({ _id: { $ne: line._id }, accountId: line.accountId, lineStatus: 'unmatched', day: line.day, amount: line.amount }).session(session))
    throw fail('أكثر من سطر بنفس المبلغ والتاريخ؛ راجع المطابقة منفردة');
  const bank = require('./bank');
  const choice = (await bank.suggestions(line.accountId, { lineIds: [line._id] }))[line._id]?.exactMatch;
  const same = choice && input.expected && ['kind', 'billId', 'orderId', 'itemId', 'entryId'].every(key => String(choice[key] || '') === String(input.expected[key] || ''));
  if (!same) throw fail('تغيّر المقترح أو لم تعد المطابقة وحيدة ودقيقة بالمبلغ والعملة والتاريخ؛ راجع السطر');
  if (choice.kind === 'ledger') {
    const entry = await JournalEntry.findById(choice.entryId).session(session).lean();
    if (entry?.day !== line.day) throw fail('تاريخ القيد لا يطابق تاريخ الكشف بالضبط');
    return bank.manualMatch(line._id, [choice.entryId], { session, req });
  }
  const account = await Account.findById(line.accountId).session(session).lean();
  const { currencies } = await getConfig();
  const original = originalOf(line, account.currency, currencies.get(account.currency)?.decimals ?? 2);
  let candidate;
  if (choice.kind === 'bill') {
    const bill = await SupplierBill.findById(choice.billId).session(session).lean();
    if (bill) candidate = { day: bill.day, currency: bill.currency, amount: require('./bankPurchaseReview').amountOf(bill) };
  } else {
    const order = await Order.findOne({ _id: choice.orderId, isCanceled: { $ne: true } }).session(session).lean();
    const item = order?.purchaseItems.find(item => String(item._id) === String(choice.itemId));
    if (item?.date) candidate = { day: toDay(item.date), currency: item.currency || 'USD', amount: Number(item.unitPrice) };
  }
  if (!candidate || candidate.day !== line.day || candidate.currency !== original.currency || Math.abs(candidate.amount - original.amount) > 0.0005)
    throw fail('المبلغ أو العملة أو التاريخ لا يطابق الكشف بالضبط؛ راجع السطر');
  return require('./bankPurchaseReview').matchPurchase(line._id, choice, { session, req });
}
module.exports = { match };
