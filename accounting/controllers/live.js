const { AccountingEvent } = require('../models');
const { handle, notFound } = require('./util');
const { getConfig } = require('../services/config');
const { processQueue, processEvent } = require('../services/events');
const { runInTransaction } = require('../services/transaction');
const { logAudit } = require('../services/audit');

// Live posting status and the queue of operations waiting to be posted
module.exports.status = handle(async (req, res) => {
  const { settings } = await getConfig();
  const counts = await AccountingEvent.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  res.json({
    liveEnabled: !!settings?.liveEnabled,
    migrationDate: settings?.migrationDate || null,
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
  });
});

module.exports.list = handle(async (req, res) => {
  const query = req.query.status ? { status: req.query.status } : {};
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const events = await AccountingEvent.find(query).sort({ createdAt: -1 }).limit(limit).populate('userId', 'firstName lastName').lean();
  res.json({ results: events });
});

module.exports.retry = handle(async (req, res) => {
  const event = await AccountingEvent.findById(req.params.id);
  if (!event) throw notFound('العملية غير موجودة');
  const result = await processEvent(event, { resetAttempts: true });
  await runInTransaction((session) => logAudit({ req, action: 'live.retry', model: 'AccountingEvent', docId: event._id, after: { status: result.status } }, session));
  res.json(result);
});

module.exports.process = handle(async (req, res) => {
  res.json(await processQueue({ limit: 200 }));
});
