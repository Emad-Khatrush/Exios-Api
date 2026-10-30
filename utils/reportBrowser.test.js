const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { reportBrowserOptions } = require('./reportBrowser');

test('production dependency pruning keeps Puppeteer and its browser launcher', () => {
  const manifest = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(manifest.devDependencies.puppeteer, undefined);
  assert.equal(manifest.dependencies.puppeteer, lock.packages['node_modules/puppeteer'].version);
  for (const name of ['puppeteer', 'puppeteer-core', '@puppeteer/browsers']) {
    assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
  }
});

test('Linux build and runtime use a browser cache inside the deployed application', () => {
  const filename = path.join(__dirname, '..', '.puppeteerrc.cjs');
  const context = { require, __dirname: '/app', process: { platform: 'linux', env: {} }, module: { exports: {} } };
  const source = `(function () { ${fs.readFileSync(filename, 'utf8')} })()`;
  vm.runInNewContext(source, context);
  assert.equal(context.module.exports.cacheDirectory.replace(/\\/g, '/'), '/app/.cache/puppeteer');
  context.__dirname = '/tmp/build/application';
  vm.runInNewContext(source, context);
  assert.equal(context.module.exports.cacheDirectory.replace(/\\/g, '/'), '/tmp/build/application/.cache/puppeteer');
  context.process.env.PUPPETEER_CACHE_DIR = '/custom/cache';
  vm.runInNewContext(source, context);
  assert.equal(context.module.exports.cacheDirectory, '/custom/cache');
});

test('an invalid explicit Chrome path reports an actionable error', () => {
  const saved = process.env.PUPPETEER_EXECUTABLE_PATH;
  process.env.PUPPETEER_EXECUTABLE_PATH = path.join(__dirname, 'nonexistent-chrome');
  try {
    assert.throws(() => reportBrowserOptions(), { code: 'PDF_CHROME_NOT_FOUND' });
  } finally {
    if (saved === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = saved;
  }
});

test('production mode can generate a branded Arabic PDF with a large package list', async () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { buildFlightReport } = require('./flightReport');
    const rows = Array.from({ length: 120 }, (_, i) => ({
      orderId: `ORDER-${i}`, user: { customerId: 'N999', firstName: 'محمد', lastName: 'علي' },
      paymentList: { deliveredPackages: { trackingNumber: `TRACK-${i}`, weight: { total: 2, measureUnit: 'KG' }, exiosPrice: 10 } },
    }));
    const pdf = await buildFlightReport({ voyage: 'PROD-CHECK', shippingType: 'air' }, rows, { customerOnly: true });
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 10000);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
});
