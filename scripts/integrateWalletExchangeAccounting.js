// Run once after merging accounting: node scripts/integrateWalletExchangeAccounting.js --apply
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../accounting/services/posting/operations.js');
if (!fs.existsSync(file)) {
  console.error('Accounting is not present. No files changed. Run this after the approved accounting merge.');
  process.exitCode = 1;
} else {
  const source = fs.readFileSync(file, 'utf8');
  const marker = "  if (!statement) return { skipped: 'statement not found' };";
  const hook = "  if (statement.walletExchangeId) return require('../../../utils/walletExchangeAccounting').postExchange(statement.walletExchangeId, options);";
  if (source.includes(hook)) console.log('Wallet exchange accounting integration is already installed.');
  else if (!source.includes(marker)) { console.error('Accounting statement entry point changed; review the integration patch. No files changed.'); process.exitCode = 1; }
  else if (process.argv.includes('--apply')) {
    fs.writeFileSync(file, source.replace(marker, `${marker}\n${hook}`));
    console.log('Installed wallet exchange integration for live events and historical replay.');
  } else { console.log('Integration is compatible. Use --apply after the approved accounting merge.'); }
}
