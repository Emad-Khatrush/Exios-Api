const express = require('express');
const multer = require('multer');
const { protect } = require('../middleware/check-auth');
const accounts = require('./controllers/accounts');
const settings = require('./controllers/settings');
const catalog = require('./controllers/catalog');
const rates = require('./controllers/rates');
const entries = require('./controllers/entries');
const reports = require('./controllers/reports');
const documents = require('./controllers/documents');
const live = require('./controllers/live');
const migration = require('./controllers/migration');
const suspense = require('./controllers/suspense');
const statements = require('./controllers/statements');
const odoo = require('./controllers/odoo');
const access = require('./controllers/access');
const { loadAccess, can, ownerOnly, KEYS } = require('./services/access');
const staffOps = require('./services/staffOperations');
const { handle } = require('./controllers/util');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Every route checks the permission of the work it belongs to (services/access.js). The owner
// accounts pass everywhere; reference lists that every form needs are open to every member.
router.use(protect, loadAccess);
const ANY = can(...KEYS);
const P = Object.fromEntries(KEYS.map((key) => [key, can(key)]));

// Standalone historical cash analysis: never posts to wallets or the ledger.
const historicalCash = () => require('./services/historicalCash');
const historicalUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, fieldSize: 2 * 1024 * 1024, files: 1, fields: 1 } });
const historicalFile = (req, res, next) => historicalUpload.single('file')(req, res, error => next(error
  ? new (require('../utils/errorHandler'))(400, 'تعذر رفع الملف. الحد الأقصى 5 MB للملف و1000 حركة في الكشف.') : undefined));
const historicalInput = req => {
  if (!req.body?.payload) return req.body || {};
  try { return JSON.parse(req.body.payload); } catch (_) { throw new (require('../utils/errorHandler'))(400, 'بيانات الاستيراد غير صالحة.'); }
};
router.get('/historical-cash/options', can('reports', 'treasury'), handle(async (req, res) => res.json(await historicalCash().options())));
router.get('/historical-cash', can('reports', 'treasury'), handle(async (req, res) => res.json(await historicalCash().list(req.query))));
router.post('/historical-cash/source-review', P.closing, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/historicalCashSources').review(req.body || {}, { session, req })))));
router.post('/historical-cash/preview', P.treasury, historicalFile, handle(async (req, res) => {
  const input = historicalInput(req);
  res.json(await historicalCash().preview(input, req.file, { excludeId: input.batchId }));
}));
router.post('/historical-cash', P.treasury, historicalFile, handle(async (req, res) => {
  const input = historicalInput(req);
  res.status(201).json(await require('./services/transaction').runInTransaction(session => historicalCash().save(input, req.file, { session, req, batchId: input.batchId })));
}));
router.get('/historical-cash/:id/source', can('reports', 'treasury'), handle(async (req, res) => {
  const file = await historicalCash().source(req.params.id);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="historical-source"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.send(file.data);
}));
router.get('/historical-cash/:id', can('reports', 'treasury'), handle(async (req, res) => res.json(await historicalCash().detail(req.params.id))));
router.post('/historical-cash/:id/review', P.closing, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => historicalCash().changeStatus(req.params.id, req.body || {}, { session, req })))));
router.post('/historical-cash/:id/void', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => historicalCash().changeStatus(req.params.id, { ...req.body, action: 'void' }, { session, req })))));

// Who may do what (the owner manages it)
router.get('/access/me', access.me);
router.get('/access/members', ownerOnly, access.members);
router.put('/access/members/:userId', ownerOnly, access.saveMember);
// The office each staff member works in (their expenses are recorded on it)
router.get('/access/staff', ownerOnly, handle(async (req, res) => res.json({ results: await staffOps.staffOffices() })));
router.put('/access/staff/:userId', ownerOnly, handle(async (req, res) => res.json(await staffOps.setStaffOffice(req.params.userId, req.body?.office || null))));
// Daily database backups in a private Google bucket (owner only): list, back up now, download link
const backup = () => require('./services/backup');
router.get('/backups', ownerOnly, handle(async (req, res) => res.json(await backup().overview())));
router.post('/backups', ownerOnly, handle(async (req, res) => res.json(await backup().startManual(req.user))));
router.post('/backups/download', ownerOnly, handle(async (req, res) => {
  const url = await backup().downloadUrl(req.body?.name);
  await require('./services/audit').logAudit({ req, action: 'backup.download', model: 'SystemBackup', after: { name: req.body?.name } });
  res.json({ url });
}));
// Office expenses entered by staff on the system's Expenses screen, from every office
router.get('/office-expenses', can('purchases', 'reports'), handle(async (req, res) => res.json(await staffOps.reviewOfficeExpenses(req.query))));

router.get('/setup/status', ANY, settings.setupStatus);
router.post('/setup/run', P.setup, settings.runSetup);
router.post('/setup/expanded-chart', P.setup, handle(async (req, res) => res.json(await require('./seed/expandedChartSetup').install(req))));
const financialOps = () => require('./services/financialOperations');
const financialTx = () => require('./services/transaction').runInTransaction;
router.get('/financial-operations/catalog', ANY, handle(async (req, res) => res.json(await financialOps().catalog(req))));
router.get('/financial-operations', ANY, handle(async (req, res) => res.json(await financialOps().list(req, req.query))));
router.post('/financial-operations', ANY, handle(async (req, res) => res.json(await financialTx()(session => financialOps().create(req.body || {}, { session, req })))));
router.post('/financial-operations/:id/settle', ANY, handle(async (req, res) => res.json(await financialTx()(session => financialOps().settle(req.params.id, req.body || {}, { session, req })))));
router.get('/bank/lines/:id/financial-operations', P.treasury, handle(async (req, res) => res.json(await financialOps().bankOptions(req.params.id, req))));
router.post('/bank/lines/:id/financial-operation', P.treasury, handle(async (req, res) => res.json(await financialTx()(session => financialOps().settleBank(req.params.id, req.body || {}, { session, req })))));
router.get('/wizard', ANY, settings.wizard);
router.post('/wizard/mark', P.setup, settings.markWizardStep);

router.get('/dashboard', P.dashboard, reports.dashboard);

router.route('/settings').get(ANY, settings.get).patch(P.setup, settings.update);
router.put('/settings/roles', P.setup, settings.updateRoles);
router.put('/settings/office-accounts', P.setup, settings.updateOfficeAccounts);
router.put('/settings/event-journals', P.setup, settings.updateEventJournals);

router.route('/accounts').get(ANY, accounts.list).post(P.setup, accounts.create);
router.get('/orders/:id/legacy-purchases', can('reports', 'purchases'), handle(async (req, res) => res.json(await require('./services/legacyPurchaseApproval').list(req.params.id))));
router.post('/orders/:id/legacy-purchases/:itemId/approve', P.purchases, handle(async (req, res) => res.json(await financialTx()(session => require('./services/legacyPurchaseApproval').approve(req.params.id, req.params.itemId, req.body || {}, { session, req })))));
router.route('/accounts/:id').get(ANY, accounts.get).patch(P.setup, accounts.update).delete(P.setup, accounts.remove);
router.post('/accounts/:id/archive', P.setup, accounts.archive);
router.post('/accounts/:id/unarchive', P.setup, accounts.unarchive);

router.route('/currencies').get(ANY, catalog.listCurrencies).post(P.setup, catalog.createCurrency);
router.route('/currencies/:code').patch(P.setup, catalog.updateCurrency).delete(P.setup, catalog.deleteCurrency);
router.post('/currencies/:code/archive', P.setup, catalog.setCurrencyActive(false));
router.post('/currencies/:code/unarchive', P.setup, catalog.setCurrencyActive(true));

router.route('/offices').get(ANY, catalog.listOffices).post(P.setup, catalog.createOffice);
router.route('/offices/:code').patch(P.setup, catalog.updateOffice).delete(P.setup, catalog.deleteOffice);
router.post('/offices/:code/archive', P.setup, catalog.setOfficeActive(false));
router.post('/offices/:code/unarchive', P.setup, catalog.setOfficeActive(true));

router.route('/journals').get(ANY, catalog.listJournals).post(P.setup, catalog.createJournal);
router.route('/journals/:id').patch(P.setup, catalog.updateJournal).delete(P.setup, catalog.deleteJournal);
router.post('/journals/:id/archive', P.setup, catalog.setJournalActive(false));
router.post('/journals/:id/unarchive', P.setup, catalog.setJournalActive(true));

router.get('/rates/today', ANY, rates.today);
router.post('/rates/import', P.rates, rates.importRates);
router.route('/rates').get(ANY, rates.list).post(P.rates, rates.upsert);
router.delete('/rates/:id', P.rates, rates.remove);

router.get('/migration', P.setup, migration.overview);
router.get('/migration/cost-template', P.setup, migration.costTemplate);
router.post('/migration/runs', P.setup, migration.start);
router.get('/migration/runs/:runId', P.setup, migration.get);
router.post('/migration/runs/:runId/discard', P.setup, migration.discard);
router.post('/migration/runs/:runId/commit', P.setup, migration.commit);
router.post('/migration/runs/:runId/bank-trial', P.setup, migration.enableBankTrial);
// Only bank requests may participate in an explicitly enabled QA trial.
router.use('/bank', require('./services/migration/bankTrial').requestScope);

router.get('/entries/event-types', ANY, entries.eventTypes);
router.route('/entries').get(can('entries', 'entries_view'), entries.list).post(P.entries, entries.createManual);
router.get('/entries/:id', can('entries', 'entries_view', 'reports'), entries.get);
router.post('/entries/:id/cancel', P.entries, P.cancel, entries.cancel);
router.post('/entries/:id/attachments', can('entries', 'treasury'), upload.array('files'), entries.addAttachments);

router.get('/reports/trial-balance', P.reports, reports.trialBalance);
router.get('/reports/account-ledger/:id', can('reports', 'treasury'), reports.accountLedger);
router.get('/reports/income-statement', P.reports, statements.incomeStatement);
const financialAnalysis = require('./controllers/financialAnalysis');
router.get('/financial-analysis', P.reports, financialAnalysis.overview);
router.get('/financial-analysis/configuration', P.reports, financialAnalysis.configuration);
router.get('/financial-analysis/plan', P.reports, financialAnalysis.plan);
router.put('/financial-analysis/settings', P.setup, financialAnalysis.saveSettings);
router.put('/financial-analysis/period', P.setup, financialAnalysis.savePeriod);
router.get('/reports/balance-sheet', P.reports, statements.balanceSheet);
router.get('/reports/cash-flow', P.reports, statements.cashFlow);
router.get('/reports/cash-movements', can('reports', 'treasury'), statements.cashMovements);
router.get('/reports/fx', P.reports, statements.fx);
router.get('/reports/trips', P.reports, statements.trips);
router.get('/shipping-recognition/review', P.reports, handle(async (req, res) => res.json(await require('./services/shippingRecognition').review())));
router.post('/shipping-recognition/apply', ownerOnly, handle(async (req, res) => res.json(await require('./services/shippingRecognition').apply(req.body, req))));
router.get('/free-shipping/review', P.reports, handle(async (req, res) => res.json(await require('./services/freeShippingOffers').review({ orderId: req.query.orderId }))));
router.post('/free-shipping/apply', ownerOnly, handle(async (req, res) => res.json(await require('./services/freeShippingOffers').apply(req.body, req))));
router.get('/reports/purchases', P.reports, statements.purchases);
router.get('/reports/receivables', P.reports, statements.receivables);
router.get('/reports/customer-statement/:id', P.reports, statements.customerStatement);
router.get('/reports/payables', can('reports', 'payments'), statements.payables);
router.get('/customers', P.reports, statements.customers);
router.get('/customer-invoices', P.reports, statements.customerInvoices);
router.get('/exceptions', P.reports, statements.exceptions);
router.get('/wallet-statement-reconciliation', P.reports, handle(async (req, res) => res.json(await require('./services/walletStatementReconciliation').preview())));
router.post('/wallet-statement-reconciliation/repair', ownerOnly, handle(async (req, res) => res.json(await require('./services/walletStatementReconciliation').repair(req.body, req))));
const accountingReview = require('./services/accountingReview');
const reviewTx = fn => require('./services/transaction').runInTransaction(fn);
// Daily work: the day's review, the open backlog in one list, cash counts and the daily close reports
const dailyWork = () => require('./services/dailyWork');
const DAILY_VIEW = can('reports', 'treasury'), DAILY_WORK = can('treasury', 'closing');
router.get('/daily-work/operations/options', DAILY_VIEW, handle(async (req, res) => {
  const { offices } = await require('./services/config').getConfig();
  const users = await require('../models/user').find({ $or: [{ 'roles.isEmployee': true }, { 'roles.isAdmin': true }, { 'roles.isAccountant': true }] })
    .select('firstName lastName').sort({ firstName: 1 }).lean();
  res.json({ users, offices: [...offices.values()].map(o => ({ code: o.code, name: o.name })) });
}));
router.get('/daily-work/operations', DAILY_VIEW, handle(async (req, res) => res.json(await require('./services/employeeOperations').list(req.query))));
router.post('/daily-work/operations/review', DAILY_WORK, handle(async (req, res) => res.json(await reviewTx(session => require('./services/employeeOperations').review(req.body, req, session)))));
router.get('/daily-work/today', DAILY_VIEW, handle(async (req, res) => res.json(await dailyWork().today(req.query))));
router.get('/daily-work/backlog', DAILY_VIEW, handle(async (req, res) => {
  const { all, ...report } = await dailyWork().backlog(req.query);
  res.json(report);
}));
router.post('/daily-work/run-checks', DAILY_VIEW, handle(async (req, res) => { await exceptionsService().runAndStore(); res.json({ success: true }); }));
router.post('/daily-work/tallies', DAILY_WORK, handle(async (req, res) => res.json(await reviewTx(session => dailyWork().saveTally(req.body, { session, req })))));
router.post('/daily-work/tallies/:id/explain', DAILY_WORK, handle(async (req, res) => res.json(await reviewTx(session => dailyWork().explainTally(req.params.id, req.body, { session, req })))));
router.post('/daily-work/tallies/:id/adopt', P.treasury, handle(async (req, res) => res.json(await reviewTx(session => dailyWork().adoptTally(req.params.id, req.body, { session, req })))));
router.post('/daily-work/items', DAILY_WORK, handle(async (req, res) => res.json(await reviewTx(session => dailyWork().reviewItem(req.body, { session, req })))));
router.post('/daily-work/tasks', P.closing, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.updateTask({ ...req.body, storedChecks: true }, { session, req })))));
router.post('/daily-work/close', DAILY_WORK, handle(async (req, res) => res.json(await dailyWork().closeDay(req.body, { req }))));
router.get('/daily-work/closes', DAILY_VIEW, handle(async (req, res) => res.json(await dailyWork().listCloses(req.query))));
router.get('/daily-work/closes/:id', DAILY_VIEW, handle(async (req, res) => res.json(await dailyWork().getClose(req.params.id))));
router.get('/review', can('reports', 'treasury'), handle(async (req, res) => {
  const { allItems, fingerprint, ...report } = await accountingReview.queue(req.query);
  res.json(report);
}));
router.post('/review/tasks', P.closing, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.updateTask(req.body, { session, req })))));
router.post('/review/orders/:id/complete', P.purchases, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.certifyCost(req.params.id, req.body, { session, req })))));
router.post('/review/trips/:id/complete', P.purchases, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.certifyTrip(req.params.id, req.body, { session, req })))));
router.post('/review/bank/complete', P.treasury, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.certifyBank(req.body, { session, req })))));
router.get('/review/status', P.reports, statements.reviewStatus);
router.post('/review/month/approve', P.closing, handle(async (req, res) => res.json(await reviewTx(session => accountingReview.approveMonth(req.body.month, { session, req })))));
// Review items the accountant accepted leave the daily list; the mark can be taken back
const exceptionsService = () => require('./services/reports/exceptions');
router.get('/exceptions/reviewed', P.reports, handle(async (req, res) => res.json({ results: await exceptionsService().listReviewed() })));
router.post('/exceptions/reviewed', P.closing, handle(async (req, res) => {
  const report = await exceptionsService().markReviewed(req.body || {}, req.user);
  await require('./services/audit').logAudit({ req, action: 'exception.reviewed', model: 'AccountingReviewedItem', after: req.body });
  res.json(report);
}));
router.delete('/exceptions/reviewed/:id', P.closing, handle(async (req, res) => {
  const report = await exceptionsService().unmarkReviewed(req.params.id);
  await require('./services/audit').logAudit({ req, action: 'exception.unreviewed', model: 'AccountingReviewedItem', after: { id: req.params.id } });
  res.json(report);
}));
router.get('/summary/order/:id', P.reports, statements.orderSummary);
router.get('/summary/trip/:id', P.reports, statements.tripSummary);
router.get('/summary/customer/:id', P.reports, statements.customerSummary);
router.get('/vouchers/:entryId', can('entries', 'entries_view', 'treasury', 'payments', 'purchases'), statements.voucher);

router.get('/close/month', P.closing, statements.monthChecklist);
router.post('/close/month', P.closing, statements.closeMonth);
router.get('/close/year', P.closing, statements.yearStatus);
router.post('/close/year', P.closing, statements.closeYear);
// Reopening a closed year: the owner only, as an emergency (decision 65)
router.post('/close/year/reopen', ownerOnly, statements.reopenYear);

router.get('/odoo', P.setup, odoo.overview);
router.get('/odoo/master-data', P.setup, odoo.masterData);
router.put('/odoo/settings', P.setup, odoo.saveSettings);
router.put('/odoo/mapping', P.setup, odoo.saveMapping);
router.post('/odoo/exports', P.setup, odoo.createExport);
router.get('/odoo/exports/:id/rows', P.setup, odoo.exportRows);
router.post('/odoo/exports/:id/undo', P.setup, odoo.undoExport);
router.route('/odoo/comparison').get(can('setup', 'reports'), odoo.comparison).post(can('setup', 'reports'), odoo.saveComparison);

router.get('/suspense', P.suspense, suspense.list);
router.post('/suspense/settle', P.suspense, suspense.settle);

router.get('/audit', P.audit, entries.audit);
router.get('/lookup/users', ANY, entries.lookupUsers);
router.get('/lookup/customer-code', can('purchases', 'payments'), documents.lookupCustomerCode);
router.get('/lookup/orders', ANY, documents.lookupOrders);
router.get('/lookup/claims', ANY, documents.lookupClaims);

router.route('/vendors').get(ANY, documents.listVendors).post(can('purchases', 'payments'), documents.createVendor);
router.route('/vendors/:id').patch(P.purchases, documents.updateVendor).delete(P.purchases, documents.deleteVendor);
router.get('/vendors/:id/statement', can('purchases', 'payments', 'reports'), documents.vendorStatement);
router.get('/vendors/:id/open-bills', can('purchases', 'payments'), documents.vendorOpenBills);
router.post('/vendors/:id/archive', P.purchases, documents.setVendorActive(false));
router.post('/vendors/:id/unarchive', P.purchases, documents.setVendorActive(true));

const billImport = require('./services/billImport');
router.post('/bills/duplicate-preview', P.purchases, handle(async (req, res) => res.json(await require('./services/costDuplicates').preview(req.body, { excludeId: req.body.excludeId }))));
router.post('/bills/:id/link-order', P.purchases, handle(async (req, res) => res.json(await reviewTx(session => require('./services/linkExistingCost').link(req.params.id, req.body, { session, req })))));
router.get('/bills/import/references', P.purchases, handle(async (req, res) => res.json(await billImport.templateReferences())));
router.post('/bills/import/preview', P.purchases, handle(async (req, res) => res.json(await billImport.preview(req.body))));
router.post('/bills/import/commit', P.purchases, handle(async (req, res) => res.status(201).json(await billImport.commit(req.body, req))));
router.route('/bills').get(can('purchases', 'payments'), documents.listBills).post(P.purchases, documents.createBill);
router.route('/bills/:id').get(can('purchases', 'payments'), documents.getBill).patch(P.purchases, documents.updateDraftBill).delete(P.purchases, documents.deleteDraftBill);
router.post('/bills/:id/edit-details', P.purchases, handle(async (req, res) => res.json(await reviewTx(session =>
  require('./services/billDetailsEdit').edit(req.params.id, req.body || {}, { session, req })))));
router.post('/bills/:id/edit-preview', P.purchases, handle(async (req, res) => res.json(await
  require('./services/billFinancialEdit').preview(req.params.id, req.body || {}))));
router.post('/bills/:id/edit-posted', P.purchases, handle(async (req, res) => res.json(await reviewTx(session =>
  require('./services/billFinancialEdit').apply(req.params.id, req.body || {}, { session, req })))));
router.post('/bills/:id/post', P.purchases, documents.postDraftBill);

// Each kind of document belongs to one kind of work
router.post('/payments/batch-trial', P.payments, (req, res, next) => req.body?.excessPurpose === 'alipay' ? P.treasury(req, res, next) : next(),
  handle(async (req, res) => res.status(201).json(await require('./services/transaction').runInTransaction((session) =>
    require('./services/posting/batchPaymentTrial').createBatchPayment(req.body || {}, { session, req })))));
const DOCUMENT_KINDS = { payments: 'payments', receipts: 'payments', 'yuan-purchases': 'treasury', 'customer-refunds': 'treasury', 'write-offs': 'entries', transfers: 'treasury', 'cash-counts': 'treasury', salaries: 'payroll', equity: 'assets', nettings: 'assets' };
Object.entries(DOCUMENT_KINDS).forEach(([kind, permission]) => {
  router.route(`/${kind}`).get(can(permission), documents.listDocuments(kind)).post(can(permission), documents.createDocument(kind));
});
const MODEL_PERMISSIONS = {
  AccountingSupplierBill: 'purchases', AccountingSupplierPayment: 'payments', AccountingSupplierReceipt: 'payments', AccountingYuanPurchase: 'treasury', AccountingCustomerRefund: 'treasury', AccountingClaimWriteOff: 'entries', AccountingTreasuryTransfer: 'treasury', AccountingCashCount: 'treasury',
  AccountingSalaryPayment: 'payroll', AccountingFixedAsset: 'assets', AccountingPrepaidExpense: 'assets', AccountingEquityTransaction: 'assets', AccountingNetting: 'assets',
};
const byModel = (req, res, next) => can(MODEL_PERMISSIONS[req.params.model] || 'setup')(req, res, next);
router.post('/documents/:model/:id/cancel', byModel, P.cancel, documents.cancel);
router.post('/documents/:model/:id/attachments', byModel, upload.array('files'), documents.addAttachments);

router.get('/reports/abandoned', P.reports, require('./controllers/util').handle(async (req, res) => res.json(await require('./services/abandoned').abandonedList())));
// Sub cash boxes (spec v8): balances, and handing their money over to the main box
router.get('/treasury/sub-boxes', can('treasury', 'reports'), require('./controllers/util').handle(async (req, res) => res.json({ results: await require('./services/subBoxes').subBoxes() })));
router.post('/treasury/sub-boxes/:id/hand-over', P.treasury, require('./controllers/util').handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/subBoxes').handOver(req.params.id, { session, req, amount: req.body?.amount })))));
router.get('/alipay', can('treasury', 'reports'), documents.alipayDashboard);
router.post('/yuan-purchases/:id/complete', P.treasury, documents.completeYuanPurchase);
router.post('/yuan-purchases/:id/settle', P.treasury, documents.settleYuanPurchase);
router.get('/alipay/orders/:orderId', can('treasury', 'reports'), require('./controllers/util').handle(async (req, res) => res.json(await require('./services/posting/alipay').remittanceStatus(req.params.orderId))));
router.post('/alipay/orders/:orderId/send', P.treasury, require('./controllers/util').handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/alipay').sendRemittance(req.params.orderId, req.body || {}, { session, req })))));
router.get('/assets', P.assets, documents.listAssets);
router.post('/assets/depreciate', P.assets, documents.runDepreciation);
router.post('/assets/:id/dispose', P.assets, documents.disposeAsset);
router.get('/prepaid', P.assets, documents.listPrepaid);
router.post('/prepaid/amortize', P.assets, documents.runAmortization);

router.get('/employees', can('payroll', 'purchases', 'treasury'), documents.listEmployees);
const employeeDirectory = require('./controllers/employees');
router.post('/employees', P.payroll, employeeDirectory.create);
router.put('/employees/:id', P.payroll, employeeDirectory.update);
router.delete('/employees/:id', P.payroll, employeeDirectory.archive);
router.post('/employees/:id/restore', P.payroll, employeeDirectory.restore);
router.get('/employees/:id', P.payroll, employeeDirectory.detail);
router.get('/employees/:id/salary-preview', P.payroll, employeeDirectory.preview);
router.post('/employees/:id/adjustments', P.payroll, employeeDirectory.adjustment);
router.delete('/employees/:id/adjustments/:adjustmentId', P.payroll, employeeDirectory.cancelAdjustment);
router.post('/employees/:id/adjustments/:adjustmentId/close', P.payroll, employeeDirectory.closeCommission);
router.post('/employees/:id/adjustments/:adjustmentId/reopen', P.payroll, employeeDirectory.reopenCommission);
// One employee's custody or loan movements (?kind=custody|loan)
router.get('/employees/:id/movements', can('payroll', 'purchases', 'treasury'), handle(async (req, res) => res.json(await require('./services/custody').movements(req.params.id, req.query.kind === 'loan' ? 'loan' : 'custody'))));
router.get('/trips', ANY, documents.listTrips);
// Under /bank so trial snapshots and rollback cover the entire settlement.
router.get('/bank/trip-cost-settlements/options', P.purchases, handle(async (req, res) => res.json(await require('./services/tripCostSettlement').options(req.query))));
router.post('/bank/trip-cost-settlements/preview', P.purchases, handle(async (req, res) => res.json((await require('./services/tripCostSettlement').preview(req.body)).output)));
router.post('/bank/trip-cost-settlements/match-preview', P.purchases, P.treasury, handle(async (req, res) => res.json(await require('./services/tripCostSettlement').matchPreview(req.body))));
router.post('/bank/trip-cost-settlements/match', P.purchases, P.treasury, handle(async (req, res) => res.json(await reviewTx(session => require('./services/tripCostSettlement').matchExisting(req.body, { session, req })))));
router.post('/bank/trip-cost-settlements', P.purchases, P.treasury, handle(async (req, res) => res.json(await reviewTx(session => require('./services/tripCostSettlement').apply(req.body, { session, req })))));
router.get('/bank/trip-cost-settlements', P.purchases, handle(async (req, res) => res.json({ results: await require('./models/TripCostSettlement').find({}).sort({ createdAt: -1 }).limit(100).lean() })));
router.post('/bank/trip-cost-settlements/:id/cancel', P.purchases, P.treasury, P.cancel, handle(async (req, res) => res.json(await reviewTx(session => require('./services/tripCostSettlement').cancel(req.params.id, { session, req, reason: req.body.reason })))));
router.get('/balances/:id', can('treasury', 'payments', 'purchases', 'payroll', 'reports'), documents.accountBalance);

router.get('/bank/lines', P.treasury, documents.listBankLines);
router.get('/bank/duplicate-settlement', P.treasury, P.payments, P.purchases, handle(async (req, res) => res.json(await require('./services/posting/bankDuplicateSettlement').preview(req.query.accountId))));
router.post('/bank/duplicate-settlement', P.treasury, P.payments, P.purchases, P.cancel, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankDuplicateSettlement').apply(req.body || {}, { session, req })))));
router.get('/bank/lines/:id', P.treasury, documents.bankLineDetails);
router.post('/bank/lines/:id/translate', P.treasury, handle(async (req, res) => res.json(await require('./services/statementTranslation').translateLine(req.params.id, req))));
router.patch('/bank/lines/:id', P.treasury, documents.editBankLine);
router.get('/bank/suggestions', P.treasury, documents.bankSuggestions);
router.get('/bank/purchases', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/bankPurchaseReview').listPurchases(req.query))));
router.get('/bank/purchase-reconciliation', can('treasury', 'reports'), handle(async (req, res) => res.json(await require('./services/posting/purchaseReconciliation').list(req.query))));
router.get('/bank/purchase-reconciliation/candidates', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/purchaseReconciliation').statementCandidates(req.query))));
router.get('/bank/historical-purchases', P.treasury, P.setup, handle(async (req, res) => res.json(await require('./services/posting/purchaseReconciliation').historicalRows(req.query))));
router.post('/bank/historical-purchases/settle', P.treasury, P.setup, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/purchaseReconciliation').settleHistorical(req.body || {}, { session, req })))));
router.get('/bank/refunds', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/bankRefund').list(req.query))));
router.get('/bank/previous-wallet-refunds', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/legacyWalletRefunds').candidates(req.query))));
router.get('/bank/previous-wallet-refunds/all', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/legacyWalletRefunds').listUnlinked(req.query))));
router.post('/bank/lines/:id/refund-match', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankRefund').match(req.params.id, req.body || {}, { session, req })))));
router.post('/bank/lines/:id/unlink-wallet-refund', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankWalletRefundLink').unlink(req.params.id, { session, req })))));
router.post('/bank/lines/:id/purchase-match', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankPurchaseReview').matchPurchase(req.params.id, req.body || {}, { session, req })))));
router.post('/bank/lines/:id/exact-match', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankExactMatch').match(req.params.id, req.body || {}, { session, req })))));
router.post('/bank/classify', P.treasury, documents.classifyBankRows);
router.route('/bank/rules').get(P.treasury, documents.listBankRules).post(P.treasury, documents.saveBankRule);
router.delete('/bank/rules/:id', P.treasury, documents.deleteBankRule);
router.post('/bank/parse-pdf', P.treasury, upload.single('file'), documents.parseBankPdf);
router.post('/bank/import', P.treasury, documents.importBankLines);
router.post('/bank/auto-match', P.treasury, documents.autoMatchBank);
router.get('/bank/local-reset/available', P.treasury, P.cancel, handle(async (req, res) => res.json({ available: require('./services/posting/localBankReset').available(req) })));
router.post('/bank/local-reset/preview', P.treasury, P.cancel, handle(async (req, res) => res.json(await require('./services/posting/localBankReset').preview(req.body || {}, { req }))));
router.post('/bank/local-reset', P.treasury, P.cancel, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/localBankReset').reset(req.body || {}, { session, req })))));
router.post('/bank/group-match/preview', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/bankGroups').preview(req.body || {}))));
router.post('/bank/group-match', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankGroups').match(req.body || {}, { session, req })))));
router.post('/bank/lines/:id/review-duplicate', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankEvidence').resolve(req.params.id, req.body || {}, { session, req })))));
router.get('/bank/late-expense', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/bankReviewTools').lateExpense(req.query.billId))));
router.get('/bank/integrity', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/bankReviewTools').integrity(req.query.accountId))));
router.post('/bank/integrity/release', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction(session => require('./services/posting/bankReviewTools').releaseInvalid(req.body || {}, { session, req })))));
router.post('/bank/lines/:id/match', P.treasury, documents.matchBankLine);
router.post('/bank/lines/:id/entry', P.treasury, documents.bankLineEntry);
// Several lines for one purchase typed on an order (spec v8)
router.get('/bank/order-items/:orderId', P.treasury, require('./controllers/util').handle(async (req, res) => res.json(await require('./services/posting/bank').orderPurchaseItems(req.params.orderId))));
router.post('/bank/link-group', P.treasury, require('./controllers/util').handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/bank').linkGroup(req.body?.lineIds, req.body || {}, { session, req })))));
router.post('/bank/lines/:id/cancel-entry', P.treasury, P.cancel, documents.cancelBankLineEntry);
router.post('/bank/lines/:id/ignore', P.treasury, documents.ignoreBankLine(true));
router.post('/bank/lines/:id/unignore', P.treasury, documents.ignoreBankLine(false));
router.delete('/bank/lines/:id', P.treasury, documents.deleteBankLine);
// A partner's current account (Wasl): its incoming lines proposed against the partner's wallet deposits by amount
router.get('/bank/partner-deposits', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/partnerDeposits').suggestions(req.query.accountId))));
router.get('/bank/lines/:id/partner-deposit-options', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/partnerDeposits').options(req.params.id))));
router.post('/bank/lines/:id/cover', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/bank').coverBeforeCount(req.params.id, req.body || {}, { session, req })))));
// Yuan bought from a broker arriving in Alipay: matched to a recorded purchase, or recorded from the lines
router.get('/bank/coverage', can('treasury', 'reports'), handle(async (req, res) => res.json(await require('./services/posting/bank').coverage(req.query))));
router.get('/bank/yuan-lines', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/yuanLines').suggestions(req.query.accountId))));
router.post('/bank/yuan-lines', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/yuanLines').record(req.body || {}, { session, req })))));
router.post('/bank/lines/:id/yuan-match', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/yuanLines').matchExisting(req.params.id, req.body || {}, { session, req })))));
router.get('/bank/partner-transfers', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/partnerTransfers').suggestions(req.query.accountId))));
router.get('/bank/lines/:id/partner-transfer-options', P.treasury, handle(async (req, res) => res.json(await require('./services/posting/partnerTransfers').options(req.params.id, req.query))));
router.post('/bank/lines/:id/partner-transfers', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/partnerTransfers').apply(req.params.id, req.body || {}, { session, req })))));
router.post('/bank/lines/:id/partner-deposit', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/partnerDeposits').apply(req.params.id, req.body || {}, { session, req })))));
// Lines nobody can explain yet: parked on a clearing account, decided by the owner after their wait
router.get('/bank/unidentified', can('treasury', 'reports'), handle(async (req, res) => res.json(await require('./services/posting/unidentified').list(req.query))));
router.post('/bank/lines/:id/park', P.treasury, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/unidentified').park(req.params.id, req.body || {}, { session, req })))));
router.post('/bank/lines/:id/unidentified-decision', ownerOnly, handle(async (req, res) => res.json(await require('./services/transaction').runInTransaction((session) => require('./services/posting/unidentified').decide(req.params.id, req.body || {}, { session, req })))));

router.get('/live', P.setup, live.status);
router.get('/live/events', P.setup, live.list);
router.post('/live/process', P.setup, live.process);
router.post('/live/events/:id/retry', P.setup, live.retry);

router.route('/expense-types').get(ANY, documents.listExpenseTypes).post(P.setup, documents.saveExpenseType);
router.patch('/expense-types/:id', P.setup, documents.saveExpenseType);

module.exports = router;
