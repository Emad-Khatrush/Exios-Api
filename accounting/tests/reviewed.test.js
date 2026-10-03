// Review items the accountant accepted leave the daily list until the mark is taken back;
// errors cannot be hidden this way.
const mongoose = require('mongoose');
const { startDb, stopDb, resetDb } = require('./helpers');
const { ReviewedItem } = require('../models');
const exceptions = require('../services/reports/exceptions');
const Inventory = require('../../models/inventory');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const trips = (report) => report.results.find((r) => r.key === 'tripsWithoutCost');

test('a reviewed trip leaves the list, is counted apart, and comes back when the mark is taken back', async () => {
  const order = new mongoose.Types.ObjectId();
  const [a, b] = await Inventory.create([
    { voyage: 'AIR-1', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', arrivalDate: new Date('2026-01-10'), orders: [{ _id: order }] },
    { voyage: 'AIR-2', inventoryType: 'inventoryGoods', shippingType: 'air', inventoryPlace: 'tripoli', arrivalDate: new Date('2026-01-12'), orders: [{ _id: order }] },
  ].map((t) => ({ ...t, shippedCountry: 'CN' })));
  let report = await exceptions.runAndStore();
  expect(trips(report).count).toBe(2);
  const item = trips(report).items.find((i) => i.label === 'AIR-1');
  expect(item.ref).toBe(`/inventory/${a._id}/edit`);

  report = await exceptions.markReviewed({ check: 'tripsWithoutCost', ref: item.ref, label: item.label, note: 'رحلة قديمة' }, { _id: new mongoose.Types.ObjectId() });
  expect(trips(report)).toMatchObject({ count: 1, reviewedCount: 1 });
  expect(trips(report).items.map((i) => i.label)).toEqual(['AIR-2']);
  // the stored report the dashboard reads changed too
  expect(trips(await exceptions.latest())).toMatchObject({ count: 1, reviewedCount: 1 });

  const [mark] = await exceptions.listReviewed();
  expect(mark).toMatchObject({ check: 'tripsWithoutCost', label: 'AIR-1', note: 'رحلة قديمة' });
  report = await exceptions.unmarkReviewed(String(mark._id));
  expect(trips(report)).toMatchObject({ count: 2, reviewedCount: 0 });
  expect(String(b._id)).toBeTruthy();
});

test('errors cannot be hidden, and unknown checks are refused', async () => {
  await expect(exceptions.markReviewed({ check: 'nope', ref: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  await ReviewedItem.create({ check: 'roles', ref: 'customer_receivable' });
  const report = await exceptions.runChecks({ only: ['roles'] });
  expect(report.results[0].reviewedCount).toBe(0);
});
