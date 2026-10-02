const { handle, badRequest, isObjectId } = require('./util');
const { isDay } = require('../services/dates');
const { runInTransaction } = require('../services/transaction');
const statements = require('../services/reports/statements');
const operations = require('../services/reports/operations');
const exceptions = require('../services/reports/exceptions');
const closing = require('../services/closing');
const summaries = require('../services/reports/summaries');
const customers = require('../services/reports/customers');
const vouchers = require('../services/vouchers');

const period = (query) => {
  const { from, to, asOf } = query;
  [from, to, asOf].forEach((day) => { if (day && !isDay(day)) throw badRequest('التاريخ غير صالح'); });
  return { from: from || undefined, to: to || undefined, asOf: asOf || undefined };
};

module.exports.incomeStatement = handle(async (req, res) => {
  const columns = ['month', 'year', 'office'].includes(req.query.columns) ? req.query.columns : undefined;
  res.json(await statements.incomeStatement({ ...period(req.query), office: req.query.office || undefined, columns }));
});
module.exports.balanceSheet = handle(async (req, res) => res.json(await statements.balanceSheet(period(req.query))));
module.exports.cashFlow = handle(async (req, res) => res.json(await statements.cashFlow(period(req.query))));
module.exports.cashMovements = handle(async (req, res) => res.json(await statements.cashMovements(period(req.query))));
module.exports.fx = handle(async (req, res) => res.json(await statements.fxReport(period(req.query))));

module.exports.trips = handle(async (req, res) => {
  const { status, search, shippingType } = req.query;
  res.json(await operations.tripProfitability({ status: status || undefined, search: search || undefined, shippingType: shippingType || undefined }));
});
module.exports.purchases = handle(async (req, res) => {
  res.json(await operations.purchaseProfitability({ search: req.query.search || undefined, onlyWithoutCost: req.query.withoutCost === 'true' }));
});
module.exports.receivables = handle(async (req, res) => {
  const partnerId = isObjectId(req.query.partnerId) ? req.query.partnerId : undefined;
  res.json(await operations.receivables({ ...period(req.query), partnerId }));
});
module.exports.customerStatement = handle(async (req, res) => {
  if (!isObjectId(req.params.id)) throw badRequest('العميل غير صالح');
  res.json(await operations.customerStatement(req.params.id, { ...period(req.query), showCanceled: req.query.showCanceled }));
});
module.exports.payables = handle(async (req, res) => res.json(await operations.payables(period(req.query))));

module.exports.customers = handle(async (req, res) => {
  const view = ['all', 'owing', 'wallet', 'mismatch'].includes(req.query.view) ? req.query.view : 'all';
  res.json(await customers.customersList({ search: String(req.query.search || '').trim() || undefined, view }));
});
module.exports.customerInvoices = handle(async (req, res) => {
  const { search, kind, status, office, userId } = req.query;
  res.json(await customers.customerInvoices({
    ...period(req.query), search: String(search || '').trim() || undefined, office: office || undefined,
    kind: ['purchase', 'shipment'].includes(kind) ? kind : undefined,
    status: ['unpaid', 'partial', 'paid', 'none', 'canceled'].includes(status) ? status : undefined,
    userId: isObjectId(userId) ? userId : undefined,
  }));
});

const objectId = (id, what) => { if (!isObjectId(id)) throw badRequest(`${what} غير صالح`); return id; };
module.exports.orderSummary = handle(async (req, res) => res.json(await summaries.orderSummary(objectId(req.params.id, 'الطلب'))));
module.exports.tripSummary = handle(async (req, res) => res.json(await summaries.tripSummary(objectId(req.params.id, 'الرحلة'))));
module.exports.customerSummary = handle(async (req, res) => res.json(await summaries.customerSummary(objectId(req.params.id, 'العميل'))));
module.exports.voucher = handle(async (req, res) => {
  res.json(await runInTransaction((session) => vouchers.getVoucher(objectId(req.params.entryId, 'القيد'), { session, user: req.user })));
});

// The last stored daily run, or a fresh one with ?run=true
module.exports.exceptions = handle(async (req, res) => {
  if (req.query.run === 'true') return res.json(await exceptions.runAndStore());
  res.json((await exceptions.latest()) || (await exceptions.runAndStore()));
});

module.exports.monthChecklist = handle(async (req, res) => res.json(await closing.monthChecklist(String(req.query.month || ''))));
module.exports.closeMonth = handle(async (req, res) => {
  const result = await runInTransaction((session) => closing.closeMonth(String(req.body?.month || ''), { session, req }));
  closing.refreshConfig();
  res.json(result);
});
module.exports.yearStatus = handle(async (req, res) => res.json(await closing.yearStatus(String(req.query.year || ''))));
module.exports.closeYear = handle(async (req, res) => {
  const result = await runInTransaction((session) => closing.closeYear(String(req.body?.year || ''), { session, req }));
  closing.refreshConfig();
  res.json(result);
});
module.exports.reopenYear = handle(async (req, res) => {
  const result = await runInTransaction((session) => closing.reopenYear(String(req.body?.year || ''), { session, req, reason: req.body?.reason }));
  closing.refreshConfig();
  res.json(result);
});
