const fs = require('node:fs');
const puppeteer = require('puppeteer');

const reportBrowserOptions = () => {
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH
    || process.env.GOOGLE_CHROME_BIN || process.env.CHROME_BIN;
  const candidates = explicit ? [explicit] : [
    puppeteer.executablePath(),
    '/app/.chrome-for-testing/chrome-linux64/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const executablePath = candidates.find(filename => fs.existsSync(filename));
  if (!executablePath) {
    const error = new Error(`Chrome for flight PDFs was not found. Run npm run postinstall during deployment, or set PUPPETEER_EXECUTABLE_PATH to an installed Chrome. Cache: ${require('../.puppeteerrc.cjs').cacheDirectory}`);
    error.code = 'PDF_CHROME_NOT_FOUND';
    throw error;
  }
  return {
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--renderer-process-limit=1'],
  };
};

module.exports = { reportBrowserOptions };
