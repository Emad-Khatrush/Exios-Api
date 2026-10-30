// Explicitly run against a built frontend: STAGE10_BUILD=<absolute build directory>.
// Every API request uses the isolated replica set; external network requests are blocked.
jest.mock('../../utils/googleClould', () => ({ storage: {}, uploadToGoogleCloud: async () => ({}), deleteFromGoogleCloud: async () => {} }));
jest.mock('../../utils/messageQueue', () => ({ add: async () => {}, process: () => {}, getJobs: async () => [] }));
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb, account, oid, post } = require('./helpers');
const { OWNER_ID, expectConsistent, usd } = require('./e2eKit');
const { AccountingSettings, JournalEntry, CurrencyRate } = require('../models');
const { invalidateConfig } = require('../services/config');
const User = require('../../models/user');
const Wallet = require('../../models/wallet');

const suite = process.env.STAGE10_BUILD ? describe : describe.skip;
suite('stage 10: real production frontend against isolated accounting', () => {
  jest.setTimeout(120000);
  let server, browser, page, base, owner, customer;
  let abortWalletDeposit = false;
  const errors = [];
  const failed = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function clickText(text, scope = 'button') {
    const selector = await page.evaluate((text, scope) => {
      const nodes = Array.from(document.querySelectorAll(scope));
      const node = nodes.find(n => n.textContent.trim() === text);
      if (!node) throw Error(`Missing button: ${text}`);
      node.setAttribute('data-stage10-click', 'target');
      return '[data-stage10-click="target"]';
    }, text, scope);
    await page.click(selector);
    await page.evaluate(() => document.querySelector('[data-stage10-click]')?.removeAttribute('data-stage10-click'));
  }
  async function type(selector, value) {
    await page.waitForSelector(selector);
    await page.click(selector, { clickCount: 3 });
    await page.type(selector, value);
  }
  async function field(label, scope = '.acc-main') {
    return page.evaluate((label, scope) => {
      const node = Array.from(document.querySelectorAll(`${scope} label`)).find(n => n.textContent.trim().replace(/\s*\*$/, '') === label);
      if (!node) throw Error(`Missing field: ${label}`);
      return `#${CSS.escape(node.htmlFor)}`;
    }, label, scope);
  }
  async function select(selector, value) {
    await page.click(selector);
    await page.waitForSelector('[role="listbox"]');
    const option = await page.evaluate(value => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const node = options.find(n => n.getAttribute('data-value') === value || n.textContent.includes(value));
      if (!node) throw Error(`Missing option: ${value}`);
      node.setAttribute('data-stage10-option', 'target');
      return '[data-stage10-option="target"]';
    }, value);
    await page.click(option);
    await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
    await pause(250);
  }
  async function namedSelect(name, value) {
    const selector = await page.evaluate(name => {
      const node = document.querySelector(`input[name="${name}"]`).closest('.MuiFormControl-root').querySelector('.MuiSelect-select');
      node.setAttribute('data-stage10-select', name);
      return `[data-stage10-select="${name}"]`;
    }, name);
    await select(selector, value);
  }
  async function autocomplete(label, value, scope) {
    await type(await field(label, scope), value);
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]');
    await pause(250);
  }
  async function go(route) {
    await page.goto(base + route, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.acc-layout, .otherpages', { timeout: 20000 });
    await pause(100);
  }
  beforeAll(async () => {
    process.env.JWT_SECRET = 'isolated-stage10-secret';
    process.env.ACCOUNTING_DEV_ALL_ADMINS = 'false';
    const build = path.resolve(process.env.STAGE10_BUILD);
    if (!fs.existsSync(path.join(build, 'index.html'))) throw Error('Build the frontend before running browser acceptance');
    await startDb();
    await resetDb();
    await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
    invalidateConfig();
    await CurrencyRate.create({ currency: 'LYD', day: '2026-01-01', rate: 10 });
    owner = { _id: new mongoose.Types.ObjectId(OWNER_ID), username: 'stage10-owner', firstName: 'Owner', lastName: 'Test', phone: 910100001, customerId: 'OWN', office: 'tripoli', roles: { isAdmin: true, isEmployee: true } };
    customer = { _id: oid(), username: 'stage10-customer', firstName: 'Customer', lastName: 'Test', phone: 910100002, customerId: 'C010', roles: { isClient: true } };
    await User.collection.insertMany([owner, customer]);
    const app = express();
    app.use(express.json());
    app.use('/api/accounting', require('../routes'));
    app.use('/api', require('../systemRoutes'));
    for (const route of ['users', 'wallet', 'orders', 'balance', 'settings', 'inventory']) app.use('/api', require(`../../routes/${route}`));
    app.use('/api', (req, res) => res.status(404).json({ message: 'Unknown isolated API endpoint' }));
    app.use(require('../../middleware/error'));
    app.use(express.static(build));
    app.get('*', (req, res) => res.sendFile(path.join(build, 'index.html')));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: 1440, height: 1050 });
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (abortWalletDeposit && req.method() === 'POST' && req.url().includes('/api/wallet/')) return req.abort();
      return req.url().startsWith(base + '/') || req.url().startsWith('data:') ? req.continue() : req.abort();
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', res => { if (res.url().startsWith(base + '/api/') && res.status() >= 400) failed.push({ url: res.url().replace(base, ''), status: res.status() }); });
    const token = jwt.sign({ id: owner._id }, process.env.JWT_SECRET);
    await page.evaluateOnNewDocument((owner, token) => {
      localStorage.setItem('authToken', token);
      localStorage.setItem('user', JSON.stringify({ account: owner, token }));
    }, JSON.parse(JSON.stringify(owner)), token);
  });
  afterAll(async () => {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await stopDb();
  });
  afterEach(async () => {
    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('all accounting sections render without JS errors or failed API requests, desktop and mobile', async () => {
    const routes = ['', 'entries', 'accounts', 'trial-balance', 'rates', 'settings', 'audit', 'bills', 'customers', 'customer-invoices', 'vendors', 'payments', 'receipts/new', 'expenses', 'office-expenses', 'trips', 'treasury', 'bank', 'employees', 'assets', 'equity', 'netting', 'migration', 'guide', 'suspense', 'reports', 'exceptions', 'review', 'closing', 'odoo', 'alipay', 'start', 'access', 'backups'];
    for (const route of routes) {
      await go(`/accounting/${route}`);
      expect(await page.$('.acc-page-header')).not.toBeNull();
    }
    await page.setViewport({ width: 390, height: 844 });
    for (const route of ['reports', 'treasury', 'exceptions', 'review', 'closing']) await go(`/accounting/${route}`);
    await page.setViewport({ width: 1440, height: 1050 });
    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('review protects bank closing and account approval through the real browser', async () => {
    const bank = await account('110202');
    await post({ eventType: 'MANUAL', eventKey: 'BROWSER_REVIEW:OPENING', date: '2026-09-01', description: 'Isolated bank opening',
      lines: [{ accountId: bank._id, debit: 100000 }, { accountId: (await account('390000'))._id, credit: 100000 }] }, { user: owner });
    await go('/accounting/review?from=2026-09-01&to=2026-09-30');
    await page.waitForFunction(() => document.body.textContent.includes('الرصيد الختامي لم يُراجع مقابل الكشف'));
    await clickText('مراجعة الرصيد الختامي');
    await type(await field('الرصيد الختامي من الكشف (USD)', '[role="dialog"]'), '1000');
    const checked = page.waitForResponse(r => r.url().endsWith('/review/bank/complete') && r.request().method() === 'POST');
    await clickText('حفظ المراجعة');
    expect((await checked).status()).toBe(200);
    await page.waitForFunction(() => !document.body.textContent.includes('الرصيد الختامي لم يُراجع مقابل الكشف'));
    await go('/accounting/closing');
    await clickText('2026-09', '.acc-months__label');
    await pause(600);
    const locked = page.waitForResponse(r => r.url().endsWith('/close/month') && r.request().method() === 'POST');
    await clickText('إقفال 2026-09');
    await page.click('[role="dialog"] input[type="checkbox"]');
    await clickText('تأكيد');
    expect((await locked).status()).toBe(200);
    await page.waitForFunction(() => document.body.textContent.includes('مقفل مسبقاً'));
    const approved = page.waitForResponse(r => r.url().endsWith('/review/month/approve') && r.request().method() === 'POST');
    await clickText('اعتماد حسابات 2026-09');
    await page.click('[role="dialog"] input[type="checkbox"]');
    await clickText('تأكيد');
    expect((await approved).status()).toBe(200);
    await page.waitForFunction(() => document.body.textContent.includes('حسابات هذا الشهر معتمدة'));
    expect(await usd('110202')).toBe(100000);
    await resetDb();
    await AccountingSettings.updateOne({ key: 'main' }, { $set: { liveEnabled: true, migrationDate: '2026-01-01', cutoffAt: new Date('2026-01-01') } });
    invalidateConfig();
    await CurrencyRate.create({ currency: 'LYD', day: '2026-01-01', rate: 10 });
    await User.collection.insertMany([owner, customer]);
  });

  test('manual journal is posted and cancelled through browser controls, with exact ledger reversal', async () => {
    await go('/accounting/entries/new');
    await type('.acc-form-grid input:not([type="date"])', 'Stage10 browser capital');
    const rows = await page.$$('.acc-line');
    for (const [i, code] of ['110101', '310000'].entries()) {
      const input = await rows[i].$('input[role="combobox"]');
      await input.type(code);
      await page.waitForSelector('[role="option"]');
      await page.click('[role="option"]');
      const amount = await rows[i].$('input[type="number"]');
      await amount.type('1000');
    }
    // Cash requires an office; its seeded account already supplies tripoli.
    const saved = page.waitForResponse(r => r.url().endsWith('/api/accounting/entries') && r.request().method() === 'POST');
    await clickText('ترحيل القيد');
    const response = await saved;
    expect(response.status()).toBe(201);
    const entry = await response.json();
    expect(await usd('110101')).toBe(100000);
    await expectConsistent('browser capital');
    await page.waitForFunction(() => location.pathname.match(/entries\/[a-f0-9]{24}$/));
    await pause(400);
    await clickText('إلغاء القيد');
    await type('[role="dialog"] textarea', 'Stage10 reversal');
    const cancelled = page.waitForResponse(r => r.url().includes(`/entries/${entry._id}/cancel`));
    await clickText('تأكيد الإلغاء');
    expect((await cancelled).status()).toBe(200);
    expect(await usd('110101')).toBe(0);
    const reversal = await JournalEntry.findOne({ reversalOf: entry._id }).lean();
    expect(reversal).not.toBeNull();
    await expectConsistent('browser cancellation');
    expect(errors).toEqual([]);
  });

  test('wallet deposit through multipart browser form agrees with wallet liability and cash', async () => {
    await go(`/user/${customer._id}`);
    await clickText('Add balance to wallet');
    await type('[role="dialog"] input[name="amount"]', '125.50');
    await select('#currency', 'USD');
    await pause(300);
    await select('#office', 'tripoli');
    await type('[role="dialog"] textarea[name="note"]', 'Stage10 receipt');
    const fileInput = await page.$('[role="dialog"] input[type="file"]');
    // A real multipart upload, routed to the mocked storage only.
    const receipt = path.join(require('os').tmpdir(), `stage10-receipt-${process.pid}.png`);
    fs.writeFileSync(receipt, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7T8AAAAASUVORK5CYII=', 'base64'));
    await fileInput.uploadFile(receipt);
    await pause(300);
    expect(await page.$eval('[role="dialog"] form', form => form.checkValidity())).toBe(true);
    abortWalletDeposit = true;
    await clickText('Create Balance');
    await page.waitForSelector('[role="dialog"] .MuiAlert-root');
    expect(await Wallet.countDocuments({ user: customer._id })).toBe(0);
    expect(await page.$('[role="dialog"]')).not.toBeNull();
    abortWalletDeposit = false;
    const deposited = page.waitForResponse(r => r.url().includes(`/wallet/${customer._id}`) && r.request().method() === 'POST');
    await clickText('Create Balance');
    expect((await deposited).status()).toBe(200);
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(125.5);
    await expectConsistent('browser wallet deposit');
    expect(await usd('110121')).toBe(12550);
    expect(errors).toEqual([]);
  });

  test('supplier bill draft, edit, posting, payment and reversals agree with expenses, AP and cash', async () => {
    const { SupplierBill, SupplierPayment } = require('../models/documents');
    const expense = await require('../models').Account.findOne({ type: 'expense', isGroup: false, isActive: true, allowManualEntry: true }).lean();
    await go('/accounting/bills/new');
    await clickText('جديد');
    await type('[role="dialog"] input:not([type="hidden"])', 'Stage10 Supplier');
    const added = page.waitForResponse(r => r.url().endsWith('/api/accounting/vendors') && r.request().method() === 'POST');
    await clickText('إضافة');
    expect((await added).status()).toBe(201);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await type(await field('الوصف'), 'Stage10 expense');
    await type(await field('المبلغ (USD)'), '20');
    await type(await field('حساب المصروف'), expense.code);
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]');
    await select(await field('المكتب'), 'tripoli');
    const draftResponse = page.waitForResponse(r => r.url().endsWith('/api/accounting/bills') && r.request().method() === 'POST');
    await clickText('حفظ كمسودة');
    await pause(500);
    expect((await draftResponse).status()).toBe(201);
    const draft = await draftResponse.then(r => r.json());
    expect(await usd(expense.code)).toBe(0);
    await go(`/accounting/bills/${draft._id}/edit`);
    await type(await field('المبلغ (USD)'), '25');
    const posted = page.waitForResponse(r => r.url().endsWith(`/bills/${draft._id}/post`));
    await clickText('ترحيل');
    expect((await posted).status()).toBe(200);
    expect(await usd(expense.code)).toBe(2500);
    expect(await usd('210200')).toBe(-2500);
    await expectConsistent('browser supplier bill');
    await go(`/accounting/bills/${draft._id}`);
    await clickText('دفع');
    await page.waitForSelector('.acc-main input[type="number"]');
    await pause(300);
    await select(await field('دُفعت من'), String((await account('110121'))._id));
    await type(await field('المبلغ (USD)'), '25');
    const paid = page.waitForResponse(r => r.url().endsWith('/api/accounting/payments') && r.request().method() === 'POST');
    await clickText('ترحيل الدفعة');
    expect((await paid).status()).toBe(201);
    expect(await usd('210200')).toBe(0);
    expect(await usd('110121')).toBe(10050);
    await expectConsistent('browser supplier payment');
    await go('/accounting/payments');
    await clickText('إلغاء');
    await type('[role="dialog"] textarea', 'Stage10 payment reversal');
    const paymentCancel = page.waitForResponse(r => r.url().includes('/cancel') && r.request().method() === 'POST');
    await clickText('تأكيد الإلغاء');
    expect((await paymentCancel).status()).toBe(200);
    expect((await SupplierPayment.findOne().lean()).status).toBe('canceled');
    expect(await usd('110121')).toBe(12550);
    expect(await usd('210200')).toBe(-2500);
    await go(`/accounting/bills/${draft._id}`);
    await clickText('إلغاء');
    await type('[role="dialog"] textarea', 'Stage10 bill reversal');
    const billCancel = page.waitForResponse(r => r.url().includes('/cancel') && r.request().method() === 'POST');
    await clickText('تأكيد الإلغاء');
    expect((await billCancel).status()).toBe(200);
    expect((await SupplierBill.findById(draft._id).lean()).status).toBe('canceled');
    expect(await usd(expense.code)).toBe(0);
    expect(await usd('210200')).toBe(0);
    await expectConsistent('browser supplier reversals');
    expect(errors).toEqual([]);
  });

  test('purchase is created, edited, paid from the wallet and cancelled using the actual order screens', async () => {
    const Order = require('../../models/order');
    await go('/invoice/add');
    await page.click('.of-kinds [role="radio"]:nth-child(2)');
    await type('input[name="customerId"]', customer.customerId);
    await clickText('Check');
    await page.waitForFunction(() => document.querySelector('input[name="fullName"]').value.length > 0);
    await type('input[name="productName"]', 'Stage10 browser purchase');
    await namedSelect('placedAt', 'tripoli');
    await autocomplete('Shipment from', 'الصين', '.op-main');
    await autocomplete('Shipment to', 'طرابلس', '.op-main');
    await type('input[name="description"]', 'Stage10 item');
    await type('input[name="unitPrice"]', '25');
    expect(await page.$eval('form.op-layout', form => Array.from(form.querySelectorAll('input, textarea')).filter(n => !n.validity.valid).map(n => ({ name: n.name, value: n.value, message: n.validationMessage })))).toEqual([]);
    const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await clickText('Create invoice');
    expect((await createdResponse).status()).toBe(200);
    const created = await createdResponse.then(r => r.json());
    expect((await Order.findById(created._id).lean()).totalInvoice).toBe(25);
    await expectConsistent('browser purchase creation');
    await go(`/invoice/${created._id}/edit`);
    await type('input[name="unitPrice"]', '30');
    const updated = page.waitForResponse(r => r.url().endsWith(`/api/order/${created._id}`) && r.request().method() === 'PUT');
    await clickText('Update invoice');
    expect((await updated).status()).toBe(200);
    expect((await Order.findById(created._id).lean()).totalInvoice).toBe(30);
    await expectConsistent('browser purchase edit');
    await pause(400);
    await clickText('Payments (0)', '[role="tab"]');
    await clickText('Pay from wallet');
    await type('[role="dialog"] input[type="number"]', '30');
    const paid = page.waitForResponse(r => r.url().endsWith(`/wallet/${customer._id}/usebalance`) && r.request().method() === 'POST');
    await clickText('Pay 30.00 USD');
    expect((await paid).status()).toBe(200);
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(95.5);
    await expectConsistent('browser purchase wallet payment');
    expect(await usd('110121')).toBe(12550);
    await go(`/invoice/${created._id}/edit`);
    await clickText('إلغاء وإرجاع للمحفظة');
    await type('[role="dialog"] textarea', 'Stage10 purchase cancellation');
    const cancelled = page.waitForResponse(r => r.url().includes(`/order/${created._id}/cancel`));
    await clickText('إلغاء وإرجاع للمحفظة', '[role="dialog"] button');
    expect((await cancelled).status()).toBe(200);
    expect((await Order.findById(created._id).lean()).isCanceled).toBe(true);
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(125.5);
    await expectConsistent('browser purchase refund');
    expect(errors).toEqual([]);
  });

  test('air shipment, delivery invoice and cancellation are reconciled through the customer screens', async () => {
    const Order = require('../../models/order');
    const Invoice = require('../../models/invoice');
    await go('/invoice/add');
    await type('input[name="customerId"]', customer.customerId);
    await clickText('Check');
    await page.waitForFunction(() => document.querySelector('input[name="fullName"]').value.length > 0);
    await type('input[name="productName"]', 'Stage10 air shipment');
    await namedSelect('placedAt', 'tripoli');
    await autocomplete('Shipment from', 'الصين', '.op-main');
    await autocomplete('Shipment to', 'طرابلس', '.op-main');
    await namedSelect('method', 'air');
    await type('input[name="exiosShipmentPrice"]', '10');
    await clickText('Details');
    await type(await field('Tracking number', '[role="dialog"]'), 'STAGE10SHIP');
    await type(await field('Weight', '[role="dialog"]'), '2');
    await type(await field('Exios price per KG', '[role="dialog"]'), '10');
    await clickText('Done');
    await pause(300);
    await page.click('button[title="Mark as done: Origin warehouse"]');
    await page.click('button[title="Mark as done: Arrived in Libya"]');
    const creation = page.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await clickText('Create invoice');
    expect((await creation).status()).toBe(200);
    const order = await creation.then(r => r.json());
    await expectConsistent('browser shipment creation');
    expect(await usd('410100')).toBe(0);
    await go(`/user/${customer._id}`);
    await clickText('Orders', '[role="tab"]');
    await clickText('Ready to deliver', '[role="tab"]');
    await page.waitForSelector('.co-toolbar input[type="checkbox"]');
    await page.click('.co-toolbar input[type="checkbox"]');
    await clickText('Deliver selected');
    await clickText('Pay all in USD');
    const delivery = page.waitForResponse(r => r.url().endsWith(`/user/${customer._id}/markAsDelivered`));
    await clickText('Confirm delivery');
    expect((await delivery).status()).toBe(200);
    expect((await Order.findById(order._id).lean()).paymentList[0].status.received).toBe(true);
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(105.5);
    await expectConsistent('browser shipment delivery');
    expect(await usd('410100')).toBe(-2000); // Revenue is a credit balance.
    expect(await usd('110121')).toBe(12550);
    const invoice = await Invoice.findOne({ customer: customer._id, isCanceled: { $ne: true } }).lean();
    expect(invoice.amountUSD).toBe(20);
    await go(`/user/${customer._id}`);
    await clickText('Created Invoices', '[role="tab"]');
    await page.waitForSelector('.invoice-btn--danger');
    await clickText('Cancel invoice');
    const cancellation = page.waitForResponse(r => r.url().endsWith(`/invoices/${invoice._id}/cancel`));
    await clickText('Cancel the whole invoice');
    expect((await cancellation).status()).toBe(200);
    expect((await Order.findById(order._id).lean()).paymentList[0].status.received).toBe(false);
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean()).balance).toBe(125.5);
    await expectConsistent('browser delivery cancellation');
    expect(await usd('410100')).toBe(0);
    expect(await usd('110121')).toBe(12550);
    expect(errors).toEqual([]);
  });

  test('bank invoice proposals show order details, require approval and allow changing the chosen invoice', async () => {
    const { Vendor, SupplierBill, SupplierPayment, BankStatementLine } = require('../models/documents');
    const { runInTransaction } = require('../services/transaction');
    const bank = require('../services/posting/bank');
    const payables = require('../services/posting/payables');
    const Order = require('../../models/order');
    await CurrencyRate.updateOne({ currency: 'TRY', day: '2026-01-01' }, { $set: { rate: 40 } }, { upsert: true });
    const vendor = await Vendor.create({ name: 'Browser proposal supplier', type: 'supplier' });
    const source = await account('110204');
    const orders = [];
    for (const number of ['MATCH-BROWSER-1', 'MATCH-BROWSER-2']) {
      orders.push((await Order.collection.insertOne({ orderId: number, user: customer._id, placedAt: 'tripoli', totalInvoice: 100,
        isPayment: true, unsureOrder: false, isCanceled: false, paymentList: [], purchaseItems: [], createdAt: new Date('2026-07-02') })).insertedId);
    }
    const bills = [];
    for (const orderId of orders) {
      bills.push(await runInTransaction(session => payables.createBill({ vendorId: vendor._id, day: '2026-07-02', currency: 'EUR', rate: 0.9,
        lines: [{ description: 'Browser original purchase', amount: 99, target: 'order', orderId }] }, { session, req: { user: owner }, asDraft: true })));
    }
    await runInTransaction(session => bank.importLines(source._id, [{ day: '2026-07-02', description: 'Browser bank purchase', amount: -5685.42,
      originalAmount: 99, originalCurrency: 'EUR', settlementUsd: 115.33 }], { session, req: { user: owner } }));
    const line = await BankStatementLine.findOne({ accountId: source._id, description: 'Browser bank purchase' });
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('MATCH-BROWSER-1'));
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('.acc-main button')).some(b => ['مطابقة', 'قائمة المشتريات', 'مراجعة المطابقة'].includes(b.textContent.trim())))).toBe(false);
    await clickText('مراجعة واعتماد');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('المطابقة المقترحة'));
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('MATCH-BROWSER-1');
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('سبب الاقتراح والمطابقة');
    expect(await page.$eval('[data-bank-review-statement]', el => el.textContent)).toContain('1 EUR = 57.428485 TRY');
    expect(await page.$eval('[data-bank-review-statement]', el => el.textContent)).toContain('سعر الدولار في العملية');
    const desktopCards = await page.evaluate(() => ({ statement: document.querySelector('[data-bank-review-statement]').getBoundingClientRect().x,
      record: document.querySelector('[data-bank-review-record]').getBoundingClientRect().x }));
    expect(desktopCards.statement).toBeGreaterThan(desktopCards.record);
    await page.setViewport({ width: 390, height: 844 });
    await pause(250);
    const mobileCards = await page.evaluate(() => ({ statement: document.querySelector('[data-bank-review-statement]').getBoundingClientRect().y,
      record: document.querySelector('[data-bank-review-record]').getBoundingClientRect().y,
      width: document.querySelector('[role="dialog"]').getBoundingClientRect().width }));
    expect(mobileCards.statement).toBeLessThan(mobileCards.record);
    expect(mobileCards.width).toBeLessThanOrEqual(390);
    await page.setViewport({ width: 1440, height: 900 });
    expect(await SupplierPayment.countDocuments({ 'allocations.billId': { $in: bills.map(b => b._id) } })).toBe(0);
    // Choosing order cost from the new-operation form returns to the original invoice review.
    await select(await field('طريقة الاعتماد', '[role="dialog"]'), 'new');
    await select(await field('يُوجَّه إلى', '[role="dialog"]'), 'order');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('المطابقة المقترحة'));
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('MATCH-BROWSER-1');
    await clickText('تغيير الفاتورة أو الطلبية');
    expect(await page.$('[data-bank-review-comparison]')).toBeNull();
    await type(await field('بحث برقم الطلبية أو الفاتورة أو المورد', '[role="dialog"]'), 'MATCH-BROWSER-2');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('1 نتيجة'));
    await clickText('العودة للمقارنة');
    expect(await page.$eval('[data-bank-review-record]', el => el.textContent)).toContain('MATCH-BROWSER-1');
    await clickText('تغيير الفاتورة أو الطلبية');
    await clickText('اختيار', '[role="dialog"] button');
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('MATCH-BROWSER-2');
    expect(await page.$eval('[data-bank-review-record]', el => el.textContent)).toContain('سعر التصريف حسب الفاتورة');
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).not.toContain('اختيار الفاتورة أو مشتريات الطلبية');
    await (await page.$('[role="dialog"]')).screenshot({ path: path.join(require('os').tmpdir(), 'exios-bank-match-approval.png') });
    const postedResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/purchase-match`) && r.request().method() === 'POST');
    await clickText('موافقة وتسجيل السداد');
    expect((await postedResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const saved = await BankStatementLine.findById(line._id).lean();
    expect(String(saved.billId)).toBe(String(bills[1]._id));
    expect(String(saved.orderId)).toBe(String(orders[1]));
    expect(saved.billCreatedFromStatement).toBe(false);
    expect((await SupplierBill.findById(bills[0]._id)).status).toBe('draft');
    expect((await SupplierBill.findById(bills[1]._id)).status).toBe('posted');
    expect(await SupplierPayment.countDocuments({ 'allocations.billId': bills[1]._id })).toBe(1);
    expect(await payables.apBalance(payables.billKey(bills[1]._id))).toBe(0);
    await select(await field('عرض'), 'created_entry');
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('MATCH-BROWSER-2'));
    const csv = path.join(require('os').tmpdir(), 'exios-bank-proposal-preview.csv');
    fs.writeFileSync(csv, 'Date,Description,Amount\n2026-07-03,Preview merchant (99.00 Euro),-4000\n', 'utf8');
    const upload = await page.$('input[type="file"]');
    await upload.uploadFile(csv);
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('MATCH-BROWSER-1'));
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('سيُحفظ السطر دون سداد حتى توافق على المطابقة');
    // Preview remains unposted until reviewed; saving it does not settle the proposal.
    const importResponse = page.waitForResponse(r => r.url().endsWith('/bank/import') && r.request().method() === 'POST');
    await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => b.textContent.includes('استيراد')).click());
    expect((await importResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const pending = await BankStatementLine.findOne({ description: 'Preview merchant (99.00 Euro)' }).lean();
    expect(pending.lineStatus).toBe('unmatched');
    expect((await SupplierBill.findById(bills[0]._id)).status).toBe('draft');
    expect(await SupplierPayment.countDocuments({ 'allocations.billId': bills[0]._id })).toBe(0);
    fs.unlinkSync(csv);
  });

  test('purchase review list filters direct invoices and order purchases by date and selects the reviewed order', async () => {
    const { Vendor, SupplierBill, BankStatementLine } = require('../models/documents');
    const { runInTransaction } = require('../services/transaction');
    const bank = require('../services/posting/bank');
    const payables = require('../services/posting/payables');
    const Order = require('../../models/order');
    const source = await account('110204');
    const vendor = await Vendor.create({ name: 'List direct vendor', type: 'supplier' });
    const expense = await account('530800');
    const direct = await runInTransaction(session => payables.createBill({ vendorId: vendor._id, day: '2026-09-20', currency: 'USD',
      lines: [{ description: 'LIST-BROWSER-DIRECT', amount: 20, target: 'expense', accountId: expense._id, office: 'turkey' }] }, { session, req: { user: owner }, asDraft: true }));
    const itemId = oid();
    const orderId = (await Order.collection.insertOne({ orderId: 'LIST-BROWSER-ORDER', user: customer._id, placedAt: 'tripoli', totalInvoice: 100,
      isPayment: true, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-09-20'),
      purchaseItems: [{ _id: itemId, unitPrice: 20, currency: 'USD', date: new Date('2026-09-20T10:00:00Z'), description: 'List order purchase' }] })).insertedId;
    await runInTransaction(session => bank.importLines(source._id, [{ day: '2026-09-20', description: 'List bank purchase', amount: -1000,
      originalAmount: 20, originalCurrency: 'USD' }], { session, req: { user: owner } }));
    const line = await BankStatementLine.findOne({ description: 'List bank purchase' });
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('List bank purchase'));
    await clickText('مراجعة واعتماد');
    await select(await field('طريقة الاعتماد', '[role="dialog"]'), 'purchase');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('المطابقة المقترحة'));
    await clickText('تغيير الفاتورة أو الطلبية');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('LIST-BROWSER-ORDER'));
    await select(await field('مصدر المشتريات', '[role="dialog"]'), 'direct');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('LIST-BROWSER-DIRECT'));
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).not.toContain('LIST-BROWSER-ORDER');
    await select(await field('مصدر المشتريات', '[role="dialog"]'), 'order');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('LIST-BROWSER-ORDER'));
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).not.toContain('LIST-BROWSER-DIRECT');
    await page.$eval(await field('من تاريخ', '[role="dialog"]'), el => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '2026-09-21'); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('0 نتيجة'));
    await page.$eval(await field('من تاريخ', '[role="dialog"]'), el => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '2026-09-20'); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('LIST-BROWSER-ORDER'));
    await type(await field('بحث برقم الطلبية أو الفاتورة أو المورد', '[role="dialog"]'), 'LIST-BROWSER-ORDER');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('1 نتيجة'));
    await clickText('اختيار', '[role="dialog"] button');
    const matchedResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/purchase-match`) && r.request().method() === 'POST');
    await clickText('موافقة وتسجيل السداد');
    expect((await matchedResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const saved = await BankStatementLine.findById(line._id).lean();
    expect(String(saved.orderId)).toBe(String(orderId));
    expect(String(saved.purchaseItemId)).toBe(String(itemId));
    expect(saved.matchedOriginalAmount).toBe(20);
    expect((await SupplierBill.findById(direct._id)).status).toBe('draft');
  });

  test('one review action posts a new cost and matches an existing ledger entry without duplication', async () => {
    const { BankStatementLine, SupplierBill } = require('../models/documents');
    const source = await account('110204');
    const expense = await account('530800');
    await CurrencyRate.updateOne({ currency: 'TRY', day: '2026-01-01' }, { $set: { rate: 40 } }, { upsert: true });
    const cost = await BankStatementLine.create({ accountId: source._id, day: '2026-09-21', amount: -100000,
      originalAmount: 1000, originalCurrency: 'TRY', description: 'Simple browser new bank cost' });
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('Simple browser new bank cost'));
    await clickText('مراجعة واعتماد');
    await select(await field('طريقة الاعتماد', '[role="dialog"]'), 'new');
    await autocomplete('الحساب المقابل (رسوم، إيجار، مورد، أو حساب بنك)', expense.code, '[role="dialog"]');
    const costResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${cost._id}/entry`) && r.request().method() === 'POST');
    await clickText('ترحيل', '[role="dialog"] button');
    const costResult = await costResponse;
    expect(costResult.status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const postedCost = await BankStatementLine.findById(cost._id).lean();
    expect(postedCost.lineStatus).toBe('created_entry');
    expect(await SupplierBill.findById(postedCost.billId).lean()).toMatchObject({ currency: 'TRY', total: 1000 });
    const existing = await post({ eventType: 'MANUAL', eventKey: 'BROWSER_SIMPLE_EXISTING', date: '2026-09-22',
      description: 'Simple browser existing bank entry', lines: [
        { accountId: expense._id, debit: 25, office: 'turkey' },
        { accountId: source._id, credit: 25, currency: 'TRY', amountCurrency: -1000 },
      ] });
    const ledgerLine = await BankStatementLine.create({ accountId: source._id, day: '2026-09-22', amount: -1000,
      originalAmount: 10, originalCurrency: 'TRY', description: 'Simple browser existing bank entry' });
    const before = await JournalEntry.countDocuments();
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('Simple browser existing bank entry'));
    await clickText('مراجعة واعتماد');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="dialog"] button')).some(b => b.textContent.trim() === 'موافقة على المطابقة' && !b.disabled));
    const ledgerResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${ledgerLine._id}/match`) && r.request().method() === 'POST');
    await clickText('موافقة على المطابقة');
    expect((await ledgerResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    expect(await JournalEntry.countDocuments()).toBe(before);
    const matched = await BankStatementLine.findById(ledgerLine._id).lean();
    expect(matched.lineStatus).toBe('matched');
    expect(matched.matchedEntryIds.map(String)).toContain(String(existing._id));
    await expectConsistent('simplified bank review');
    expect(errors).toEqual([]);
  });

  test('statement details edit source evidence and reverse then repost to the corrected account', async () => {
    const { BankStatementLine } = require('../models/documents');
    const { runInTransaction } = require('../services/transaction');
    const { getBalance } = require('../services/carrying');
    const bank = require('../services/posting/bank');
    const source = await account('110204'); const capital = await account('310000'); const correctedAccount = await account('340000');
    await CurrencyRate.updateOne({ currency: 'TRY', day: '2026-09-23' }, { $set: { rate: 40 } }, { upsert: true });
    const bankBefore = await getBalance(source._id);
    await runInTransaction(session => bank.importLines(source._id, [{ day: '2026-09-23', amount: 1000, description: 'Browser details correction' }], { session, req: { user: owner } }));
    const line = await BankStatementLine.findOne({ description: 'Browser details correction' }).lean();
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('Browser details correction'));
    await clickText('التفاصيل والتعديل');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('لم يُسجل قيد مرتبط'));
    await clickText('تعديل بيانات الكشف');
    await type(await field('المبلغ المدفوع / المستلم (TRY)', '[role="dialog"]'), '1500');
    await type(await field('سبب تعديل بيانات الكشف', '[role="dialog"]'), 'Bank proof corrected');
    const editResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}`) && r.request().method() === 'PATCH');
    await clickText('حفظ بيانات الكشف');
    expect((await editResponse).status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('عُدلت بيانات هذا السطر'));
    await clickText('اختيار الحساب والمطابقة');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('طريقة الاعتماد'));
    await autocomplete('الحساب المقابل (رسوم، إيجار، مورد، أو حساب بنك)', capital.code, '[role="dialog"]');
    const firstResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/entry`) && r.request().method() === 'POST');
    await clickText('ترحيل', '[role="dialog"] button');
    expect((await firstResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const first = await BankStatementLine.findById(line._id).lean();
    await select(await field('عرض'), 'created_entry');
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('Browser details correction'));
    expect(await page.$eval('.acc-main', el => el.textContent)).toContain('310000');
    await clickText('التفاصيل والتعديل');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('القيد متوازن'));
    const text = await page.$eval('[role="dialog"]', el => el.textContent);
    expect(text).toContain('110204'); expect(text).toContain('310000'); expect(text).toContain('سجل الإجراءات');
    await clickText('تصحيح الحساب أو المطابقة');
    await type(await field('سبب التصحيح', '[role="dialog"]'), 'Correct accounting destination');
    const reversalResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/cancel-entry`) && r.request().method() === 'POST');
    await clickText('تأكيد وفتح المراجعة');
    expect((await reversalResponse).status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('طريقة الاعتماد'));
    expect(await getBalance(source._id)).toEqual(bankBefore);
    const retained = await JournalEntry.findById(first.entryId).lean();
    expect(retained.status).toBe('reversed');
    await autocomplete('الحساب المقابل (رسوم، إيجار، مورد، أو حساب بنك)', correctedAccount.code, '[role="dialog"]');
    const repostResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/entry`) && r.request().method() === 'POST');
    await clickText('ترحيل', '[role="dialog"] button');
    expect((await repostResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const corrected = await BankStatementLine.findById(line._id).lean();
    expect(String(corrected.entryId)).not.toBe(String(first.entryId));
    expect(await getBalance(source._id)).toEqual({ usd: bankBefore.usd + 3750, foreign: bankBefore.foreign + 150000 });
    expect((await JournalEntry.findById(corrected.entryId)).lines.some(l => String(l.accountId) === String(correctedAccount._id))).toBe(true);
    await expectConsistent('bank details correction');
    expect(errors).toEqual([]);
  });

  test('merchant refund is reviewed in bank statements and reused in the order wallet procedure', async () => {
    const { Vendor, BankStatementLine, CustomerRefund } = require('../models/documents');
    const Order = require('../../models/order');
    const payables = require('../services/posting/payables');
    const bank = require('../services/posting/bank');
    const { runInTransaction } = require('../services/transaction');
    const { getBalance } = require('../services/carrying');
    const source = await account('110204'); const cash = await account('110101');
    await CurrencyRate.updateOne({ currency: 'TRY', day: '2026-01-01' }, { $set: { rate: 40 } }, { upsert: true });
    const orderId = (await Order.collection.insertOne({ orderId: 'BROWSER-REFUND-ORDER', user: customer._id, placedAt: 'tripoli', isPayment: true,
      totalInvoice: 150, unsureOrder: false, isCanceled: false, paymentList: [], createdAt: new Date('2026-07-01'), productName: 'Refund browser purchase' })).insertedId;
    const vendor = await Vendor.create({ name: '1688 browser refund', type: 'supplier' });
    const bill = await runInTransaction(session => payables.createBill({ vendorId: vendor._id, day: '2026-07-01', currency: 'USD', paidImmediatelyFrom: cash._id,
      lines: [{ target: 'order', orderId, amount: 100, description: '1688 original purchase' }] }, { session, req: { user: owner } }));
    const payment = await require('../../models/orderPaymentHistory').create({ order: orderId, customer: customer._id, createdBy: owner._id, receivedAmount: 150,
      currency: 'USD', category: 'invoice', paymentType: 'cash', createdAt: new Date('2026-07-01') });
    await runInTransaction(session => require('../services/posting/operations').postCashPayment(payment._id, { session, user: owner, office: 'tripoli' }));
    const parsed = await bank.parsePdf(fs.readFileSync('C:/Users/qweem/Downloads/Kart Ekstre-25.08.2026.pdf'));
    const original = parsed.rows.find(r => r.originalAmount === 62.34 && r.movementKind === 'purchase_refund');
    const beforeBank = await getBalance(source._id);
    await bank.importStatement(source._id, [{ ...original, amount: -original.amount }], { req: { user: owner } });
    const line = await BankStatementLine.findOne({ accountId: source._id, description: original.description }).lean();
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('62.34 USD'));
    expect(await page.$eval('.acc-main', el => el.textContent)).toContain('استرداد مشتريات من الموقع');
    const targetRow = await page.evaluate(description => {
      const row = Array.from(document.querySelectorAll('.acc-main tr')).find(r => r.textContent.includes(description));
      const button = Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === 'مراجعة واعتماد');
      button.setAttribute('data-refund-open', 'yes'); return '[data-refund-open="yes"]';
    }, original.description);
    await page.click(targetRow);
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('BROWSER-REFUND-ORDER'));
    await type(await field('بحث برقم الطلبية أو الفاتورة أو المورد', '[role="dialog"]'), 'BROWSER-REFUND-ORDER');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('1 نتيجة'));
    await clickText('اختيار', '[role="dialog"] button');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('سيظهر هذا الاسترداد في قسم الريفاند'));
    const approved = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${line._id}/refund-match`) && r.request().method() === 'POST');
    await clickText('موافقة واعتماد الاسترداد');
    expect((await approved).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const saved = await CustomerRefund.findOne({ bankLineId: line._id }).lean();
    expect(saved.walletUsd).toBe(0); expect(String(saved.billId)).toBe(String(bill._id));
    expect(await getBalance(source._id)).toEqual({ usd: beforeBank.usd + 6234, foreign: beforeBank.foreign + 301322 });
    const beforeWallet = (await Wallet.findOne({ user: customer._id, currency: 'USD' }).lean())?.balance || 0;
    await go(`/invoice/${orderId}/edit`);
    await clickText('Accounting', '[role="tab"]');
    await page.waitForFunction(() => document.body.textContent.includes('إضافة مبلغ العميل لنفس الريفاند'));
    await clickText('إضافة مبلغ العميل لنفس الريفاند');
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('استلام البنك وتخفيض تكلفة الطلبية مسجلان بالفعل');
    await type(await field('يُضاف لمحفظة العميل ($)', '[role="dialog"]'), '60');
    const walletAdded = page.waitForResponse(r => r.url().endsWith(`/acc/orders/${orderId}/refunds`) && r.request().method() === 'POST');
    await clickText('تسجيل', '[role="dialog"] button');
    expect((await walletAdded).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    expect((await Wallet.findOne({ user: customer._id, currency: 'USD' })).balance).toBe(beforeWallet + 60);
    expect(await getBalance(source._id)).toEqual({ usd: beforeBank.usd + 6234, foreign: beforeBank.foreign + 301322 });
    expect(await CustomerRefund.countDocuments({ orderId })).toBe(1);
    await expectConsistent('bank and order refund integration');
    expect(errors).toEqual([]);
  });

  test('incoming funds and card funding are prepared from rules and approved through the same review', async () => {
    const { BankStatementLine, BankRule, SupplierBill, SupplierPayment } = require('../models/documents');
    const { getBalance } = require('../services/carrying');
    const source = await account('110204');
    const capital = await account('310000');
    const card = await account('250100');
    await CurrencyRate.updateOne({ currency: 'TRY', day: '2026-01-01' }, { $set: { rate: 40 } }, { upsert: true });
    await BankRule.create({ accountId: source._id, keyword: 'ui receipt', direction: 'in', counterAccountId: capital._id, office: 'turkey' });
    const income = await BankStatementLine.create({ accountId: source._id, day: '2026-09-23', amount: 10000000,
      description: 'UI receipt capital funding' });
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('UI receipt capital funding'));
    await clickText('مراجعة واعتماد');
    expect(await page.$eval('[role="dialog"]', el => el.textContent)).toContain('مبلغ مستلم');
    expect(await page.$eval('[data-bank-review-record] input[role="combobox"]', el => el.value)).toContain(capital.code);
    const incomeResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${income._id}/entry`) && r.request().method() === 'POST');
    await clickText('ترحيل', '[role="dialog"] button');
    expect((await incomeResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const incoming = await BankStatementLine.findById(income._id).lean();
    const incomeEntry = await JournalEntry.findById(incoming.entryId).lean();
    expect(incomeEntry.lines.find(l => String(l.accountId) === String(source._id))).toMatchObject({ debit: 250000, amountCurrency: 10000000 });
    await BankRule.create({ accountId: source._id, keyword: 'simple browser card funding', direction: 'out', counterAccountId: card._id });
    const transfer = await BankStatementLine.create({ accountId: source._id, day: '2026-09-24', amount: -1500000,
      description: 'Simple browser card funding' });
    const bankBefore = await getBalance(source._id);
    const cardBefore = await getBalance(card._id);
    const billsBefore = await SupplierBill.countDocuments();
    const paymentsBefore = await SupplierPayment.countDocuments();
    await go('/accounting/bank');
    await select(await field('الحساب'), String(source._id));
    await page.waitForFunction(() => document.querySelector('.acc-main')?.textContent.includes('Simple browser card funding'));
    await clickText('مراجعة واعتماد');
    expect(await page.$eval('[data-bank-review-record] input[role="combobox"]', el => el.value)).toContain(card.code);
    const transferResponse = page.waitForResponse(r => r.url().endsWith(`/bank/lines/${transfer._id}/entry`) && r.request().method() === 'POST');
    await clickText('ترحيل', '[role="dialog"] button');
    expect((await transferResponse).status()).toBe(200);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    expect((await getBalance(source._id)).foreign).toBe(bankBefore.foreign - 1500000);
    expect((await getBalance(card._id)).foreign).toBe(cardBefore.foreign + 1500000);
    expect(await SupplierBill.countDocuments()).toBe(billsBefore);
    expect(await SupplierPayment.countDocuments()).toBe(paymentsBefore);
    await expectConsistent('incoming funds and card funding review');
    expect(errors).toEqual([]);
  });

  test('auditor browser can read reports and entries but cannot open creation forms or post a journal', async () => {
    const auditor = { _id: oid(), username: 'stage10-auditor', firstName: 'Auditor', lastName: 'Test', phone: 910100003, customerId: 'AUD', roles: { isAccountant: true } };
    await User.collection.insertOne(auditor);
    const { PRESETS, setMember } = require('../services/access');
    await setMember(String(auditor._id), PRESETS.find(p => p.key === 'auditor').permissions, owner);
    const token = jwt.sign({ id: auditor._id }, process.env.JWT_SECRET);
    await page.evaluateOnNewDocument((account, token) => {
      localStorage.setItem('authToken', token);
      localStorage.setItem('user', JSON.stringify({ account, token }));
    }, JSON.parse(JSON.stringify(auditor)), token);
    await go('/accounting/entries');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('.acc-main button')).some(button => button.textContent.trim() === '\u0642\u064a\u062f \u064a\u062f\u0648\u064a'))).toBe(false);
    await go('/accounting/reports');
    expect(await page.$('.acc-page-header')).not.toBeNull();
    await go('/accounting/entries/new');
    expect(await page.$('.acc-lines')).toBeNull();
    const before = await JournalEntry.countDocuments();
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/accounting/entries', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}`, 'Content-Type': 'application/json' }, body: '{}' });
      return response.status;
    });
    expect(status).toBe(403);
    expect(failed.splice(0)).toEqual([{ url: '/api/accounting/entries', status: 403 }]);
    expect(await JournalEntry.countDocuments()).toBe(before);
    expect(errors).toEqual([]);
  });
});
