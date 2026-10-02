// The only way a posted accounting document is undone (spec 7-ج.6): dependency checks, then
// the document is marked canceled and every entry it produced is reversed, in one transaction.
const ErrorHandler = require('../../utils/errorHandler');
const { JournalEntry } = require('../models');
const docs = require('../models/documents');
const Wallet = require('../../models/wallet');
const { reverseEntry } = require('./ledger');
const { logAudit } = require('./audit');
const { moveWallet } = require('./posting/people');
const { assertOwnerIfLocked } = require('./periodGuard');

const fail = (message) => new ErrorHandler(400, message);

const ACTIVE = { $ne: 'canceled' };

// What must be cancelled first, and what is cancelled along with the document
const RULES = {
  AccountingSupplierBill: {
    Model: docs.SupplierBill,
    async check(bill, { session }) {
      const payments = await docs.SupplierPayment.find({ 'allocations.billId': bill._id, status: ACTIVE, autoFromBillId: { $ne: bill._id } }).session(session);
      if (payments.length) throw fail(`على الفاتورة دفعات (${payments.map((p) => p.number).join('، ')}). ألغِ الدفعات أولاً.`);
      const notes = await docs.SupplierBill.find({ originalBillId: bill._id, status: ACTIVE }).session(session);
      if (notes.length) throw fail(`للفاتورة إشعارات دائنة (${notes.map((n) => n.number).join('، ')}). ألغِها أولاً.`);
      const nettings = await docs.Netting.find({ billId: bill._id, status: ACTIVE }).session(session);
      if (nettings.length) throw fail(`على الفاتورة مقاصة (${nettings.map((n) => n.number).join('، ')}). ألغِها أولاً.`);
      const assets = await docs.FixedAsset.find({ sourceBillId: bill._id, status: ACTIVE }).session(session);
      if (assets.some((a) => a.depreciationPosted.length || a.assetStatus === 'disposed')) {
        throw fail('للأصل في هذه الفاتورة إهلاك مُرحَّل. ألغِ الأصل (يعكس إهلاكه) أولاً.');
      }
      const prepaid = await docs.PrepaidExpense.find({ sourceBillId: bill._id, status: ACTIVE }).session(session);
      if (prepaid.some((p) => p.amortizationPosted.length)) throw fail('للمصروف المقدم أقساط مُرحَّلة. ألغِ الجدول أولاً.');
    },
    async cascade(bill, context) {
      // The payment made on the spot with the bill goes with it
      const auto = await docs.SupplierPayment.findOne({ autoFromBillId: bill._id, status: ACTIVE }).session(context.session);
      if (auto) await cancelDocument('AccountingSupplierPayment', auto._id, { ...context, cascaded: true, reason: `${context.reason} (مع الفاتورة ${bill.number})` });
      await docs.FixedAsset.updateMany({ sourceBillId: bill._id, status: ACTIVE }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: context.reason } }, { session: context.session });
      await docs.PrepaidExpense.updateMany({ sourceBillId: bill._id, status: ACTIVE }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: context.reason } }, { session: context.session });
    },
    // Runs after the bill's entries are reversed: cost shares already recognised shrink with it
    async after(bill, context) {
      const { syncBillTargets } = require('./posting/payables');
      await syncBillTargets(bill, { session: context.session, user: context.req?.user });
    },
  },
  AccountingSupplierPayment: { Model: docs.SupplierPayment },
  AccountingTreasuryTransfer: { Model: docs.TreasuryTransfer },
  AccountingCashCount: { Model: docs.CashCount },
  AccountingSalaryPayment: { Model: docs.SalaryPayment },
  AccountingEquityTransaction: { Model: docs.EquityTransaction },
  // Cancelling an asset reverses its depreciation and disposal entries (they are posted under it);
  // the bill that bought it can then be cancelled. Same for a prepaid schedule and its instalments.
  AccountingFixedAsset: { Model: docs.FixedAsset },
  AccountingPrepaidExpense: { Model: docs.PrepaidExpense },
  AccountingNetting: {
    Model: docs.Netting,
    async check(netting, { session, confirmNegative }) {
      if (netting.mode !== 'payable_to_wallet') return;
      const statement = netting.userStatementId && await require('../../models/userStatement').findById(netting.userStatementId).session(session);
      const wallet = await Wallet.findOne({ user: netting.customerId, currency: netting.walletCurrency }).session(session);
      if (statement && (wallet?.balance || 0) < statement.amount && !confirmNegative) {
        throw fail(`محفظة العميل ستصبح سالبة (الرصيد ${wallet?.balance || 0}). أكّد الإلغاء للمتابعة.`);
      }
    },
    async cascade(netting, { session, req, reason }) {
      if (netting.mode !== 'payable_to_wallet' || !netting.userStatementId) return;
      const statement = await require('../../models/userStatement').findById(netting.userStatementId).session(session);
      if (!statement) return;
      await moveWallet({
        userId: netting.customerId, currency: netting.walletCurrency, amount: -statement.amount,
        description: `إلغاء المقاصة ${netting.number}${reason ? ` - ${reason}` : ''}`, note: netting.number,
        createdBy: req?.user?._id, source: { model: 'AccountingNetting', id: netting._id },
      }, session);
    },
  },
};

// Reverses every entry the document produced that is still in effect (its own, plus
// depreciation/amortisation posted under it). Each reversal is keyed by the entry it undoes,
// CANCEL:<model>:<id>:<entryId>, so the same entry can never be reversed twice.
async function reverseSourceEntries(modelName, id, { session, user, reason, migrationRunId, isHistorical }) {
  const entries = await JournalEntry.find({ 'source.model': modelName, 'source.id': id, status: 'posted', reversalOf: null })
    .sort({ day: 1, createdAt: 1 }).session(session);
  const reversals = [];
  for (const entry of entries) {
    const eventKey = `CANCEL:${modelName}:${id}:${entry._id}`;
    reversals.push(await reverseEntry(entry._id, { session, user, reason, eventKey, eventType: 'CANCEL', migrationRunId, isHistorical }));
  }
  return reversals;
}

async function cancelDocument(modelName, id, context) {
  const { session, req, reason } = context;
  const rule = RULES[modelName];
  if (!rule) throw fail('هذا النوع من المستندات لا يُلغى من هنا');
  if (!String(reason || '').trim()) throw fail('سبب الإلغاء مطلوب');

  const doc = await rule.Model.findById(id).session(session);
  if (!doc) throw new ErrorHandler(404, 'المستند غير موجود');
  if (doc.status === 'draft') throw fail('المسودة تُحذف ولا تُلغى');
  if (doc.status === 'canceled') throw fail('المستند مُلغى مسبقاً');
  // A document of a closed period is cancelled by the owner only (spec 19.12)
  if (!context.cascaded) await assertOwnerIfLocked(req?.user, doc.day);
  if (rule.check) await rule.check(doc, context);

  // Claims the document first: a second cancel at the same moment conflicts here and fails
  const claimed = await rule.Model.findOneAndUpdate(
    { _id: doc._id, status: 'posted' },
    { $set: { status: 'canceled', canceledAt: new Date(), canceledBy: req?.user?._id, cancelReason: String(reason).trim() } },
    { new: true, session }
  );
  if (!claimed) throw fail('المستند مُلغى مسبقاً');

  const reversals = await reverseSourceEntries(modelName, doc._id, { session, user: req?.user, reason });
  if (rule.cascade) await rule.cascade(claimed, context);
  if (rule.after) await rule.after(claimed, context);
  claimed.reversalEntryId = reversals[0]?._id;
  await claimed.save({ session });
  await logAudit({ req, action: 'document.cancel', model: modelName, docId: doc._id, after: { reason, reversals: reversals.map((r) => r._id) } }, session);
  return claimed;
}

module.exports = { cancelDocument, reverseSourceEntries, CANCELABLE_MODELS: Object.keys(RULES) };
