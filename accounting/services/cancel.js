// The only way a posted accounting document is undone (spec 7-ج.6): dependency checks, then
// the document is marked canceled and every entry it produced is reversed, in one transaction.
const ErrorHandler = require('../../utils/errorHandler');
const { JournalEntry } = require('../models');
const docs = require('../models/documents');
const Wallet = require('../../models/wallet');
const { reverseEntry } = require('./ledger');
const { logAudit } = require('./audit');
const { moveWallet, lockCompanyLoanBalance } = require('./posting/people');
const { assertOwnerIfLocked } = require('./periodGuard');

const fail = (message) => new ErrorHandler(400, message);

const ACTIVE = { $ne: 'canceled' };

// What must be cancelled first, and what is cancelled along with the document
const RULES = {
  AccountingSupplierBill: {
    Model: docs.SupplierBill,
    async check(bill, { session }) {
      if (await docs.BankStatementLine.exists({ billId: bill._id, historicalSettlementPaymentId: { $ne: null }, lineStatus: 'created_entry' }).session(session))
        throw fail('الفاتورة لها تسوية سداد تاريخي مع البنك؛ ألغِ التسوية من سطر الكشف أولاً');
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
  AccountingSupplierPayment: {
    Model: docs.SupplierPayment,
    async check(payment, { session }) {
      if (await docs.BankStatementLine.exists({ historicalSettlementPaymentId: payment._id, lineStatus: 'created_entry' }).session(session))
        throw fail('هذا السداد التاريخي تمت تسويته مع البنك؛ ألغِ التسوية من سطر الكشف أولاً');
    },
    // A payment that changed its bills' cost: their orders and trips take the change back
    async after(payment, context) {
      await require('./posting/alipayReconciliation').releaseDocumentMatches('AccountingSupplierPayment', payment._id, context);
      if (!payment.costDifferenceUsd) return;
      const { syncBillTargets } = require('./posting/payables');
      for (const allocation of payment.allocations) {
        const bill = await docs.SupplierBill.findById(allocation.billId).session(context.session);
        if (bill) await syncBillTargets(bill, { session: context.session, user: context.req?.user });
      }
    },
  },
  AccountingSupplierReceipt: {
    Model: docs.SupplierReceipt,
    async after(receipt, { session, fromBankLineId }) {
      const linked = await docs.BankStatementLine.find({ receiptId: receipt._id, lineStatus: { $in: ['created_entry', 'matched'] } }).session(session);
      for (const line of linked) {
        if (String(line._id) === String(fromBankLineId || '')) continue;
        const ids = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean);
        await JournalEntry.updateMany({ _id: { $in: ids } }, { $pull: { bankMatchedAccounts: line.accountId } }, { session });
        line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...ids.map(String)])];
        line.postingAttempt = (line.postingAttempt || 0) + 1;
        line.lineStatus = 'unmatched'; line.entryId = undefined; line.matchedEntryIds = []; line.receiptId = undefined;
        // Its credit note still exists and may be received again; don't create another cost reduction.
        line.refundCreditCreated = false;
        await line.save({ session });
      }
    },
  },
  AccountingYuanPurchase: { Model: docs.YuanPurchase,
    async after(purchase, context) {
      await require('./posting/alipayReconciliation').releaseDocumentMatches('AccountingYuanPurchase', purchase._id, context);
    },
  },
  AccountingCustomerRefund: {
    Model: docs.CustomerRefund,
    async check(refund, { session, confirmNegative }) {
      if (!refund.walletUsd) return;
      const wallet = await Wallet.findOne({ user: refund.partnerId, currency: 'USD' }).session(session);
      if ((wallet?.balance || 0) < refund.walletUsd / 100 && !confirmNegative) {
        throw fail(`محفظة العميل ستصبح سالبة (الرصيد ${wallet?.balance || 0}$). أكّد الإلغاء للمتابعة.`);
      }
    },
    async cascade(refund, { session, req, reason }) {
      if (!refund.walletUsd) return;
      const statement = await moveWallet({
        userId: refund.partnerId, currency: 'USD', amount: -refund.walletUsd / 100,
        description: `إلغاء الريفاند ${refund.number}${reason ? ` - ${reason}` : ''}`, note: refund.number,
        createdBy: req?.user?._id, source: { model: 'AccountingCustomerRefund', id: refund._id },
      }, session);
      await require('../../models/userStatement').updateOne({ _id: statement._id }, { $set: { actionType: 'refund' } }, { session });
    },
    async after(refund, context) {
      const linked = await docs.BankStatementLine.find({ customerRefundId: refund._id, lineStatus: { $in: ['created_entry', 'matched'] } }).session(context.session);
      for (const line of linked) {
        if (String(line._id) === String(context.fromBankLineId || '')) continue;
        if (String(refund.fundedFromPendingBankLineId || '') === String(line._id)) {
          line.pendingRefund = true; line.customerRefundId = undefined; line.orderId = undefined; line.billId = undefined;
          await line.save({ session: context.session });
          continue;
        }
        const ids = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean);
        await JournalEntry.updateMany({ _id: { $in: ids } }, { $pull: { bankMatchedAccounts: line.accountId } }, { session: context.session });
        line.historyEntryIds = [...new Set([...(line.historyEntryIds || []).map(String), ...ids.map(String)])];
        line.postingAttempt = (line.postingAttempt || 0) + 1;
        line.lineStatus = 'unmatched'; line.entryId = undefined; line.matchedEntryIds = []; line.customerRefundId = undefined; line.orderId = undefined; line.billId = undefined;
        await line.save({ session: context.session });
      }
      await require('./claims/sync').syncOrder(refund.orderId, { session: context.session, user: context.req?.user });
    },
  },
  AccountingClaimWriteOff: {
    Model: docs.ClaimWriteOff,
    async check(writeOff, { session }) {
      await require('./claims/locks').lockClaimAllocation(writeOff.arKey, session);
      if (await JournalEntry.exists({ eventType: 'WRITEOFF_RECOVERY', 'lines.arKey': writeOff.arKey }).session(session)) {
        throw fail('دُفع على المطالبة بعد شطبها؛ أُعيد جزء من الشطب تلقائياً. لا يُلغى الشطب الآن.');
      }
    },
    async after(writeOff, context) {
      await require('./claims/sync').syncOrder(writeOff.orderId, { session: context.session, user: context.req?.user });
    },
  },
  AccountingTreasuryTransfer: {
    Model: docs.TreasuryTransfer,
    // Spec 7-ج.6: cancelling takes the money back out of the receiving box; if it was spent since,
    // the box would go below zero, so that needs an explicit confirmation
    async check(transfer, { session, confirmNegative }) {
      if (confirmNegative) return;
      const { accountsById } = await require('./config').getConfig();
      const to = accountsById.get(String(transfer.toAccountId));
      if (!to || to.type !== 'asset') return;
      const { getBalance } = require('./carrying');
      const { toCurrencyMinor } = require('./posting/common');
      const currency = to.currency || 'USD';
      const balance = await getBalance(to._id, { session });
      const have = currency === 'USD' ? balance.usd : balance.foreign;
      let out = await toCurrencyMinor(transfer.toAmount, currency);
      if (transfer.fees && String(transfer.feesFromAccountId) === String(transfer.toAccountId)) out -= await toCurrencyMinor(transfer.fees, currency);
      if (have - out < 0) {
        throw fail(`الحساب المستلم «${to.name}» سيصبح سالباً بعد الإلغاء (صُرف منه بعد التحويل). أكّد الإلغاء للمتابعة.`);
      }
    },
  },
  AccountingCashCount: { Model: docs.CashCount },
  AccountingSalaryPayment: { Model: docs.SalaryPayment },
  AccountingEquityTransaction: {
    Model: docs.EquityTransaction,
    async check(transaction, { session }) {
      if (!['loan_in', 'loan_repayment'].includes(transaction.type)) return;
      await lockCompanyLoanBalance(session);
      if (transaction.type === 'loan_in') {
        const repayments = await docs.EquityTransaction.find({
          type: 'loan_repayment', partyName: transaction.partyName, status: ACTIVE,
        }).session(session);
        if (repayments.length) throw fail('Cancel repayments from this lender before canceling the original loan');
      }
    },
  },
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
  if (['AccountingSupplierBill', 'AccountingSupplierPayment'].includes(modelName)) {
    const key = modelName === 'AccountingSupplierBill' ? 'bills.billId' : 'bills.paymentId';
    const settlement = await require('../models/TripCostSettlement').findOne({ status: 'posted', [key]: doc._id }).select('_id').session(session);
    if (settlement && String(context.tripCostSettlementId || '') !== String(settlement._id))
      throw fail('هذا المستند ضمن تسوية تكاليف جماعية؛ ألغِ التسوية كاملة من تكاليف الرحلات');
  }
  // A document of a closed period is cancelled by the owner only (spec 19.12)
  if (!context.cascaded) await assertOwnerIfLocked(req?.user, doc.day, { session });
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
