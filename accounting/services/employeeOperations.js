// Read original operational documents, not journal lines: one payment stays one operation.
const mongoose = require('mongoose');
const Statement = require('../../models/userStatement');
const WalletExchange = require('../../models/walletExchange');
const Payment = require('../../models/orderPaymentHistory');
const Order = require('../../models/order');
const Invoice = require('../../models/invoice');
const Deleted = require('../../models/deletedStatement');
const User = require('../../models/user');
const { JournalEntry, AuditLog, Account } = require('../models');
const docs = require('../models/documents');
const Review = require('../models/operationReview');
const { today, isDay, dayStart, dayEnd } = require('./dates');
const { logAudit } = require('./audit');
const ErrorHandler = require('../../utils/errorHandler');
const fail = (code, text) => new ErrorHandler(code, text);
const literal = value => ({ $literal: value });
const coalesce = (...values) => values.reduceRight((rest, value) => ({ $ifNull: [value, rest] }));
const url = (prefix, field = '$_id') => ({ $concat: [prefix, { $toString: field }] });
const orderUrl = (field = '$_id') => ({ $concat: ['/invoice/', { $toString: field }, '/edit'] });
const types = ['deposit', 'withdrawal', 'refund', 'compensation', 'wallet_payment', 'wallet_exchange', 'purchase_payment', 'shipping_payment',
  'purchase_invoice', 'shipping_order', 'shipping_invoice', 'supplier_bill', 'expense', 'supplier_payment', 'supplier_receipt', 'transfer', 'salary', 'change', 'manual_entry', 'yuan', 'netting', 'equity', 'writeoff'];
const condition = (test, yes, no) => ({ $cond: [test, yes, no] });

function sources() {
  const walletKind = { $switch: { branches: [
    { case: { $or: [{ $eq: ['$actionType', 'withdrawal'] }, { $eq: ['$paymentType', 'withdrawal'] }] }, then: 'withdrawal' },
    { case: { $in: ['$actionType', ['refund', 'cancellation']] }, then: 'refund' },
    { case: { $eq: ['$actionType', 'compensation'] }, then: 'compensation' },
    { case: { $eq: ['$calculationType', '-'] }, then: 'wallet_payment' },
  ], default: 'deposit' } };
  const base = [
    { model: Statement, match:{ walletExchangeId:{ $exists:false }, actionType:{ $ne:'exchange' } }, enteredAt: true, kind: walletKind, partner: '$user', amount: '$amount', url: url('/user/', '$user'),
      extra: [{ $lookup: { from: Payment.collection.name, localField: '_id', foreignField: 'statementId', as: '_payments' } },
        { $lookup: { from: docs.CustomerRefund.collection.name, let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $or: [{ $eq: ['$userStatementId', '$$id'] }, { $eq: ['$legacyWalletStatementId', '$$id'] }] } } }, { $limit: 1 }], as: '_refund' } },
        { $match: { '_refund.0': { $exists: false }, 'accountingSource.model': { $ne: 'AccountingNetting' } } }],
      category: condition({ $and: [{ $eq: ['$calculationType', '-'] }, { $not: [{ $in: ['$actionType', ['withdrawal', 'refund', 'cancellation', 'compensation']] }] }, { $ne: ['$paymentType', 'withdrawal'] }] },
        condition({ $in: ['invoice', '$_payments.category'] }, 'purchase_payment', condition({ $in: ['receivedGoods', '$_payments.category'] }, 'shipping_payment',
          condition({ $regexMatch: { input: coalesce('$description', literal('')), regex: 'تم دفع قيمة الشحن|بضاعة مستلمة' } }, 'shipping_payment',
            condition({ $regexMatch: { input: coalesce('$note', literal('')), regex: '\\border(?:\\s+(?:id|number|no\\.?))?[\\s:#(]*\\d', options: 'i' } }, 'purchase_payment', walletKind)))), walletKind) },
    { model: WalletExchange, enteredAt:true, kind:'wallet_exchange', partner:'$user', amount:{ $divide:['$fromMinor',100] }, currency:'$fromCurrency', url:url('/user/','$user'), status:coalesce('$posting.status',literal('pending')),
      description:{ $concat:[literal('صرافة محفظة: '),{$toString:{$divide:['$fromMinor',100]}},' ','$fromCurrency',' → ',{$toString:{$divide:['$toMinor',100]}},' ','$toCurrency'] } },
    { model: Payment, enteredAt: true, match: { statementId: null }, kind: condition({ $eq: ['$category', 'invoice'] }, 'purchase_payment', 'shipping_payment'), partner: '$customer', amount: '$receivedAmount', url: condition(coalesce('$order', literal(false)), orderUrl('$order'), url('/user/', '$customer')) },
    { model: Order, match: { $or: [{ totalInvoice: { $gt: 0 } }, { isPayment: true }, { isShipment: true }] }, actor: '$madeBy', partner: '$user', office: '$placedAt',
      kind: condition({ $or: ['$isPayment', { $gt: ['$totalInvoice', 0] }] }, 'purchase_invoice', 'shipping_order'),
      amount: condition({ $or: ['$isPayment', { $gt: ['$totalInvoice', 0] }] }, '$totalInvoice', literal(null)), currency: literal('USD'), number: '$orderId', description: literal('إنشاء طلبية'), url: orderUrl(), status: condition('$isDeleted', 'canceled', 'entered') },
    { model: Order, time: '$deletedAt', actor: '$deletedBy', suffix: '$deletedAt', kind: 'change', partner: '$user', office: '$placedAt', amount: literal(null), number: '$orderId', description: literal('إلغاء أو حذف طلبية'), url: url('/user/', '$user'), status: literal('deleted') },
    { model: Invoice, kind: condition({ $eq: ['$category', 'shipment'] }, 'shipping_invoice', 'purchase_invoice'), partner: '$customer', amount: '$total', number: { $concat: ['Invoice #', { $toString: '$referenceId' }] }, url: url('/user/', '$customer'), status: condition('$isCanceled', 'canceled', 'entered') },
    { model: Invoice, time: '$canceledAt', actor: '$canceledBy', suffix: '$canceledAt', kind: 'change', partner: '$customer', amount: literal(null), description: literal('إلغاء فاتورة تسليم'), url: url('/user/', '$customer'), status: literal('canceled') },
    { model: Deleted, time: '$deletedAt', actor: '$deletedBy', partner: '$user', kind: 'change', amount: literal(null), description: coalesce('$statement.description', literal('حذف حركة محفظة')), note: literal('حُذفت الحركة من كشف العميل'), url: url('/user/', '$user'), status: literal('deleted') },
    { model: AuditLog, time: '$at', actor: '$userId', kind: 'change', amount: literal(null),
      match: { action: { $regex: '(update|edit|delete|cancel|reverse)', $options: 'i' }, model: { $in: ['AccountingSupplierBill', 'AccountingSupplierPayment', 'AccountingTreasuryTransfer', 'AccountingCustomerRefund', 'AccountingSalaryPayment', 'AccountingJournalEntry', 'Order', 'Invoice'] } },
      description: literal('تعديل أو إلغاء مستند — التفاصيل في سجل التدقيق'), number: coalesce('$after.number', '$before.number', literal('')), note: '$action', url: literal('/accounting/audit') },
    { model: JournalEntry, match: { eventType: 'MANUAL', 'source.id': null, reversalOf: null, isHistorical: { $ne: true } }, kind: 'manual_entry', amount: { $divide: ['$totalDebit', 100] }, currency: literal('USD'), office: { $arrayElemAt: ['$lines.office', 0] }, url: url('/accounting/entries/') },
  ];
  const documentSources = [
    ['SupplierBill', condition({ $or: ['$officeExpense', '$isQuickExpense'] }, 'expense', 'supplier_bill'), '$total', '/accounting/bills/'],
    ['SupplierPayment', 'supplier_payment', '$amount', '/accounting/payments'],
    ['SupplierReceipt', 'supplier_receipt', '$amount', '/accounting/payments'],
    ['CustomerRefund', 'refund', '$amount', '/accounting/financial-operations'],
    ['TreasuryTransfer', 'transfer', '$fromAmount', '/accounting/treasury'],
    ['SalaryPayment', 'salary', { $subtract: ['$grossAmount', coalesce('$advanceDeduction', literal(0))] }, '/accounting/employees'],
    ['YuanPurchase', 'yuan', '$amount', '/accounting/alipay'],
    ['EquityTransaction', 'equity', '$amount', '/accounting/equity'],
    ['Netting', 'netting', { $divide: ['$amountUsd', 100] }, '/accounting/netting'],
    ['ClaimWriteOff', 'writeoff', { $divide: ['$amountUsd', 100] }, '/accounting/financial-operations'],
  ];
  for (const [name, kind, amount, path] of documentSources) base.push({ model: docs[name], match: { isHistorical: { $ne: true }, migrationRunId: null }, kind, amount,
    partner: coalesce('$partnerId', '$customerId'), ...(name === 'Netting' || name === 'ClaimWriteOff' ? { currency: literal('USD') } : {}), account: coalesce('$fromAccountId', '$paidFromAccountId', '$accountId', '$paidImmediatelyFrom'),
    office: coalesce('$office', { $arrayElemAt: ['$lines.office', 0] }),
    description: coalesce('$description', { $arrayElemAt: ['$lines.description', 0] }, '$note', '$number'),
    url: path.endsWith('/') ? url(path) : literal(path) });
  // Edits retain their own actor and timestamp, even on an old/backdated statement.
  base.push({ model: Statement, stages: [{ $unwind: '$editHistory' }], time: '$editHistory.editedAt', actor: '$editHistory.editedBy',
    suffix: '$editHistory.editedAt', kind: 'change', amount: literal(null), partner: '$user', description: '$description', note: literal('تعديل حركة محفظة'), url: url('/user/', '$user') });
  return base;
}

function pipeline(source, range, keys) {
  const time = source.enteredAt ? { $toDate: '$_id' } : source.time || '$createdAt';
  const match = { ...(source.match || {}), ...(source.enteredAt
    ? { _id: { $gte: mongoose.Types.ObjectId.createFromTime(Math.floor(range.$gte.getTime() / 1000)), $lt: mongoose.Types.ObjectId.createFromTime(Math.floor(range.$lte.getTime() / 1000) + 1) } }
    : { [time.slice(1)]: range }) };
  if (keys) match._id = { $in: keys.map(key => new mongoose.Types.ObjectId(key.split(':')[1])) };
  const kind = source.category || (typeof source.kind === 'string' ? literal(source.kind) : source.kind);
  return [...(source.stages || []), { $match: match }, ...(source.extra || []),
    ...(source.account ? [{ $lookup: { from: Account.collection.name, let: { id: source.account }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$id'] } } }, { $project: { office: 1, currency: 1 } }], as: '_account' } }] : []),
    { $project: {
      _id: 0, sourceId: '$_id', sourceModel: literal(source.model.modelName),
      key: { $concat: [source.model.modelName + ':', { $toString: '$_id' }, ...(source.suffix ? [':', { $toString: source.suffix }] : [])] },
      at: time, operationDay: coalesce('$day', { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: 'Africa/Tripoli' } }, { $dateToString: { date: time, format: '%Y-%m-%d', timezone: 'Africa/Tripoli' } }), actorId: source.actor || '$createdBy', partnerId: source.partner || literal(null),
      kind, amount: source.amount || literal(null), currency: source.currency || coalesce('$currency', { $arrayElemAt: ['$_account.currency', 0] }, literal('USD')),
      office: coalesce(source.office || '$office', { $arrayElemAt: ['$_account.office', 0] }, literal('')),
      officeCodes: { $filter: { input: { $setUnion: [coalesce('$lines.office', literal([])), [coalesce('$office', { $arrayElemAt: ['$_account.office', 0] }, literal(''))]] }, as: 'office', cond: { $and: [{ $ne: ['$$office', ''] }, { $ne: ['$$office', null] }] } } },
      number: source.number || coalesce('$number', literal('')), description: source.description || coalesce('$description', '$note', literal('')),
      note: source.note || '$note', status: source.status || coalesce('$status', literal('entered')), url: source.url,
      updatedAt: source.suffix ? time : coalesce('$updatedAt', time),
    } }];
}

function build(query, keys, onlySource) {
  const from = query.from || today(), to = query.to || today();
  if (!isDay(from) || !isDay(to) || from < '1970-01-01' || from > to || to > today()) throw fail(400, 'اختر فترة صحيحة لا تتجاوز اليوم');
  const range = { $gte: dayStart(from), $lte: dayEnd(to) };
  const definitions = onlySource ? [onlySource] : sources();
  const stages = pipeline(definitions[0], range, keys);
  for (const source of definitions.slice(1)) stages.push({ $unionWith: { coll: source.model.collection.name, pipeline: pipeline(source, range, keys) } });
  if (keys) stages.push({ $match: { key: { $in: keys } } });
  // Resolve actors and customer names for display and filters. Never infer the actor from the customer.
  stages.push({ $lookup: { from: User.collection.name, localField: 'actorId', foreignField: '_id', as: '_actor' } },
    { $lookup: { from: User.collection.name, localField: 'partnerId', foreignField: '_id', as: '_partner' } },
    { $set: { actor: { $arrayElemAt: ['$_actor', 0] }, partner: { $arrayElemAt: ['$_partner', 0] } } },
    { $set: { officeInferred: { $eq: ['$office', ''] }, office: condition({ $ne: ['$office', ''] }, '$office', coalesce('$actor.office', '$actor.city', literal(''))) } },
    { $set: { fingerprint: { $concat: ['$key', ':', { $toString: '$updatedAt' }, ':', { $toString: coalesce('$amount', literal(0)) }, ':', '$status', ':', '$currency', ':', '$office'] } } },
    { $lookup: { from: Review.collection.name, let: { key: '$key', fingerprint: '$fingerprint' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$key', '$$key'] }, { $eq: ['$fingerprint', '$$fingerprint'] }] } } }], as: '_review' } },
    { $set: { review: { $arrayElemAt: ['$_review', 0] }, reviewState: coalesce({ $arrayElemAt: ['$_review.state', 0] }, literal('pending')) } });
  const filter = {};
  if (query.employee) {
    if (!mongoose.isValidObjectId(query.employee)) throw fail(400, 'الموظف غير صالح');
    filter.actorId = new mongoose.Types.ObjectId(query.employee);
  }
  if (query.office) filter.$or = [{ office: String(query.office) }, { officeCodes: String(query.office) }];
  if (query.kind) { if (!types.includes(query.kind)) throw fail(400, 'نوع العملية غير صالح'); filter.kind = query.kind; }
  if (query.state) { if (!['pending', 'reviewed', 'issue'].includes(query.state)) throw fail(400, 'حالة المراجعة غير صالحة'); filter.reviewState = query.state; }
  stages.push({ $match: filter });
  return stages;
}

async function list(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page), limit = 30;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw fail(400, 'رقم الصفحة غير صالح');
  const stages = build(query);
  stages.push({ $facet: {
    results: [{ $sort: { at: -1, key: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
      { $lookup: { from: JournalEntry.collection.name, let: { id: '$sourceId', model: '$sourceModel' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$source.id', '$$id'] }, { $eq: ['$source.model', '$$model'] }] } } }, { $project: { _id: 1, status: 1, reversalOf: 1 } }], as: 'entries' } },
      { $lookup: { from: User.collection.name, localField: 'review.reviewedBy', foreignField: '_id', pipeline: [{ $project: { firstName: 1, lastName: 1 } }], as: 'reviewer' } },
      { $project: { _actor: 0, _partner: 0, _review: 0, actor: 0, partner: 0 } },
    ],
    total: [{ $count: 'count' }], states: [{ $group: { _id: '$reviewState', count: { $sum: 1 } } }],
    // These are operation values, not cash inflow/profit: invoices and their payments are different events.
    currencies: [{ $match: { amount: { $ne: null }, kind: { $ne: 'change' }, status: { $nin: ['canceled', 'deleted', 'reversed'] } } }, { $group: { _id: { currency: '$currency', kind: '$kind' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { '_id.kind': 1, '_id.currency': 1 } }],
  } });
  // Keep only names/codes from the joined users; never return credentials or private profile fields.
  stages.splice(stages.length - 1, 0, { $set: {
    actorName: { $trim: { input: { $concat: [coalesce('$actor.firstName', literal('')), ' ', coalesce('$actor.lastName', literal(''))] } } },
    partnerName: { $trim: { input: { $concat: [coalesce('$partner.firstName', literal('')), ' ', coalesce('$partner.lastName', literal(''))] } } }, customerCode: '$partner.customerId',
  } });
  const [data] = await Statement.aggregate(stages).allowDiskUse(true);
  return { ...data, total: data.total[0]?.count || 0, page, limit };
}

async function review(input, req, session) {
  if (!['pending', 'reviewed', 'issue'].includes(input.state)) throw fail(400, 'حالة المراجعة غير صالحة');
  if (typeof input.note !== 'string' || input.note.length > 1000 || (input.state === 'issue' && input.note.trim().length < 5)) throw fail(400, 'اكتب ملاحظة للمشكلة من 5 أحرف على الأقل، وبحد أقصى 1000 حرف');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100 || input.items.some(i => !i || typeof i.key !== 'string') || new Set(input.items.map(i => i.key)).size !== input.items.length) throw fail(400, 'اختر من 1 إلى 100 عملية مختلفة');
  const keys = input.items.map(item => {
    if (typeof item.key !== 'string' || !/^[A-Za-z]+:[a-f0-9]{24}(?::.*)?$/.test(item.key) || typeof item.fingerprint !== 'string') throw fail(400, 'مرجع العملية غير صالح');
    return item.key;
  });
  // MongoDB forbids unionWith inside transactions. Read each involved original collection
  // in the same transaction, using the identical normalization/fingerprint pipeline.
  const rows = [];
  for (const source of sources().filter(s => keys.some(key => key.startsWith(s.model.modelName + ':')))) {
    rows.push(...await source.model.aggregate(build({ from: '1970-01-01', to: today() }, keys, source)).option({ withDeleted: true }).session(session));
  }
  if (rows.length !== keys.length || rows.some(row => !input.items.some(i => i.key === row.key && i.fingerprint === row.fingerprint))) throw fail(409, 'تغيّرت إحدى العمليات؛ حدّث القائمة وراجعها مجددًا');
  const previous = await Review.find({ key: { $in: keys } }).session(session).lean();
  await Review.bulkWrite(rows.map(row => ({ updateOne: { filter: { key: row.key }, update: { $set: { fingerprint: row.fingerprint, state: input.state, note: input.note.trim(), reviewedBy: req.user._id } }, upsert: true } })), { session });
  await logAudit({ req, action: 'operations.review', model: 'AccountingOperationReview', before: previous, after: { keys, state: input.state, note: input.note.trim() } }, session);
  return { success: true, count: rows.length };
}
module.exports = { list, review, types };
