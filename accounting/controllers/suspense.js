const { handle, badRequest } = require('./util');
const { runInTransaction } = require('../services/transaction');
const suspense = require('../services/suspense');

const MAX_ITEMS = 200;

module.exports.list = handle(async (req, res) => {
  const { cause, search, from, to, limit } = req.query;
  res.json(await suspense.listOpen({ cause, search, from, to, limit }));
});

// Body: { items: [id], accountId, partnerId?, arKey?, office?, day?: 'YYYY-MM-DD' | 'original', note? }
// Each item is its own transaction, so one refusal does not stop the others
module.exports.settle = handle(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) throw badRequest('حدّد بنداً واحداً على الأقل');
  if (items.length > MAX_ITEMS) throw badRequest(`الحد الأقصى ${MAX_ITEMS} بنداً في المرة الواحدة`);
  const failures = [];
  let settled = 0;
  for (const id of items) {
    try {
      await runInTransaction((session) => suspense.settleItem(id, req.body, { session, req }));
      settled++;
    } catch (error) {
      failures.push({ id, message: error.message });
    }
  }
  res.json({ settled, failures });
});
