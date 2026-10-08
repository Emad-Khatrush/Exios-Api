const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { Vendor, SupplierBill } = require('../models/documents');
const { runInTransaction } = require('../services/transaction');
const payables = require('../services/posting/payables');
const imports = require('../services/billImport');
const req = { user: { _id: oid(), roles: { isAdmin: true } } };
let vendor, rows;
beforeAll(startDb); afterAll(stopDb);
beforeEach(async () => {
  await resetDb(); vendor = await Vendor.create({ name: 'Excel review supplier', type: 'supplier' });
  rows = [{ reference: 'EXCEL-ONE', vendor: vendor.name, vendorRef: 'INV-EXCEL-ONE', day: '2026-09-10', currency: 'USD', amount: 800,
    description: 'Purchase cost', target: 'expense', account: '510400', office: 'tripoli' }];
});
test('preview is read-only and retrying a completed import returns the original invoice', async () => {
  const preview = await imports.preview({ kind: 'bills', rows });
  expect(preview.groups[0].status).toBe('ready');
  expect(await SupplierBill.countDocuments()).toBe(0);
  const body = { kind: 'bills', rows, mode: 'post', previewHash: preview.groups[0].previewHash };
  const first = await imports.commit(body, req), retry = await imports.commit(body, req);
  expect(retry).toMatchObject({ duplicate: true, _id: first._id });
  expect(await SupplierBill.countDocuments()).toBe(1);
});
test('Excel exposes a cross-screen potential duplicate and requires an explicit independent decision', async () => {
  const expense = await account('510400');
  await runInTransaction(session => payables.createBill({ vendorId: vendor._id, vendorRef: 'OTHER-INV', day: '2026-09-10', currency: 'USD',
    lines: [{ description: 'Existing purchase', amount: 800, target: 'expense', accountId: expense._id, office: 'tripoli' }] }, { session, req }));
  const preview = await imports.preview({ kind: 'bills', rows });
  expect(preview.groups[0].duplicateReview.results).toHaveLength(1);
  const body = { kind: 'bills', rows, mode: 'post', previewHash: preview.groups[0].previewHash };
  await expect(imports.commit(body, req)).rejects.toThrow('تكلفة محتملة');
  await imports.commit({ ...body, duplicateDecision: 'independent', duplicateReason: 'Separate actual supplier invoice' }, req);
  expect(await SupplierBill.countDocuments()).toBe(2);
});
