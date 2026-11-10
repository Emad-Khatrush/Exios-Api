// The statement reference typed on an operation paid from a money account (a bank, a card, Alipay,
// a partner's current account): kept on its journal entry so that the statement line carrying the
// same reference matches it on import, alone or together with the other operations typed with the
// same reference when they add up to the line (one 7,880¥ Alipay transfer recorded as a 1,880¥
// supplier payment and a 6,000¥ salary). Works whichever comes first, the operation or the statement.
const { JournalEntry } = require('../../models');
const { BankStatementLine } = require('../../models/documents');
const { fail } = require('./common');

const clean = (value) => String(value || '').trim();

function validate(reference) {
  const value = clean(reference);
  if (!value) return '';
  // A long number copied from Excel arrives as 2.0261E+27: not the reference any more
  if (value.length > 160 || /^\d+(\.\d+)?[eE][+-]?\d+$/.test(value)) throw fail('أدخل رقم العملية كاملًا كما يظهر في الكشف');
  return value;
}

// Puts the reference on the entry and matches what can be matched now
async function attach(entryId, account, reference, { session, req }) {
  const value = validate(reference);
  if (!value || !entryId || !account?.isCash) return;
  const taken = await BankStatementLine.findOne({ accountId: account._id, lineStatus: { $in: ['matched', 'created_entry'] },
    $or: [{ reference: value }, { sourceTransactionId: value }] }).select('_id day').session(session).lean();
  if (taken) throw fail(`رقم العملية مربوط بسطر كشف مطابق مسبقًا (${taken.day})؛ تأكد من الرقم`);
  await JournalEntry.updateOne({ _id: entryId }, { $set: { statementReferenceAccountId: account._id, statementReference: value } }, { session });
  await require('./bank').autoMatch(account._id, { session, req });
}

module.exports = { attach, validate };
