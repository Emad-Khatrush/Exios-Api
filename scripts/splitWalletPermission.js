// node scripts/splitWalletPermission.js [--apply]
//
// The 'wallets' staff permission used to cover both the wallets list and putting money in or taking
// it out of a wallet. On 2026-11-16 the owner split it: 'wallets' is now the list only, deposit /
// withdrawal / cancelling a wallet payment is 'wallet_transactions', and exchange is 'wallet_exchange'.
// Staff saved with 'wallets' before the split get 'wallet_transactions' too, so they keep depositing
// and withdrawing; the owner then unticks it for whoever should only look. 'wallet_exchange' is NOT
// given here: the owner ticks it by hand for whoever should exchange.
// Without --apply it only lists who would change. Run it once, right after deploying the split.
//
//   MIGRATE_URI  the database (default: MONGO_URL_2 / MONGO_URL, as the app uses)
//
// Safe to run again only before anyone is saved with 'wallets' alone on purpose: it adds the new key
// to everyone who has 'wallets' and lacks it.
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

const apply = process.argv.includes('--apply');
const uri = process.env.MIGRATE_URI || process.env.MONGO_URL_2 || process.env.MONGO_URL;

async function main() {
  if (!uri) throw new Error('Set MIGRATE_URI (or MONGO_URL) to the database.');
  await mongoose.connect(uri);
  console.log(`Database: ${mongoose.connection.db.databaseName}${apply ? '' : '  (dry run: add --apply to change)'}`);
  const filter = { 'staffAccess.kind': { $exists: true, $ne: null }, 'staffAccess.permissions': { $all: ['wallets'], $ne: 'wallet_transactions' } };
  const users = await User.find(filter, { firstName: 1, lastName: 1, username: 1, 'staffAccess.kind': 1 }).lean();
  users.forEach((u) => console.log(`${apply ? 'given' : 'would give'}  ${u.firstName || ''} ${u.lastName || ''} (${u.username || u._id}, ${u.staffAccess?.kind})`));
  if (apply && users.length) {
    const result = await User.updateMany({ _id: { $in: users.map((u) => u._id) } }, { $addToSet: { 'staffAccess.permissions': 'wallet_transactions' } });
    console.log(`Updated ${result.modifiedCount} staff member(s).`);
  } else {
    console.log(`${users.length} staff member(s) ${apply ? 'to update' : 'would be updated'}.`);
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
