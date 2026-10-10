const { SupplierBill } = require('../../models/documents');
const Inventory = require('../../../models/inventory');
const { addDays } = require('../dates');

// Reuse the settlement matcher for posted trip bills, including paid historical costs.
// These are review proposals only: never produce an automatic posting instruction.
async function hints(lines, bank, settings, guess) {
  if (!settings.engines.includes('purchases')) return lines.map(() => []);
  const eligible = lines.map((line, index) => ({ ...line, _id: line._id || `preview:${index}` }))
    .filter(line => line.amount < 0 && !guess(line).semanticTransfer);
  if (!eligible.length) return lines.map(() => []);
  const days = eligible.map(line => line.day).sort();
  const tripIds = await SupplierBill.distinct('lines.tripId', { status: 'posted', isCreditNote: { $ne: true },
    'lines.tripId': { $ne: null }, day: { $gte: addDays(days[0], -settings.proposalDays), $lte: addDays(days[days.length - 1], settings.proposalDays) } });
  const trips = await Inventory.find({ _id: { $in: tripIds } }).select('voyage').lean();
  const matches = await require('../tripCostMatches').candidates(eligible, bank, trips, line => guess(line).vendorId);
  return lines.map((line, index) => (matches.get(String(line._id || `preview:${index}`)) || [])
    .filter(candidate => candidate.dayDifference <= settings.proposalDays && (!settings.requireIdentity || candidate.vendorIdentified || candidate.referenceMatch)));
}
module.exports = { hints };
