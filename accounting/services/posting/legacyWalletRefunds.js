const mongoose = require('mongoose');
const UserStatement = require('../../../models/userStatement');
const Order = require('../../../models/order');
const { JournalEntry, AccountingEvent } = require('../../models');
const { CustomerRefund } = require('../../models/documents');
const { fail } = require('./common');
const { toDay, isDay } = require('../dates');
const { purchaseKey } = require('../claims/keys');
const { logAudit } = require('../audit');

// These are wallet credits, not bank receipts. Linking never credits the wallet again.
async function candidates(input, session = null) {
  if (!mongoose.isValidObjectId(input.orderId)) throw fail('اختر الطلبية');
  if (input.day && !isDay(input.day)) throw fail('التاريخ غير صالح');
  const order = await Order.findById(input.orderId).select('user orderId').session(session).lean();
  if (!order) throw fail('الطلبية غير موجودة');
  const used = await CustomerRefund.distinct('legacyWalletStatementId', { status: 'posted' }).session(session);
  const statements = await UserStatement.find({ user: order.user, calculationType: '+', actionType: { $in: ['refund', 'compensation'] },
    'accountingSource.model': { $exists: false }, _id: { $nin: used.filter(Boolean) } }).sort({ createdAt: -1 }).limit(1001).session(session).lean();
  const entries = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': { $in: statements.map(s => s._id) },
    status: 'posted', reversalOf: null, eventType: { $in: ['REFUND', 'COMPENSATION'] } }).session(session).lean();
  const waiting = new Set((await AccountingEvent.distinct('refId', { refId: { $in: statements.map(s => s._id) },
    type: { $in: ['statement', 'statementUpdated', 'statementDeleted'] }, status: { $in: ['pending', 'failed'] } }).session(session)).map(String));
  const { currencies } = await require('../config').getConfig();
  const results = [];
  for (const statement of statements.slice(0, 1000)) {
    if (waiting.has(String(statement._id)) || statement.linkedCustomerRefundId || statement.linkedBankRefundLineId) continue;
    const posted = entries.filter(e => String(e.source.id) === String(statement._id));
    if (posted.length !== 1) continue;
    const entry = posted[0];
    const walletLines = entry.lines.filter(l => String(l.partnerId) === String(order.user) && l.credit > 0 && l.amountCurrency < 0);
    if (walletLines.length !== 1) continue;
    const decimals = currencies.get(statement.currency)?.decimals;
    if (decimals == null || walletLines[0].currency !== statement.currency
      || Math.round(Number(statement.amount) * 10 ** decimals) !== -walletLines[0].amountCurrency) continue;
    const linkedOrders = [...new Set(entry.lines.map(l => l.orderId).filter(Boolean).map(String))];
    const keys = entry.lines.map(l => l.arKey).filter(Boolean);
    if (linkedOrders.some(id => id !== String(order._id)) || keys.some(k => k !== purchaseKey(order._id))) continue;
    const named = String(statement.note || '').match(/Order Id \(([^)]+)\)/)?.[1]?.trim();
    if (named && !['undefined', 'null', String(order.orderId)].includes(named)) continue;
    const sameOrder = linkedOrders.includes(String(order._id)) || keys.includes(purchaseKey(order._id)) || named === String(order.orderId);
    const day = toDay(statement.createdAt);
    const sameAmount = Number(input.walletUsd) > 0 && Math.round(Number(input.walletUsd) * 100) === walletLines[0].credit;
    const closeDay = input.day && Math.abs(Date.parse(input.day) - Date.parse(day)) <= 3 * 86400000;
    results.push({ _id: statement._id, day, amount: statement.amount, currency: statement.currency, usd: walletLines[0].credit,
      kind: statement.actionType, description: statement.description, note: statement.note, entryId: entry._id,
      sameOrder, automaticEligible: statement.actionType === 'refund' && sameOrder && sameAmount && !!closeDay });
  }
  results.sort((a, b) => Number(b.automaticEligible) - Number(a.automaticEligible) || Number(b.sameOrder) - Number(a.sameOrder) || b.day.localeCompare(a.day));
  const automatic = results.filter(r => r.automaticEligible);
  return { results, automaticId: automatic.length === 1 ? automatic[0]._id : null, truncated: statements.length > 1000 };
}

async function select(input, session) {
  const available = await candidates(input, session);
  if (input.autoLinkLegacyRefund === true && !input.legacyWalletStatementId && !available.automaticId)
    throw fail('لا توجد مطابقة تلقائية واضحة؛ اختر الحركة السابقة يدويًا');
  const selectedId = input.legacyWalletStatementId || (input.autoLinkLegacyRefund === true && available.automaticId);
  if (selectedId) {
    const selected = available.results.find(r => String(r._id) === String(selectedId));
    if (!selected) throw fail('الريفاند أو التعويض غير متاح؛ ربما رُبط أو عُدّل. حدّث القائمة');
    if (input.legacyWalletStatementId && input.confirmLegacyRefund !== true) throw fail('أكد ربط حركة المحفظة السابقة');
    return selected;
  }
  if (Number(input.walletUsd) > 0 && available.results.length && input.confirmNewWalletRefund !== true)
    throw fail('توجد مبالغ مستردة أو تعويضات سابقة لهذا العميل. اختر الحركة الموجودة أو أكد أن هذه إضافة جديدة مستقلة');
  return null;
}

async function attach(doc, selected, { session, req }) {
  if (!selected) return;
  // Claim the source in the same transaction; simultaneous links conflict and retry.
  const claimed = await UserStatement.updateOne({ _id: selected._id, linkedCustomerRefundId: { $exists: false }, linkedBankRefundLineId: { $exists: false } },
    { $set: { linkedCustomerRefundId: doc._id } }, { session });
  if (claimed.modifiedCount !== 1) throw fail('حركة المحفظة مرتبطة باسترداد آخر؛ حدّث القائمة');
  doc.legacyWalletStatementId = selected._id;
  doc.legacyWalletEntryId = selected.entryId;
  doc.legacyWalletUsd = selected.usd;
  doc.legacyWalletKind = selected.kind;
  await doc.save({ session });
  await logAudit({ req, action: 'customer.linkPreviousRefund', model: 'AccountingCustomerRefund', docId: doc._id,
    after: { statementId: selected._id, entryId: selected.entryId, kind: selected.kind, usd: selected.usd } }, session);
}

// A separate browser: discovery across customers does not post or link anything.
async function listUnlinked(input = {}) {
  if (input.statementId && !mongoose.isValidObjectId(input.statementId)) throw fail('حركة المحفظة غير صالحة');
  if ((input.from && !isDay(input.from)) || (input.to && !isDay(input.to)) || (input.from && input.to && input.from > input.to)) throw fail('فترة البحث غير صالحة');
  if (input.kind && !['refund', 'compensation'].includes(input.kind)) throw fail('نوع الحركة غير صالح');
  const used = await CustomerRefund.distinct('legacyWalletStatementId', { status: 'posted' });
  const statements = await UserStatement.find({ calculationType: '+', actionType: input.kind || { $in: ['refund', 'compensation'] },
    'accountingSource.model': { $exists: false }, linkedCustomerRefundId: { $exists: false }, linkedBankRefundLineId: { $exists: false },
    _id: { $nin: used.filter(Boolean), ...(input.statementId && { $eq: input.statementId }) } })
    .sort({ createdAt: -1 }).limit(1001).populate({ path: 'user', model: require('../../../models/user'), select: 'firstName lastName customerId' }).lean();
  const ids = statements.map(s => s._id);
  const entries = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': { $in: ids }, status: 'posted', reversalOf: null,
    eventType: { $in: ['REFUND', 'COMPENSATION'] } }).select('source lines number day').lean();
  const waiting = new Set((await AccountingEvent.distinct('refId', { refId: { $in: ids }, status: { $in: ['pending', 'failed'] },
    type: { $in: ['statement', 'statementUpdated', 'statementDeleted'] } })).map(String));
  const { currencies } = await require('../config').getConfig();
  const q = String(input.q || '').trim().toLowerCase();
  const results = [];
  for (const statement of statements.slice(0, 1000)) {
    if (!statement.user || waiting.has(String(statement._id))) continue;
    const posted = entries.filter(e => String(e.source.id) === String(statement._id));
    if (posted.length !== 1) continue;
    const entry = posted[0], day = toDay(statement.createdAt);
    if ((input.from && day < input.from) || (input.to && day > input.to)) continue;
    const wallet = entry.lines.filter(l => String(l.partnerId) === String(statement.user._id) && l.credit > 0 && l.amountCurrency < 0);
    const decimals = currencies.get(statement.currency)?.decimals;
    if (wallet.length !== 1 || decimals == null || wallet[0].currency !== statement.currency
      || Math.round(Number(statement.amount) * 10 ** decimals) !== -wallet[0].amountCurrency) continue;
    const customerName = `${statement.user.firstName || ''} ${statement.user.lastName || ''}`.trim();
    if (q && ![customerName, statement.user.customerId, statement.description, statement.note, statement.amount, entry.number].join(' ').toLowerCase().includes(q)) continue;
    results.push({ _id: statement._id, partnerId: statement.user._id, customerName, customerId: statement.user.customerId,
      day, amount: statement.amount, currency: statement.currency, usd: wallet[0].credit, kind: statement.actionType,
      description: statement.description, note: statement.note, entryId: entry._id, entryNumber: entry.number });
  }
  const page = Math.max(1, parseInt(input.page, 10) || 1), pageSize = 30;
  return { results: results.slice((page - 1) * pageSize, page * pageSize), total: results.length, page, pageSize, truncated: statements.length > 1000 };
}

module.exports = { candidates, select, attach, listUnlinked };
