const { startDb, stopDb, resetDb, account, oid } = require('./helpers');
const { AccountingEvent, JournalEntry } = require('../models');
const { runInTransaction } = require('../services/transaction');
const { postEntry } = require('../services/ledger');
const { HANDLERS, processEvent, emitAccountingEvent } = require('../services/events');

jest.setTimeout(120000);
beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => { await resetDb(); });
afterEach(() => { delete HANDLERS.robustness; });

async function writeMovement(id, { session }) {
  const cash = await account('110101');
  const capital = await account('310000');
  const entry = await postEntry({
    eventType: 'MANUAL', eventKey: `ROBUST:${id}`, date: '2026-03-01', description: 'Worker retry audit',
    lines: [{ accountId: cash._id, debit: 1000 }, { accountId: capital._id, credit: 1000 }],
  }, { session });
  return { entryId: entry._id };
}

test('a posting failure rolls back its journal and a retry commits the journal and event together', async () => {
  const event = await AccountingEvent.create({ type: 'robustness', refId: oid() });
  HANDLERS.robustness = async (id, payload, ctx) => {
    await writeMovement(id, ctx);
    throw new Error('simulated failure after journal creation');
  };
  const failed = await processEvent(event);
  expect(failed.status).toBe('failed');
  expect(failed.attempts).toBe(1);
  expect(await JournalEntry.countDocuments()).toBe(0);
  HANDLERS.robustness = (id, payload, ctx) => writeMovement(id, ctx);
  const retried = await processEvent(failed, { resetAttempts: true });
  expect(retried.status).toBe('done');
  expect(retried.attempts).toBe(0);
  expect(retried.lastError).toBeUndefined();
  expect(await JournalEntry.countDocuments()).toBe(1);
});

test('two workers processing one event commit one journal and keep its terminal status', async () => {
  HANDLERS.robustness = (id, payload, ctx) => writeMovement(id, ctx);
  const event = await AccountingEvent.create({ type: 'robustness', refId: oid() });
  const copies = await Promise.all([AccountingEvent.findById(event._id), AccountingEvent.findById(event._id)]);
  const results = await Promise.all(copies.map((copy) => processEvent(copy)));
  expect(results.map((r) => r.status)).toEqual(['done', 'done']);
  expect((await AccountingEvent.findById(event._id)).status).toBe('done');
  expect(await JournalEntry.countDocuments()).toBe(1);
});

test('a stale retry cannot execute a completed event again', async () => {
  HANDLERS.robustness = (id, payload, ctx) => writeMovement(id, ctx);
  const event = await AccountingEvent.create({ type: 'robustness', refId: oid() });
  await processEvent(event);
  HANDLERS.robustness = jest.fn(() => { throw new Error('must not run'); });
  const again = await processEvent(event, { resetAttempts: true });
  expect(again.status).toBe('done');
  expect(HANDLERS.robustness).not.toHaveBeenCalled();
  expect(await JournalEntry.countDocuments()).toBe(1);
});

test('covered and skipped events cannot be replayed by manual retry', async () => {
  HANDLERS.robustness = jest.fn(() => { throw new Error('must not run'); });
  for (const status of ['covered', 'skipped']) {
    const event = await AccountingEvent.create({ type: 'robustness', refId: oid(), status });
    expect((await processEvent(event, { resetAttempts: true })).status).toBe(status);
  }
  expect(HANDLERS.robustness).not.toHaveBeenCalled();
  expect(await JournalEntry.countDocuments()).toBe(0);
});

test('an operational transaction that fails also rolls back its outbox event', async () => {
  await expect(runInTransaction(async (session) => {
    await emitAccountingEvent('order', oid(), {}, undefined, { session });
    throw new Error('simulated operational failure');
  })).rejects.toThrow('simulated operational failure');
  expect(await AccountingEvent.countDocuments()).toBe(0);
});
