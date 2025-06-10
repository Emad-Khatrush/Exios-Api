const calculateTotalWallet = (wallet) => {
  let totalUsd = 0, totalLyd = 0;
  (wallet || []).forEach((w) => {
    if (w.currency === 'USD') totalUsd += w.balance
    else if (w.currency === 'LYD') totalLyd += w.balance;
  })

  return { totalUsd, totalLyd }
}

module.exports = { calculateTotalWallet };
