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

// Who may do what (the owner manages it)
router.get('/access/me', access.me);
router.get('/access/members', ownerOnly, access.members);
router.put('/access/members/:userId', ownerOnly, access.saveMember);
// The office each staff member works in (their expenses are recorded on it)
router.get('/access/staff', ownerOnly, handle(async (req, res) => res.json({ results: await staffOps.staffOffices() })));
router.put('/access/staff/:userId', ownerOnly, handle(async (req, res) => res.json(await staffOps.setStaffOffice(req.params.userId, req.body?.office || null))));
// Office expenses entered by staff on the system's Expenses screen, from every office
router.get('/office-expenses', can('purchases', 'reports'), handle(async (req, res) => res.json(await staffOps.reviewOfficeExpenses(req.query))));

router.get('/setup/status', ANY, settings.setupStatus);
router.post('/setup/run', P.setup, settings.runSetup);
router.get('/wizard', ANY, settings.wizard);
router.post('/wizard/mark', P.setup, settings.markWizardStep);

router.get('/dashboard', P.dashboard, reports.dashboard);

router.route('/settings').get(ANY, settings.get).patch(P.setup, settings.update);
router.put('/settings/roles', P.setup, settings.updateRoles);
router.put('/settings/office-accounts', P.setup, settings.updateOfficeAccounts);
router.put('/settings/event-journals', P.setup, settings.updateEventJournals);

router.route('/accounts').get(ANY, accounts.list).post(P.setup, accounts.create);
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

router.get('/entries/event-types', ANY, entries.eventTypes);
router.route('/entries').get(P.entries, entries.list).post(P.entries, entries.createManual);
router.get('/entries/:id', can('entries', 'reports'), entries.get);
router.post('/entries/:id/cancel', P.entries, P.cancel, entries.cancel);
router.post('/entries/:id/attachments', can('entries', 'treasury'), upload.array('files'), entries.addAttachments);

router.get('/reports/trial-balance', P.reports, reports.trialBalance);
router.get('/reports/account-ledger/:id', can('reports', 'treasury'), reports.accountLedger);
router.get('/reports/income-statement', P.reports, statements.incomeStatement);
router.get('/reports/balance-sheet', P.reports, statements.balanceSheet);
router.get('/reports/cash-flow', P.reports, statements.cashFlow);
router.get('/reports/cash-movements', can('reports', 'treasury'), statements.cashMovements);
router.get('/reports/fx', P.reports, statements.fx);
router.get('/reports/trips', P.reports, statements.trips);
router.get('/reports/purchases', P.reports, statements.purchases);
router.get('/reports/receivables', P.reports, statements.receivables);
router.get('/reports/customer-statement/:id', P.reports, statements.customerStatement);
router.get('/reports/payables', can('reports', 'payments'), statements.payables);
router.get('/customers', P.reports, statements.customers);
router.get('/customer-invoices', P.reports, statements.customerInvoices);
router.get('/exceptions', P.reports, statements.exceptions);
router.get('/summary/order/:id', P.reports, statements.orderSummary);
router.get('/summary/trip/:id', P.reports, statements.tripSummary);
router.get('/summary/customer/:id', P.reports, statements.customerSummary);
router.get('/vouchers/:entryId', can('entries', 'treasury', 'payments', 'purchases'), statements.voucher);

router.get('/close/month', P.closing, statements.monthChecklist);
router.post('/close/month', P.closing, statements.closeMonth);
router.get('/close/year', P.closing, statements.yearStatus);
router.post('/close/year', P.closing, statements.closeYear);
router.post('/close/year/reopen', P.closing, statements.reopenYear);

router.get('/odoo', P.setup, odoo.overview);
router.put('/odoo/settings', P.setup, odoo.saveSettings);
router.put('/odoo/mapping', P.setup, odoo.saveMapping);
router.post('/odoo/exports', P.setup, odoo.createExport);
router.get('/odoo/exports/:id/rows', P.setup, odoo.exportRows);
router.post('/odoo/exports/:id/undo', P.setup, odoo.undoExport);

router.get('/suspense', P.suspense, suspense.list);
router.post('/suspense/settle', P.suspense, suspense.settle);

router.get('/audit', P.audit, entries.audit);
router.get('/lookup/users', ANY, entries.lookupUsers);
router.get('/lookup/orders', ANY, documents.lookupOrders);
router.get('/lookup/claims', ANY, documents.lookupClaims);

router.route('/vendors').get(ANY, documents.listVendors).post(can('purchases', 'payments'), documents.createVendor);
router.route('/vendors/:id').patch(P.purchases, documents.updateVendor).delete(P.purchases, documents.deleteVendor);
router.get('/vendors/:id/statement', can('purchases', 'payments', 'reports'), documents.vendorStatement);
router.get('/vendors/:id/open-bills', can('purchases', 'payments'), documents.vendorOpenBills);
router.post('/vendors/:id/archive', P.purchases, documents.setVendorActive(false));
router.post('/vendors/:id/unarchive', P.purchases, documents.setVendorActive(true));

router.route('/bills').get(can('purchases', 'payments'), documents.listBills).post(P.purchases, documents.createBill);
router.route('/bills/:id').get(can('purchases', 'payments'), documents.getBill).patch(P.purchases, documents.updateDraftBill).delete(P.purchases, documents.deleteDraftBill);
router.post('/bills/:id/post', P.purchases, documents.postDraftBill);

// Each kind of document belongs to one kind of work
const DOCUMENT_KINDS = { payments: 'payments', receipts: 'payments', transfers: 'treasury', 'cash-counts': 'treasury', salaries: 'payroll', equity: 'assets', nettings: 'assets' };
Object.entries(DOCUMENT_KINDS).forEach(([kind, permission]) => {
  router.route(`/${kind}`).get(can(permission), documents.listDocuments(kind)).post(can(permission), documents.createDocument(kind));
});
const MODEL_PERMISSIONS = {
  AccountingSupplierBill: 'purchases', AccountingSupplierPayment: 'payments', AccountingSupplierReceipt: 'payments', AccountingTreasuryTransfer: 'treasury', AccountingCashCount: 'treasury',
  AccountingSalaryPayment: 'payroll', AccountingFixedAsset: 'assets', AccountingPrepaidExpense: 'assets', AccountingEquityTransaction: 'assets', AccountingNetting: 'assets',
};
const byModel = (req, res, next) => can(MODEL_PERMISSIONS[req.params.model] || 'setup')(req, res, next);
router.post('/documents/:model/:id/cancel', byModel, P.cancel, documents.cancel);
router.post('/documents/:model/:id/attachments', byModel, upload.array('files'), documents.addAttachments);

router.get('/assets', P.assets, documents.listAssets);
router.post('/assets/depreciate', P.assets, documents.runDepreciation);
router.post('/assets/:id/dispose', P.assets, documents.disposeAsset);
router.get('/prepaid', P.assets, documents.listPrepaid);
router.post('/prepaid/amortize', P.assets, documents.runAmortization);

router.get('/employees', can('payroll', 'purchases', 'treasury'), documents.listEmployees);
router.get('/trips', ANY, documents.listTrips);
router.get('/balances/:id', can('treasury', 'payments', 'purchases', 'payroll', 'reports'), documents.accountBalance);

router.get('/bank/lines', P.treasury, documents.listBankLines);
router.get('/bank/suggestions', P.treasury, documents.bankSuggestions);
router.post('/bank/classify', P.treasury, documents.classifyBankRows);
router.route('/bank/rules').get(P.treasury, documents.listBankRules).post(P.treasury, documents.saveBankRule);
router.delete('/bank/rules/:id', P.treasury, documents.deleteBankRule);
router.post('/bank/parse-pdf', P.treasury, upload.single('file'), documents.parseBankPdf);
router.post('/bank/import', P.treasury, documents.importBankLines);
router.post('/bank/auto-match', P.treasury, documents.autoMatchBank);
router.post('/bank/lines/:id/match', P.treasury, documents.matchBankLine);
router.post('/bank/lines/:id/entry', P.treasury, documents.bankLineEntry);
router.post('/bank/lines/:id/cancel-entry', P.treasury, P.cancel, documents.cancelBankLineEntry);
router.post('/bank/lines/:id/ignore', P.treasury, documents.ignoreBankLine(true));
router.post('/bank/lines/:id/unignore', P.treasury, documents.ignoreBankLine(false));
router.delete('/bank/lines/:id', P.treasury, documents.deleteBankLine);

router.get('/live', P.setup, live.status);
router.get('/live/events', P.setup, live.list);
router.post('/live/process', P.setup, live.process);
router.post('/live/events/:id/retry', P.setup, live.retry);

router.route('/expense-types').get(ANY, documents.listExpenseTypes).post(P.setup, documents.saveExpenseType);
router.patch('/expense-types/:id', P.setup, documents.saveExpenseType);

module.exports = router;
