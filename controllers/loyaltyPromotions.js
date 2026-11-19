// Points offers over HTTP (spec 2026-11-19-loyalty-promotions-design.md): staff manage them, customers
// read the running and upcoming ones. The rules live in accounting/services/loyalty/promotions.js.
const loyalty = require('../accounting/services/loyalty');
const promotions = require('../accounting/services/loyalty/promotions');
const { runInTransaction } = require('../accounting/services/transaction');

const handle = (fn) => async (req, res, next) => {
  try {
    res.status(200).json(await fn(req));
  } catch (error) {
    next(error);
  }
};

// After a change, an offer that has already started is announced at once (not waited for)
const announceSoon = () => {
  if (typeof promotions.announceStarted === 'function') promotions.announceStarted().catch((error) => console.error('[loyalty] promotions:', error.message));
};

module.exports.list = handle(() => promotions.listForStaff());

module.exports.create = handle(async (req) => {
  const created = await runInTransaction((session) => promotions.create(req.body, { user: req.user, session }));
  announceSoon();
  return created;
});

module.exports.update = handle(async (req) => {
  const updated = await runInTransaction((session) => promotions.update(req.params.id, req.body, { session }));
  announceSoon();
  return updated;
});

module.exports.end = handle((req) => runInTransaction((session) => promotions.endNow(req.params.id, { session })));

module.exports.remove = handle(async (req) => {
  await runInTransaction((session) => promotions.remove(req.params.id, { session }));
  return { deleted: true };
});

// Customers: what is running or about to; nothing when their points are switched off
module.exports.mine = handle(async (req) => (await loyalty.isOff(req.user._id) ? { off: true } : { promotions: await promotions.activeForCustomers() }));
