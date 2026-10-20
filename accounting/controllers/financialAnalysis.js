const { handle } = require('./util');
const service = require('../services/reports/financialAnalysis');
const { runInTransaction } = require('../services/transaction');
exports.overview = handle(async (req, res) => res.json(await service.overview(req.query)));
exports.configuration = handle(async (req, res) => res.json(await service.configuration()));
exports.plan = handle(async (req, res) => res.json(await service.readPlan(req.query)));
exports.saveSettings = handle(async (req, res) => res.json(await runInTransaction(session => service.saveSettings(req.body, { session, req }))));
exports.savePeriod = handle(async (req, res) => res.json(await runInTransaction(session => service.savePeriod(req.body, { session, req }))));
