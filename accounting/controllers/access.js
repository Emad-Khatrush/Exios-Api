const { handle } = require('./util');
const { logAudit } = require('../services/audit');
const access = require('../services/access');

// What the signed-in user may do, for the screens to show only that
module.exports.me = handle(async (req, res) => {
  res.json({ isOwner: req.access.isOwner, permissions: req.access.permissions });
});

// Every admin and accountant with their permissions, and the choices the owner has
module.exports.members = handle(async (req, res) => {
  res.json({ results: await access.listMembers(), permissions: access.PERMISSIONS, presets: access.PRESETS });
});

// { permissions: [...] }; an empty list takes all access away
module.exports.saveMember = handle(async (req, res) => {
  const before = (await access.listMembers()).find((m) => String(m._id) === String(req.params.userId));
  const saved = await access.setMember(req.params.userId, req.body?.permissions, req.user);
  await logAudit({ req, action: 'access.member', model: 'AccountingMember', docId: saved?._id, before: { userId: req.params.userId, permissions: before?.permissions || [] }, after: { userId: req.params.userId, permissions: saved?.permissions || [] } });
  res.json(saved);
});
