const User = require('../models/user');

// All first-time wallet credits contend on the customer before checking for a wallet.
async function lockWalletOwner(userId, session) {
  if (!session) return;
  await User.updateOne({ _id: userId?._id || userId }, { $inc: { walletPostingVersion: 1 } }, { session });
}
module.exports = { lockWalletOwner };
