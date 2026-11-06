// node accounting/scripts/redateLateCosts.js [--apply]
//
// Costs recognised on the day they were typed instead of with their revenue: purchase invoices,
// trip shipping shares and customs clearance
// (owner's report 2026-11-06, order 4914-1641: revenue on 10-27, cost of 10-30/10-31 recognised on
// 11-02 because the order was edited that day and its revenue taken back and recognised again).
// The cause is fixed in claims/sync.js (revenueReachedDay); this corrects the entries already made.
//
// For each cost entry whose correct day is earlier than its day, only its date changes (owner,
// 2026-11-06: the date alone, no reversal and new entry): day, date and originalDay together, and a
// note on the entry says from which day, when and why. Amounts and accounts stay as they are, so
// the books stay balanced and the cost recorded per order is unchanged. Checked before: nothing
// keeps a copy of these entries (no Odoo export, no period approval, no lock date).
// Without --apply it only lists.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const { JournalEntry } = require('../models');
const { roleIds } = require('../services/claims/sync');
const { dayStart, today } = require('../services/dates');

const apply = process.argv.includes('--apply');
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;
const usd = (cents) => (cents / 100).toFixed(2);

const OID = '[0-9a-f]{24}';
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What a cost entry is, from its key: its work-in-progress account and lines, and its revenue's key
// (the same pairs claims/sync.js passes to costRecognitionDate). Null for a free package's share,
// which has no revenue to follow.
function kindOf(entry, a) {
  const key = entry.eventKey.replace(/^COST_RECOGNITION:/, '').replace(/:\d+$/, '');
  const orderId = entry.lines.find((l) => l.orderId)?.orderId;
  if (!orderId) return null;
  if (new RegExp(`^PUR:${OID}$`).test(key)) {
    return { kind: 'purchase', key, orderId, wip: a.purchase_cost_wip, wipMatch: { orderId }, revenueKey: key };
  }
  let match = key.match(new RegExp(`^SHP:(${OID}):(${OID}):CUS$`));
  if (match) {
    return { kind: 'customs', key, orderId, wip: a.customs_cost_wip, wipMatch: { orderId, packageId: new mongoose.Types.ObjectId(match[2]) }, revenueKey: key };
  }
  match = key.match(new RegExp(`^(${OID}):(${OID})$`));
  if (match && !/شحن مجاني/.test(entry.description || '')) {
    return { kind: 'shipping', key, orderId, wip: a.trip_cost_wip, wipMatch: { tripId: new mongoose.Types.ObjectId(match[2]) }, revenueKey: `SHP:${orderId}:${match[1]}` };
  }
  return null;
}

// The same rule as claims/sync.js costRecognitionDate, as of the entry's day
async function correctDay(entry, a, kind) {
  const [wip] = await JournalEntry.aggregate([
    { $match: { status: 'posted', eventType: { $ne: 'COST_RECOGNITION' }, day: { $lte: entry.day },
      lines: { $elemMatch: { accountId: kind.wip._id, ...kind.wipMatch, debit: { $gt: 0 } } } } },
    { $group: { _id: null, day: { $max: '$day' } } },
  ]);
  if (!wip) return null;
  const deferred = new Set([a.deferred_purchase_revenue, a.deferred_shipping_revenue].map((acc) => String(acc._id)));
  const revenue = await JournalEntry.find({ status: 'posted', eventType: 'RECOGNITION', eventKey: { $regex: `^RECOGNITION:${escapeRegex(kind.revenueKey)}:` }, day: { $lte: entry.day } })
    .select('day lines.accountId lines.debit lines.credit').sort({ day: 1 }).lean();
  const byDay = new Map();
  for (const e of revenue) byDay.set(e.day, (byDay.get(e.day) || 0) + e.lines.reduce((s, l) => (deferred.has(String(l.accountId)) ? s + (l.debit || 0) - (l.credit || 0) : s), 0));
  const total = [...byDay.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  let running = 0;
  let reached = null;
  for (const [day, amount] of byDay) { running += amount; if (running >= total) { reached = day; break; } }
  if (!reached) return null;
  const day = reached > wip.day ? reached : wip.day;
  return day < entry.day ? day : null;
}

async function main() {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  console.log(`Database: ${mongoose.connection.db.databaseName}${apply ? '' : '  (dry run: add --apply to correct)'}`);
  const a = await roleIds();
  const entries = await JournalEntry.find({ eventType: 'COST_RECOGNITION', status: 'posted', isHistorical: { $ne: true }, reversalOf: null,
    eventKey: /^COST_RECOGNITION:/ }).sort({ day: 1 }).lean();
  // The go-live day settled the historical trips' differences on that day by design (3,419 shares
  // of old trips on 10-31): they are not late costs and are left alone
  const { migrationDate, lockDate } = (await mongoose.connection.db.collection('accountingsettings').findOne({}, { projection: { migrationDate: 1, lockDate: 1 } })) || {};
  const found = [];
  for (const entry of entries) {
    if (migrationDate && entry.day <= migrationDate) continue;
    const kind = kindOf(entry, a);
    if (!kind) continue;
    // Only a cost moved in (work in progress credited); a cost taken back keeps its day
    const amount = entry.lines.reduce((s, l) => (String(l.accountId) === String(kind.wip._id) ? s + (l.credit || 0) - (l.debit || 0) : s), 0);
    if (amount <= 0) continue;
    const day = await correctDay(entry, a, kind);
    if (day) found.push({ entry, orderId: kind.orderId, day, amount, kind });
  }
  let fixed = 0;
  for (const { entry, orderId, day, amount, kind } of found) {
    const order = await mongoose.connection.db.collection('orders').findOne({ _id: orderId }, { projection: { orderId: 1 } });
    const label = `${entry.number}  ${kind.kind.padEnd(8)} order ${order?.orderId || orderId}  $${usd(amount)}  ${entry.day} -> ${day}`;
    if (!apply) { console.log(`would correct  ${label}`); continue; }
    try {
      // A closed period is never written into, whichever side of the move it is on
      if (lockDate && (day <= lockDate || entry.day <= lockDate)) throw new Error(`الفترة مقفلة حتى ${lockDate}`);
      const note = `صُحّح التاريخ من ${entry.day} إلى ${day} في ${today()}: تكلفة الطلب تُعترف بيوم إيرادها لا بيوم إدخالها`;
      // Only if the entry is still as it was read (posted, same day): never a second time
      const result = await JournalEntry.updateOne({ _id: entry._id, status: 'posted', day: entry.day },
        { $set: { day, date: dayStart(day), originalDay: day }, $push: { notes: note } });
      if (result.modifiedCount !== 1) throw new Error('changed meanwhile');
      console.log(`corrected      ${label}`);
      fixed += 1;
    } catch (error) {
      console.log(`NOT corrected  ${label}: ${error.message}`);
    }
  }
  console.log(`\n${apply ? `Corrected ${fixed} of ${found.length}` : `Would correct ${found.length}`} cost entr${found.length === 1 ? 'y' : 'ies'}, $${usd(found.reduce((s, f) => s + f.amount, 0))}.`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
