// The offices' sub cash boxes (spec v8): what each holds, the main box it hands over to, and the
// accountant's one-step hand-over of the whole balance (a treasury transfer, same currency).
const { getConfig } = require('./config');
const { getBalance } = require('./carrying');
const { today } = require('./dates');
const ErrorHandler = require('../../utils/errorHandler');

async function subBoxes({ session } = {}) {
  const { settings, accountsById, currencies } = await getConfig();
  const rows = [];
  for (const [office, map] of Object.entries(settings?.subOfficeAccounts || {})) {
    for (const [currency, id] of Object.entries(map || {})) {
      const sub = accountsById.get(String(id));
      if (!sub || !sub.isActive) continue;
      const main = accountsById.get(String(settings?.officeAccounts?.[office]?.[currency] || ''));
      const balance = await getBalance(sub._id, { session });
      const decimals = currencies.get(currency)?.decimals ?? 2;
      rows.push({
        office, currency, decimals, subId: sub._id, subCode: sub.code, subName: sub.name,
        mainId: main?._id || null, mainCode: main?.code || null, mainName: main?.name || null,
        foreign: currency === 'USD' ? balance.usd : balance.foreign, usd: balance.usd,
      });
    }
  }
  return rows;
}

// Moves everything in a sub box to its main box, today
async function handOver(subId, { session, req, amount }) {
  const row = (await subBoxes({ session })).find((r) => String(r.subId) === String(subId));
  if (!row) throw new ErrorHandler(400, 'الخزينة الفرعية غير موجودة');
  if (!row.mainId) throw new ErrorHandler(400, 'لا توجد خزينة رئيسية لهذا المكتب بهذه العملة');
  const value = amount !== undefined ? Number(amount) : row.foreign / 10 ** row.decimals;
  if (!(value > 0)) throw new ErrorHandler(400, 'لا رصيد في الخزينة الفرعية');
  const { createTransfer } = require('./posting/treasury');
  return createTransfer({
    day: today(), fromAccountId: row.subId, toAccountId: row.mainId, fromAmount: value, toAmount: value,
    note: `توريد ${row.subName} إلى ${row.mainName}`,
  }, { session, req });
}

module.exports = { subBoxes, handOver };
