const { startDb, stopDb, resetDb, oid } = require('./helpers');
const Balance = require('../../models/balance');
const { payOrderDebts, restoreOrderDebts } = require('../../utils/debts');

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

const newDebt = (order, fields = {}) => Balance.create({
  order, owner: oid(), createdBy: oid(), createdOffice: 'tripoli', balanceType: 'debt', debtType: 'invoice',
  amount: 100, initialAmount: 100, currency: 'USD', notes: 'دين فاتورة', ...fields,
});

test('a payment on the order pays down its debt, and cancelling it reopens the debt', async () => {
  const order = oid();
  const debt = await newDebt(order);
  const other = await newDebt(order, { debtType: 'general' });

  // dinars at a rate that closes the 100 dollars exactly
  const applied = await payOrderDebts({ orderId: order, category: 'invoice', amount: 927, currency: 'LYD', rate: 9.27, orderNumber: 'O1' });
  expect(applied).toHaveLength(1);
  let saved = await Balance.findById(debt._id);
  expect(saved.amount).toBe(0);
  expect(saved.status).toBe('waitingApproval');
  expect(saved.paymentHistory).toHaveLength(1);
  // a general debt is not the invoice: it stays as it is
  expect((await Balance.findById(other._id)).amount).toBe(100);

  await restoreOrderDebts(applied);
  saved = await Balance.findById(debt._id);
  expect(saved.amount).toBe(100);
  expect(saved.status).toBe('open');
  expect(saved.paymentHistory).toHaveLength(0);
});

test('a partial payment leaves the rest of the debt open; dollars are not taken against a dinar debt', async () => {
  const order = oid();
  const debt = await newDebt(order);
  await payOrderDebts({ orderId: order, category: 'invoice', amount: 40, currency: 'USD', rate: 0 });
  const saved = await Balance.findById(debt._id);
  expect(saved.amount).toBe(60);
  expect(saved.status).toBe('open');

  const dinars = await newDebt(oid(), { currency: 'LYD' });
  expect(await payOrderDebts({ orderId: dinars.order, category: 'invoice', amount: 50, currency: 'USD', rate: 0 })).toHaveLength(0);
});
