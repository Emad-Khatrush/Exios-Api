const path = require('node:path');
const os = require('node:os');

// Read by both the browser installer and the running application. Keep Linux
// downloads inside the deployment so they survive the build-to-runtime move.
module.exports = {
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || (
    process.platform === 'linux'
      ? path.join(__dirname, '.cache', 'puppeteer')
      : path.join(os.homedir(), '.cache', 'puppeteer')
  ),
};
