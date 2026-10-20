const { BankStatementLine } = require('../../models/documents');
const { fail } = require('./common');
const { logAudit } = require('../audit');
const ref = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const key = line => `${line.day}:${line.amount}:${ref(line.reference)}`;
// References shared by genuine transactions are reviewed, never silently merged.
async function repeatedReferences(accountId, docs, session) {
  const wanted = docs.filter(d => d.sourceProvider !== 'alipay' && ref(d.reference));
  if (!wanted.length) return new Map();
  const days = wanted.map(d => d.day).sort();
  const existing = await BankStatementLine.find({ accountId, sourceProvider: { $ne: 'alipay' },
    day: { $gte: days[0], $lte: days[days.length - 1] }, reference: { $nin: ['', null] },
    duplicateResolvedToId: { $exists: false },
  }).select('_id day amount reference description fingerprint fingerprintAliases lineStatus duplicateReviewPending').session(session || null).lean();
  const grouped = new Map();
  for (const line of existing) { const group = grouped.get(key(line)) || []; group.push(line); grouped.set(key(line), group); }
  const result = new Map();
  const earlierRows = new Map();
  for (const doc of wanted) {
    const candidates = [...(grouped.get(key(doc)) || []), ...(earlierRows.get(key(doc)) || [])].filter(l => (!doc._id || String(l._id) !== String(doc._id))
      && l.fingerprint !== doc.fingerprint && !l.fingerprintAliases?.includes(doc.fingerprint));
    const matches = [...new Map(candidates.map(l => [String(l._id || l.fingerprint), l])).values()];
    if (matches.length) result.set(doc.fingerprint || String(doc._id), matches);
    const previous = earlierRows.get(key(doc)) || [];
    previous.push(doc); earlierRows.set(key(doc), previous);
  }
  return result;
}
function quality(line, movement, hint = {}) {
  const referenceMatch = !!ref(line.sourceTransactionId || line.reference) && !!ref(movement?.bankSourceReference)
    && ref(line.sourceTransactionId || line.reference) === ref(movement.bankSourceReference)
    && String(movement.bankSourceAccountId) === String(line.accountId);
  if (referenceMatch) return { level: 'strong', label: 'مرجع العملية مطابق', reasons: ['نفس الحساب والمبلغ والعملة', 'مرجع القيد يطابق الكشف'] };
  if (movement) return { level: 'review', label: 'تشابه مبلغ وتاريخ', reasons: ['نفس الحساب والمبلغ والعملة', 'راجع البيان والطرف؛ المبلغ وحده لا يثبت العملية'] };
  if (hint.billCandidates?.some(b => b.matchReasons?.includes('اسم المورد أو مرجع العملية مطابق')))
    return { level: 'supported', label: 'المورد أو المرجع يدعم الاقتراح', reasons: ['المبلغ والعملة متوافقان', 'تحتاج مراجعة الفاتورة الأصلية'] };
  return { level: 'review', label: 'اقتراح يحتاج مراجعة', reasons: [hint.reason || 'راجع أصل العملية قبل الاعتماد'] };
}
function referenceCompatible(line, movement) {
  return !movement.bankSourceReference || String(movement.bankSourceAccountId) !== String(line.accountId)
    || !ref(line.sourceTransactionId || line.reference)
    || ref(movement.bankSourceReference) === ref(line.sourceTransactionId || line.reference);
}
async function resolve(lineId, input, { session, req }) {
  await require('../periodLock').lockPeriod(session);
  const line = await BankStatementLine.findById(lineId).session(session);
  if (!line || line.lineStatus !== 'unmatched' || !line.duplicateReviewPending) throw fail('السطر لم يعد يحتاج مراجعة التكرار؛ حدّث القائمة');
  const matches = (await repeatedReferences(line.accountId, [line], session)).get(line.fingerprint) || [];
  if (input.action === 'same') {
    const existing = matches.find(m => String(m._id) === String(input.existingLineId) && !m.duplicateReviewPending);
    if (!existing) throw fail('السطر الأصلي تغير أو غير متوافق؛ أعد المراجعة');
    await BankStatementLine.updateOne({ _id: existing._id }, { $addToSet: { fingerprintAliases: line.fingerprint } }, { session });
    line.duplicateResolvedToId = existing._id; line.lineStatus = 'ignored';
  } else if (input.action === 'independent' && String(input.reason || '').trim().length >= 10) {
    line.duplicateIndependentReason = String(input.reason).trim();
  } else throw fail('اختر السطر الأصلي أو اكتب سبب أنها عملية مستقلة');
  line.duplicateReviewPending = false;
  await line.save({ session });
  await logAudit({ req, action: 'bank.referenceDuplicateReviewed', model: 'AccountingBankStatementLine', docId: line._id,
    after: { action: input.action, existingLineId: line.duplicateResolvedToId, reason: input.reason } }, session);
  return line;
}
function assertReviewed(line) {
  if (line.duplicateReviewPending || line.duplicateResolvedToId) throw fail('راجع السطر المستورد المحتمل أو افتح السطر الأصلي قبل تنفيذ العملية');
}
module.exports = { repeatedReferences, quality, referenceCompatible, resolve, ref, assertReviewed };
