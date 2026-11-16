// node scripts/seedLoyaltyDemo.js [--clean]
//
// LOCAL demo data for the loyalty points feature (spec 2026-11-16), for customer F762, so every
// scenario can be tried by hand in the client app and the admin panel. Runs ONLY against
// mongodb://127.0.0.1:27017/exios-prod-copy (the URL the app would use, MONGO_URL_2 || MONGO_URL
// from .env); anything else aborts before connecting.
//
//   (no flag)  removes the previous demo data, then builds a fresh set and writes
//              scripts/seedLoyaltyDemo.out.txt
//   --clean    removes the demo data only
//
// Demo data = orders tagged demoSeed 'loyalty' (productName "تجربة نقاط — ..."), their payment
// records, every LoyaltyPoint movement of F762, and journal entries that reference the demo orders
// or are LOYALTY_* entries of F762. Nothing else is removed. The user document is left as found
// (the services bump users.walletPostingVersion as a lock; it is put back to its value at start).
//
// Orders, claims (syncOrder), cash payments (OrderPaymentHistory + postCashPayment) and every
// loyalty step go through the real services. Shortcuts, printed in the output: delivery sets
// paymentList.status.received then syncOrder (as the tests do); cancellation sets isCanceled then
// syncOrder WITHOUT returning payments to the wallet (the cancel screen would credit the wallet);
// the two expiry lots are staff "add" lots whose expiresAt is moved directly.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const ALLOWED_DB = 'exios-prod-copy';
const CUSTOMER_ID = 'F762';
const CUSTOMER_OID = '69e0d687092261f36c36dff5';
const TAG = 'loyalty';
const PREFIX = 'تجربة نقاط — ';
const OUT_FILE = path.join(__dirname, 'seedLoyaltyDemo.out.txt');
const DAY = 24 * 3600 * 1000;

function assertLocalUrl() {
  const uri = process.env.MONGO_URL_2 || process.env.MONGO_URL;
  if (!uri) throw new Error('No MONGO_URL_2 / MONGO_URL: refusing to run');
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/:?,]+)(?::(\d+))?\/([^?]+)(\?.*)?$/.exec(uri);
  if (!match) throw new Error(`Refusing: not a plain single-host mongodb:// URL`);
  const [, host, , db] = match;
  if (!['127.0.0.1', 'localhost'].includes(host) || db !== ALLOWED_DB) {
    throw new Error(`Refusing: the app URL points to host "${host}", db "${db}". Only 127.0.0.1/localhost and ${ALLOWED_DB} are allowed.`);
  }
  return uri;
}

const uri = assertLocalUrl();
const Order = require('../models/order');
const OrderPaymentHistory = require('../models/orderPaymentHistory');
const LoyaltyPoint = require('../models/loyaltyPoint');
const { JournalEntry } = require('../accounting/models');
const { runInTransaction } = require('../accounting/services/transaction');
const { syncOrder } = require('../accounting/services/claims/sync');
const { postCashPayment } = require('../accounting/services/posting/operations');
const { purchaseKey, shipmentKey } = require('../accounting/services/claims/keys');
const { resolveAccount } = require('../accounting/services/roles');
const { getBalance } = require('../accounting/services/carrying');
const { getConfig } = require('../accounting/services/config');
const { ensureLoyaltySetup } = require('../accounting/seed/loyaltySetup');
const loyalty = require('../accounting/services/loyalty');
const orderid = require('order-id')('key');

const tx = (fn) => runInTransaction(fn);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const notes = [];

async function customer() {
  const user = await mongoose.connection.collection('users').findOne({ customerId: CUSTOMER_ID });
  if (!user || String(user._id) !== CUSTOMER_OID) throw new Error(`Customer ${CUSTOMER_ID} not found with _id ${CUSTOMER_OID}`);
  return user;
}

async function clean(user) {
  const orders = await Order.collection.find({ demoSeed: TAG, user: user._id }).project({ _id: 1, productName: 1 }).toArray();
  const bad = orders.filter((o) => !String(o.productName || '').startsWith(PREFIX));
  if (bad.length) throw new Error(`Tagged orders without the demo prefix: ${bad.map((o) => o._id).join(', ')}; refusing to clean`);
  const orderIds = orders.map((o) => o._id);
  const payments = await OrderPaymentHistory.collection.find({ order: { $in: orderIds } }).project({ _id: 1 }).toArray();
  const paymentIds = payments.map((p) => p._id);
  const movements = await LoyaltyPoint.collection.find({ user: user._id }).project({ _id: 1 }).toArray();
  const movementIds = movements.map((m) => m._id);
  const entryFilter = { $or: [
    ...(orderIds.length ? [{ 'lines.orderId': { $in: orderIds } }, { 'lines.arKey': { $in: orderIds.flatMap((id) => [new RegExp(`^PUR:${id}`), new RegExp(`^SHP:${id}`)]) } }] : []),
    ...(paymentIds.length ? [{ 'source.id': { $in: paymentIds } }] : []),
    ...(movementIds.length ? [{ 'source.id': { $in: movementIds } }] : []),
    { eventKey: /^LOYALTY_/, 'lines.partnerId': user._id },
  ] };
  // Reversals of these entries (reversalOf) go with them
  const entries = await JournalEntry.collection.find(entryFilter).project({ _id: 1 }).toArray();
  const entryIds = entries.map((e) => e._id);
  const reversals = entryIds.length ? await JournalEntry.collection.find({ reversalOf: { $in: entryIds } }).project({ _id: 1 }).toArray() : [];
  const allEntryIds = [...entryIds, ...reversals.map((e) => e._id)];
  const out = {
    entries: (await JournalEntry.collection.deleteMany({ _id: { $in: allEntryIds } })).deletedCount,
    movements: (await LoyaltyPoint.collection.deleteMany({ user: user._id })).deletedCount,
    payments: (await OrderPaymentHistory.collection.deleteMany({ _id: { $in: paymentIds } })).deletedCount,
    orders: (await Order.collection.deleteMany({ _id: { $in: orderIds }, demoSeed: TAG })).deletedCount,
  };
  console.log(`clean: removed ${out.orders} orders, ${out.payments} payments, ${out.movements} loyalty movements, ${out.entries} journal entries`);
  return out;
}

// ---- builders (the shape controllers/orders.js createOrder saves) ----
let admin;
async function newOrderNumber() {
  for (;;) {
    const number = orderid.generate().slice(7, 17);
    if (!(await Order.collection.findOne({ orderId: number }))) return number;
  }
}

// kind 'shipment' with packages [{ kg, price, arrivedLibya, domesticFeeUsd }], or 'purchase' with invoice $
async function makeOrder(user, { name, kind, invoice = 0, isRemittance = false, packages = [], orderStatus, createdAt }) {
  const orderNumber = await newOrderNumber();
  const isShipment = kind === 'shipment';
  const paymentList = packages.map((p, i) => ({
    _id: new mongoose.Types.ObjectId(),
    status: { arrived: true, arrivedLibya: !!p.arrivedLibya, paid: false, received: false },
    deliveredPackages: {
      trackingNumber: `DEMO${orderNumber.replace('-', '')}${i + 1}`,
      weight: { total: p.kg, measureUnit: 'KG' },
      exiosPrice: p.price,
      originPrice: p.price - 2,
      shipmentMethod: 'air',
      ...(p.domesticFeeUsd && { domesticFee: { amount: p.domesticFeeUsd, currency: 'USD', usd: p.domesticFeeUsd } }),
    },
    note: 'بيانات تجريبية',
  }));
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  const _id = await tx(async (session) => {
    const [order] = await Order.create([{
      user: user._id, madeBy: admin._id, orderId: orderNumber, productName: `${PREFIX}${name}`, quantity: '1',
      customerInfo: { fullName, phone: user.phone, email: user.username },
      placedAt: 'tripoli', isShipment, isPayment: !isShipment, isRemittance,
      totalInvoice: isShipment ? 0 : invoice,
      items: isShipment ? [] : [{ description: name, unitPrice: invoice, quantity: 1 }],
      orderStatus: orderStatus ?? (isShipment ? 2 : 1),
      shipment: { method: 'air', fromWhere: 'الصين', toWhere: 'طرابلس', packageCount: packages.length,
        weight: packages.reduce((s, p) => s + p.kg, 0), exiosShipmentPrice: packages[0]?.price },
      activity: [{ country: 'مكتب طرابلس', description: 'في مرحلة تجهيز الطلبية' }],
      paymentList,
    }], { session });
    await Order.collection.updateOne({ _id: order._id }, { $set: { demoSeed: TAG, ...(createdAt && { createdAt, orderStatusChangedAt: createdAt }) } }, { session });
    await syncOrder(order._id, { session, user: admin });
    return order._id;
  });
  return { _id, orderId: orderNumber, user: user._id, packages: paymentList.map((p) => p._id), name };
}

// A cash USD payment recorded as the admin does on the order's Payments tab (Tripoli box)
async function payCash(order, usd, { category, packageIds = [] }) {
  await tx(async (session) => {
    await Order.updateOne({ _id: order._id }, { $inc: { accountingMutationVersion: 1 } }, { session });
    const [payment] = await OrderPaymentHistory.create([{
      createdBy: admin._id, customer: order.user, order: order._id, paymentType: 'cash', receivedAmount: usd, rate: 0,
      currency: 'USD', category, createdAt: new Date(), note: 'دفعة تجريبية (نقاط الولاء)',
      ...(category === 'receivedGoods' && { list: packageIds.map((id) => ({ _id: id, id: String(id) })) }),
    }], { session });
    await OrderPaymentHistory.collection.updateOne({ _id: payment._id }, { $set: { demoSeed: TAG } }, { session });
    const result = await postCashPayment(payment._id, { session, user: admin, office: 'tripoli' });
    if (!result?.posted) throw new Error(`Cash payment not posted: ${JSON.stringify(result)}`);
  });
}

async function deliver(order, indexes = order.packages.map((_, i) => i), { finish = true } = {}) {
  await tx(async (session) => {
    for (const i of indexes) {
      await Order.updateOne({ _id: order._id, 'paymentList._id': order.packages[i] }, { $set: {
        'paymentList.$.status.received': true, 'paymentList.$.status.arrivedLibya': true,
        'paymentList.$.deliveredPackages.deliveredInfo.deliveredDate': new Date(),
      } }, { session });
    }
    if (finish) await Order.updateOne({ _id: order._id }, { $set: { orderStatus: 4, isFinished: true } }, { session });
    await syncOrder(order._id, { session, user: admin });
  });
}

async function cancel(order, reason) {
  await tx(async (session) => {
    await Order.updateOne({ _id: order._id }, { $set: { isCanceled: true, cancelation: { date: new Date(), reason } } }, { session });
    await syncOrder(order._id, { session, user: admin });
  });
}

const req = () => ({ user: { _id: admin._id, roles: admin.roles } });
const redeem = (order, points, target) => tx((session) => loyalty.redeem({ userId: order.user, target, points }, { session, req: req() }));
const adjust = (user, points, reason) => tx((session) => loyalty.adjust({ userId: user._id, points, reason }, { session, req: req() }));
const usdOf = (cents) => `$${(cents / 100).toFixed(2)}`;

// Refuse awardDue if it would award a claim that is not ours
async function assertAwardOnlyOurs(user) {
  const ledger = await loyalty.claimLedger({ $in: [/^PUR:/, /^SHP:/] });
  const earned = new Set(await LoyaltyPoint.distinct('arKey', { kind: 'earn' }));
  const ids = [...new Set([...ledger].filter(([k, r]) => r.billed > 0 && r.open <= 0 && !earned.has(k)).map(([k]) => k.split(':')[1]))]
    .filter((id) => mongoose.isValidObjectId(id));
  const others = await Order.collection.countDocuments({ _id: { $in: ids.map(oid) }, createdAt: { $gte: loyalty.loyaltyStartDate() }, demoSeed: { $ne: TAG } });
  if (others) throw new Error(`awardDue would award ${others} order(s) that are not demo orders; refusing`);
  const stray = await LoyaltyPoint.countDocuments({ user: { $ne: user._id } });
  if (stray) notes.push(`note: ${stray} loyalty movements of other customers exist (untouched; expireDue/settleOrders are global jobs)`);
}

async function seed(user) {
  const S = {};
  // A. shipment, 2 packages delivered and fully paid: $30 + $30
  S.A = await makeOrder(user, { name: 'شحن جوي مستلم ومدفوع', kind: 'shipment', packages: [{ kg: 3, price: 10, arrivedLibya: true }, { kg: 3, price: 10, arrivedLibya: true }], orderStatus: 3 });
  await payCash(S.A, 60, { category: 'receivedGoods', packageIds: S.A.packages });
  await deliver(S.A);
  // B. purchase invoice $400 fully paid
  S.B = await makeOrder(user, { name: 'فاتورة شراء مدفوعة', kind: 'purchase', invoice: 400 });
  await payCash(S.B, 400, { category: 'invoice' });
  // C. Alipay transfer $200 fully paid
  S.C = await makeOrder(user, { name: 'حوالة علي باي', kind: 'purchase', invoice: 200, isRemittance: true });
  await payCash(S.C, 200, { category: 'invoice' });
  // D. arrived in Libya, ready for pickup, unpaid: $100
  S.D = await makeOrder(user, { name: 'شحنة جاهزة للاستلام غير مدفوعة', kind: 'shipment', packages: [{ kg: 10, price: 10, arrivedLibya: true }], orderStatus: 3 });
  // E. paid, not delivered: $40
  S.E = await makeOrder(user, { name: 'شحنة مدفوعة لم تُستلم', kind: 'shipment', packages: [{ kg: 4, price: 10, arrivedLibya: true }], orderStatus: 3 });
  await payCash(S.E, 40, { category: 'receivedGoods', packageIds: S.E.packages });
  // G. purchase $100 paid (earns, then cancelled)
  S.G = await makeOrder(user, { name: 'طلبية ملغاة بعد كسب النقاط', kind: 'purchase', invoice: 100 });
  await payCash(S.G, 100, { category: 'invoice' });
  // H. purchase $200 unpaid (part paid with points, then cancelled)
  S.H = await makeOrder(user, { name: 'طلبية ملغاة بعد الدفع بالنقاط', kind: 'purchase', invoice: 200 });
  // I. purchase $150 paid (compensation invoice, no points)
  S.I = await makeOrder(user, { name: 'فاتورة تعويض بدون نقاط', kind: 'purchase', invoice: 150 });
  await payCash(S.I, 150, { category: 'invoice' });
  // J. arrived, $200, 15% paid with points
  S.J = await makeOrder(user, { name: 'شحنة دُفع جزء منها بالنقاط', kind: 'shipment', packages: [{ kg: 20, price: 10, arrivedLibya: true }], orderStatus: 3 });
  // M. delivered, unpaid, $20 shipping + $15 domestic transport fee
  S.M = await makeOrder(user, { name: 'شحنة بها رسوم نقل داخلي', kind: 'shipment', packages: [{ kg: 2, price: 10, arrivedLibya: true, domesticFeeUsd: 15 }], orderStatus: 3 });
  await deliver(S.M);
  // N. before launch (createdAt 2026-10-20), paid and delivered: $40
  S.N = await makeOrder(user, { name: 'طلبية قبل تاريخ الإطلاق', kind: 'shipment', packages: [{ kg: 4, price: 10, arrivedLibya: true }], orderStatus: 3, createdAt: new Date('2026-10-20T10:00:00Z') });
  await payCash(S.N, 40, { category: 'receivedGoods', packageIds: S.N.packages });
  await deliver(S.N);

  await assertAwardOnlyOurs(user);
  const award1 = await loyalty.awardDue();
  console.log('awardDue', award1);

  // G: cancelled after earning; settled before any spending so its lot is still whole
  await cancel(S.G, 'إلغاء تجريبي بعد كسب النقاط');
  const settle1 = await loyalty.settleOrders();
  console.log('settleOrders (G)', settle1);
  // I: marked no points (takes back what it earned at once)
  await tx((session) => loyalty.setNoPoints(S.I._id, { enabled: true, reason: 'فاتورة تعويض عن طرد تالف' }, { session, req: req() }));

  // K: staff adjustments, plus a demo top-up so redemption can be tried
  await adjust(user, 500, 'مكافأة عميل مميز');
  await adjust(user, -100, 'تصحيح خطأ إدخال');
  await adjust(user, 5000, 'رصيد تجريبي لاختبار الدفع بالنقاط');

  // H: 1000 points ($10) paid on the $200 invoice, then the order is cancelled
  await redeem(S.H, 1000, { orderId: S.H._id, category: 'invoice' });
  // J: 15% of $200 = 3000 points
  S.J.redeem = await redeem(S.J, 3000, { orderId: S.J._id, category: 'receivedGoods', packageIds: S.J.packages });
  await cancel(S.H, 'إلغاء تجريبي بعد الدفع بالنقاط');
  const settle2 = await loyalty.settleOrders();
  console.log('settleOrders (H)', settle2);

  // L: two add lots whose expiry is moved directly (demo shortcut)
  await adjust(user, 200, 'نقاط تنتهي قريباً (تجربة)');
  await adjust(user, 150, 'نقاط منتهية (تجربة)');
  const soonLot = await LoyaltyPoint.findOne({ user: user._id, kind: 'add', reason: 'نقاط تنتهي قريباً (تجربة)' }).lean();
  const pastLot = await LoyaltyPoint.findOne({ user: user._id, kind: 'add', reason: 'نقاط منتهية (تجربة)' }).lean();
  await LoyaltyPoint.updateOne({ _id: soonLot._id }, { $set: { expiresAt: new Date(Date.now() + 10 * DAY) } });
  await LoyaltyPoint.updateOne({ _id: pastLot._id }, { $set: { expiresAt: new Date(Date.now() - DAY), earnedAt: new Date(Date.now() - 366 * DAY) } });
  const expired = await loyalty.expireDue();
  console.log('expireDue', expired);
  const settle3 = await loyalty.settleOrders();

  // F: delivered and paid after the last awardDue: stays "processing" until the hourly run
  S.F = await makeOrder(user, { name: 'شحنة قيد الإضافة', kind: 'shipment', packages: [{ kg: 5, price: 10, arrivedLibya: true }], orderStatus: 3 });
  await payCash(S.F, 50, { category: 'receivedGoods', packageIds: S.F.packages });
  await deliver(S.F);

  return { S, runs: { award1, settle1, settle2, settle3, expired } };
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function report(user, { S, runs }) {
  const ol = async (o) => loyalty.orderLoyalty(o._id);
  const q = async (o, target) => loyalty.redeemQuote({ userId: user._id, target });
  const L = {};
  for (const k of Object.keys(S)) L[k] = await ol(S[k]);
  const quoteD = await q(S.D, { orderId: S.D._id, category: 'receivedGoods', packageIds: S.D.packages });
  const quoteJ = await q(S.J, { orderId: S.J._id, category: 'receivedGoods', packageIds: S.J.packages });
  const quoteM = await q(S.M, { orderId: S.M._id, category: 'receivedGoods', packageIds: S.M.packages });
  const summary = await loyalty.summaryOf(user._id);
  const pendingOf = (o) => summary.pending.filter((p) => String(p.orderId) === String(o._id)).map((p) => `${p.points} (${p.waitingFor})`).join(', ') || '-';
  const fmtQuote = (x) => `balance ${x.balance}, max ${x.maxPoints} pts, owed ${usdOf(x.owedCents)}, billed ${usdOf(x.billedCents)}, used ${x.usedOnTarget}`;

  const rows = [
    ['A', S.A, 'شحنتان مستلمتان ومدفوعتان ($60). التطبيق: +30 نقطة مكتسبة. الإدارة: مدفوعة بالكامل، النقاط 30.', `earned ${L.A.earned}`],
    ['B', S.B, 'فاتورة شراء $400 مدفوعة. التطبيق/الإدارة: +200 نقطة.', `earned ${L.B.earned}`],
    ['C', S.C, 'حوالة علي باي $200 مدفوعة: 5 نقاط لكل $20 → 50 نقطة.', `earned ${L.C.earned}`],
    ['D', S.D, `جاهزة للاستلام $100 غير مدفوعة. التطبيق: نقاط قادمة (بانتظار الدفع). الإدارة: الدفع بالنقاط متاح، الحد 20%. Quote: ${fmtQuote(quoteD)}`, `pending ${pendingOf(S.D)}`],
    ['E', S.E, 'مدفوعة $40 ولم تُستلم. التطبيق: نقاط قادمة (بانتظار الاستلام).', `pending ${pendingOf(S.E)}`],
    ['F', S.F, 'مستلمة ومدفوعة $50 بعد آخر احتساب. التطبيق: نقاط قادمة (قيد الإضافة) حتى التشغيل الساعي القادم.', `pending ${pendingOf(S.F)}`],
    ['G', S.G, 'شراء $100 كسبت 50 ثم أُلغيت. السجل: مكتسبة 50 ثم سحب 50. (المبلغ المدفوع لم يُرجع للمحفظة: اختصار تجريبي)', `earned ${L.G.earned} (revoked)`],
    ['H', S.H, 'شراء $200 دُفع منها 1000 نقطة ($10) ثم أُلغيت. السجل: استخدام 1000 ثم إرجاع 1000.', `redeemed ${L.H.redeemed} (restored)`],
    ['I', S.I, 'فاتورة $150 مدفوعة، مستثناة من النقاط بسبب "فاتورة تعويض عن طرد تالف". كسبت 75 ثم سُحبت.', `earned ${L.I.earned}, noPoints ${!!L.I.noPoints}`],
    ['J', S.J, `شحنة $200 دُفع 15% منها بالنقاط (3000 = $30)، الباقي $170 مستحق. Quote now: ${fmtQuote(quoteJ)}`, `redeemed ${L.J.redeemed}, pending ${pendingOf(S.J)}`],
    ['K', null, 'تعديلات الموظف: +500 "مكافأة عميل مميز"، −100 "تصحيح خطأ إدخال" (+5000 "رصيد تجريبي لاختبار الدفع بالنقاط" لتجربة الدفع).', '+500, −100, +5000'],
    ['L', null, 'إضافة 200 تنتهي بعد ~10 أيام (تنتهي قريباً) + إضافة 150 بتاريخ انتهاء سابق ثم expireDue → حركة "منتهية" 150. (تاريخ الانتهاء عُدّل مباشرة: اختصار تجريبي)', `expireDue ${JSON.stringify(runs.expired)}`],
    ['M', S.M, `مستلمة غير مدفوعة: شحن $20 + نقل داخلي $15. الدفع بالنقاط يغطي الشحن فقط (20%=400). Quote: ${fmtQuote(quoteM)}`, `pending ${pendingOf(S.M)}`],
    ['N', S.N, 'أُنشئت 2026-10-20 (قبل الإطلاق 2026-11-01)، مدفوعة ومستلمة $40: لا نقاط ولا نقاط قادمة.', `earned ${L.N.earned}, pending ${L.N.pending}`],
  ];
  const lines = [];
  lines.push(`Loyalty demo for ${CUSTOMER_ID} (${user.firstName} ${user.lastName}), db ${mongoose.connection.db.databaseName}, ${new Date().toISOString()}`);
  lines.push(`LOYALTY_START_DATE=${process.env.LOYALTY_START_DATE}`);
  lines.push('');
  lines.push(`${pad('Sc', 3)}| ${pad('orderId', 10)}| ${pad('points', 34)}| what to see`);
  lines.push('-'.repeat(120));
  for (const [letter, order, what, pts] of rows) lines.push(`${pad(letter, 3)}| ${pad(order ? order.orderId : '-', 10)}| ${pad(pts, 34)}| ${what}`);
  lines.push('');
  lines.push(`Jobs: awardDue ${JSON.stringify(runs.award1)}; settleOrders after G ${JSON.stringify(runs.settle1)}, after H ${JSON.stringify(runs.settle2)}`);
  lines.push('');
  lines.push('summaryOf(F762):');
  lines.push(`  balance ${summary.points} points = $${summary.usd.toFixed(2)}`);
  lines.push(`  expiringSoon ${summary.expiringSoon ? `${summary.expiringSoon.points} on ${summary.expiringSoon.at.toISOString().slice(0, 10)}` : 'none'}`);
  lines.push(`  earnedTotal ${summary.earnedTotal}, redeemedTotal ${summary.redeemedTotal}`);
  lines.push('  pending:');
  for (const p of summary.pending) lines.push(`    ${p.orderNumber}  ${p.arKey}  ${p.points} pts  ${p.waitingFor}`);
  const pointsAcc = await resolveAccount('loyalty_points');
  const expenseAcc = await resolveAccount('loyalty_expense');
  const liab = (await getBalance(pointsAcc._id)).usd;
  const liabMine = (await getBalance(pointsAcc._id, { partnerId: user._id })).usd;
  const exp = (await getBalance(expenseAcc._id)).usd;
  lines.push('');
  lines.push(`Ledger: ${pointsAcc.code} loyalty_points ${usdOf(liab)} (F762: ${usdOf(liabMine)}; negative = owed to customers); ${expenseAcc.code} loyalty_expense ${usdOf(exp)}`);
  lines.push(`Check: liability for F762 = -balance? ${-liabMine === summary.points ? 'yes' : `NO (${-liabMine} vs ${summary.points})`}`);
  lines.push('');
  lines.push('Demo shortcuts (not the screens): delivery = status.received + syncOrder; cancel = isCanceled + syncOrder without returning payments to the wallet;');
  lines.push('cash payments posted with postCashPayment directly (no AccountingEvent queued); L lots\' expiresAt edited directly; +5000 top-up added for redemption.');
  lines.push('If the local API server runs its hourly loyalty job, F leaves "processing" and earns 25.');
  lines.push(`Clean: node scripts/seedLoyaltyDemo.js --clean`);
  notes.forEach((n) => lines.push(n));
  const text = lines.join('\n');
  console.log(`\n${text}`);
  fs.writeFileSync(OUT_FILE, `${text}\n`, 'utf8');
  console.log(`\nwritten ${OUT_FILE}`);
}

async function main() {
  await mongoose.connect(uri);
  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== ALLOWED_DB) throw new Error(`Connected to ${dbName}; refusing`);
  const user = await customer();
  const lockVersion = user.walletPostingVersion;
  try {
    await clean(user);
    if (process.argv.includes('--clean')) return;
    await ensureLoyaltySetup();
    const { settings } = await getConfig();
    if (!settings?.liveEnabled) throw new Error('Accounting live posting is off in this DB; redeem needs it');
    if (!loyalty.loyaltyStartDate()) throw new Error('LOYALTY_START_DATE is not set');
    admin = await mongoose.connection.collection('users').findOne({ username: 'emadkhatrush', 'roles.isAdmin': true }, { projection: { roles: 1, firstName: 1 } })
      || await mongoose.connection.collection('users').findOne({ 'roles.isAdmin': true }, { projection: { roles: 1, firstName: 1 } });
    if (!admin) throw new Error('No admin user to record payments');
    const result = await seed(user);
    await report(user, result);
  } finally {
    // The services lock the customer by bumping walletPostingVersion; put it back as found
    await mongoose.connection.collection('users').updateOne({ _id: user._id },
      lockVersion === undefined ? { $unset: { walletPostingVersion: '' } } : { $set: { walletPostingVersion: lockVersion } });
  }
}

main().then(() => mongoose.disconnect()).catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
