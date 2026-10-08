const mongoose = require('mongoose');
require('../../../models/user');
require('../../../models/order');
require('../../../models/inventory');
const { JournalEntry, AuditLog } = require('../../models');
const { BankStatementLine, SupplierBill, SupplierPayment, SupplierReceipt, CustomerRefund } = require('../../models/documents');
const { badRequest, notFound } = require('../../controllers/util');

// Read actual posted lines; a suggestion is never presented as a ledger account.
async function details(id) {
  if (!mongoose.isValidObjectId(id)) throw badRequest('سطر الكشف غير صالح');
  const line = await BankStatementLine.findById(id)
    .populate('accountId', 'code name currency office')
    .populate('orderId', 'orderId').populate('createdBy', 'firstName lastName username').lean();
  if (!line) throw notFound('سطر الكشف غير موجود');
  const currentIds = [line.entryId, ...(line.matchedEntryIds || [])].filter(Boolean).map(String);
  const payments = await SupplierPayment.find({ $or: [
    { entryId: { $in: currentIds } }, ...(line.paymentId ? [{ _id: line.paymentId }] : []), ...(line.historicalSettlementPaymentId ? [{ _id: line.historicalSettlementPaymentId }] : []),
  ] }).populate('vendorId', 'name').lean();
  const refunds = await CustomerRefund.find({ $or: [{ entryId: { $in: currentIds } }, { bankLineId: line._id }, ...(line.customerRefundId ? [{ _id: line.customerRefundId }] : [])] }).lean();
  currentIds.push(...refunds.flatMap(refund => (refund.bankValuationEntryIds || []).map(String)));
  const receipts = await SupplierReceipt.find({ $or: [{ entryId: { $in: currentIds } }, ...(line.receiptId ? [{ _id: line.receiptId }] : [])] }).lean();
  const billIds = [...new Set([line.billId, line.creditNoteId, ...refunds.map(r => r.billId), ...receipts.flatMap(r => (r.allocations || []).map(a => a.billId)), ...payments.flatMap(p => (p.allocations || []).map(a => a.billId))].filter(Boolean).map(String))];
  const bills = await SupplierBill.find({ _id: { $in: billIds } }).populate('vendorId', 'name').lean();
  const costIds = bills.map(b => b.entryId).filter(Boolean).map(String);
  const ids = [...new Set([...currentIds, ...costIds, ...(line.historyEntryIds || []).map(String)])];
  const entries = await JournalEntry.find({ $or: [
    { _id: { $in: ids } }, { reversalOf: { $in: ids } },
    { 'source.model': 'AccountingBankStatementLine', 'source.id': line._id },
    { 'source.model': 'AccountingSupplierBill', 'source.id': { $in: bills.map(b => b._id) } },
    { 'source.model': 'AccountingSupplierPayment', 'source.id': { $in: payments.map(p => p._id) } },
    { 'source.model': 'AccountingSupplierReceipt', 'source.id': { $in: receipts.map(r => r._id) } },
    { 'source.model': 'AccountingCustomerRefund', 'source.id': { $in: refunds.map(r => r._id) } },
  ] }).sort({ createdAt: 1 }).populate('journalId', 'code name')
    .populate('createdBy', 'firstName lastName username').populate('lines.accountId', 'code name currency')
    .populate('lines.orderId', 'orderId').populate('lines.tripId', 'inventoryId name')
    .populate('lines.partnerId', 'firstName lastName customerId').populate('lines.employeeId', 'firstName lastName username')
    .populate({ path: 'lines.vendorId', model: 'AccountingVendor', select: 'name' }).lean();
  const audit = await AuditLog.find({ model: 'AccountingBankStatementLine', $or: [
    { docId: line._id }, ...(line.importBatchId ? [{ action: 'bank.import', 'after.batchId': line.importBatchId }] : []),
  ] })
    .sort({ at: -1 }).limit(100).populate('userId', 'firstName lastName username').lean();
  return { line, bills, payments, receipts, refunds, entries: entries.map(entry => ({ ...entry,
    role: currentIds.includes(String(entry._id)) ? 'settlement' : costIds.includes(String(entry._id)) ? 'cost' : 'history',
    totalCredit: entry.lines.reduce((sum, l) => sum + (l.credit || 0), 0),
  })), audit };
}
module.exports = { details };
