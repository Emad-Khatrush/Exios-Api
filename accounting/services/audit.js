const { AuditLog } = require('../models');

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

async function logAudit({ req, user, action, model, docId, before, after }, session) {
  await AuditLog.create([{
    userId: user?._id || req?.user?._id,
    action,
    model,
    docId,
    before: plain(before),
    after: plain(after),
    ip: req?.ip,
    at: new Date(),
  }], { session });
}

module.exports = { logAudit };
