const { handle } = require('./util');
const service = require('../services/employees');
const { runInTransaction } = require('../services/transaction');
const tx = fn => handle(async (req, res) => res.json(await runInTransaction(session => fn(req, { session, req }))));
exports.create = tx((req, context) => service.save(null, req.body, context));
exports.update = tx((req, context) => service.save(req.params.id, req.body, context));
exports.archive = tx(async (req, context) => { await service.setActive(req.params.id, false, context); return { ok: true }; });
exports.restore = tx(async (req, context) => { await service.setActive(req.params.id, true, context); return { ok: true }; });
exports.detail = handle(async (req, res) => res.json(await service.detail(req.params.id)));
exports.preview = handle(async (req, res) => res.json(await (req.query.paymentKind === 'commission'
  ? service.commissionPreview(req.params.id, req.query.month, req.query.currency, null, req.query.day, req.query.rate)
  : service.preview(req.params.id, req.query.month, req.query.currency, null, req.query.day, req.query.rate))));
exports.adjustment = tx((req, context) => service.addAdjustment(req.params.id, req.body, context));
exports.cancelAdjustment = tx(async (req, context) => { await service.cancelAdjustment(req.params.id, req.params.adjustmentId, context); return { ok: true }; });
exports.closeCommission = tx((req, context) => service.settleCommissionRemainder(req.params.id, req.params.adjustmentId, req.body, false, context));
exports.reopenCommission = tx((req, context) => service.settleCommissionRemainder(req.params.id, req.params.adjustmentId, req.body, true, context));
