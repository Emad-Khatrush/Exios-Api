// Delivering many packages at once in batches (owner's request 2026-11-05). One request for 36
// packages ran ~1,700 database round trips and passed Heroku's 30-second limit (H12), and one
// transaction that long would also pass Atlas's 60-second transaction limit.
//
// start: checks the whole delivery once (packages, payment, wallets) and records a job with each
//        package's share of the payment, spread exactly as one single delivery would spread it.
// next:  delivers the next batch in ONE transaction: claim, accounting, wallet payments, fees,
//        statuses, its lines on the delivery's one invoice, and the job's progress. A batch is
//        all or nothing, so a cut connection never leaves half a batch, and a batch is never paid
//        twice (the job only moves forward inside the same transaction).
// stop:  ends a job; the packages not delivered yet are left as they are, nothing is charged.
const mongoose = require('mongoose');
const ErrorHandler = require('./errorHandler');
const Invoices = require('../models/invoice');
const Orders = require('../models/order');
const {
  validatePackages, validatePayment, loadDeliverablePackages, getUserWalletMap, withCalculatedRate,
  checkSufficientFunds, allocatePayment, claimPackagesForDelivery, payAllocations, payFeesLYD,
  updateOrderStatuses, createInvoice, invoiceItem, cleanUpInventory,
} = require('./helperApi');

// A batch of 8 is ~370 round trips: a few seconds even when the database is far away
const BATCH_SIZE = 8;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const DeliveryJob = mongoose.models.DeliveryJob || mongoose.model('DeliveryJob', new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['running', 'done', 'stopped'], default: 'running', index: true },
  feeMode: { type: String, enum: ['usd', 'separate'], default: 'separate' },
  payment: { amountUSD: Number, amountLYD: Number, rate: Number },
  totalCost: Number,
  batches: Number,
  nextBatch: { type: Number, default: 0 },
  packages: [{ _id: false, id: String, orderId: String, trackingNumber: String, cost: Number, usd: Number, lyd: Number, batch: Number, done: { type: Boolean, default: false } }],
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  invoiced: { total: { type: Number, default: 0 }, amountUSD: { type: Number, default: 0 }, amountLYD: { type: Number, default: 0 } },
  stoppedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  stoppedAt: Date,
  version: { type: Number, default: 0 },
}, { timestamps: true, collection: 'deliveryjobs' }));

const summary = (job) => {
  const delivered = job.packages.filter((p) => p.done);
  return {
    _id: job._id, status: job.status, invoiceId: job.invoiceId || null,
    total: job.packages.length, done: delivered.length, batches: job.batches, nextBatch: job.nextBatch,
    remaining: job.packages.filter((p) => !p.done).map(({ id, orderId, trackingNumber, cost }) => ({ id, orderId, trackingNumber, cost })),
    payment: job.payment, totalCost: job.totalCost, createdAt: job.createdAt,
  };
};

async function start(req, customerId, body) {
  if (body.allowPartial === true) throw new ErrorHandler(400, 'Credit delivery is not delivered in batches');
  validatePackages(body.selectedPackages);
  const paymentAmounts = validatePayment(body.payment, { allowZero: true });
  const feeMode = body.feeMode === 'usd' ? 'usd' : 'separate';
  if (await DeliveryJob.exists({ customer: customerId, status: 'running' })) {
    throw new ErrorHandler(409, 'هناك تسليم غير مكتمل لهذا العميل. أكمله أو أوقفه أولاً.');
  }

  // The whole delivery is checked once, as a single delivery would be
  const { packages, totalCost, totalFeeLYD } = await loadDeliverablePackages(customerId, body.selectedPackages, { feeMode });
  if (!paymentAmounts.amountUSD && !paymentAmounts.amountLYD && totalCost > 0) {
    throw new ErrorHandler(400, 'Payment amount cannot be zero');
  }
  const payment = withCalculatedRate(paymentAmounts, totalCost);
  checkSufficientFunds(await getUserWalletMap(customerId), payment, totalCost, totalFeeLYD);
  const allocations = allocatePayment(packages, payment);

  const job = await DeliveryJob.create({
    customer: customerId, createdBy: req.user?._id, feeMode, totalCost,
    payment: { amountUSD: payment.amountUSD, amountLYD: payment.amountLYD, rate: payment.rate || 0 },
    batches: Math.ceil(packages.length / BATCH_SIZE),
    packages: packages.map((pkg, i) => ({
      id: pkg.id, orderId: pkg.orderId, trackingNumber: pkg.trackingNumber, cost: pkg.cost,
      usd: allocations[i].usd, lyd: allocations[i].lyd, batch: Math.floor(i / BATCH_SIZE),
    })),
  });
  return summary(job);
}

async function next(req, jobId) {
  if (!mongoose.isValidObjectId(jobId)) throw new ErrorHandler(404, 'Delivery not found');
  const job = await require('../accounting/services/transaction').runInTransaction(async (session) => {
    // Claim the job: two calls at once contend here and the second sees the progress of the first
    const job = await DeliveryJob.findOneAndUpdate({ _id: jobId }, { $inc: { version: 1 } }, { new: true, session });
    if (!job) throw new ErrorHandler(404, 'Delivery not found');
    if (job.status !== 'running') return job;
    const batch = job.nextBatch;
    const chunk = job.packages.filter((p) => p.batch === batch);
    const customerId = job.customer;

    const { packages, feesLYD } = await loadDeliverablePackages(customerId, chunk.map(({ id, orderId, trackingNumber }) => ({ id, orderId, trackingNumber })), { feeMode: job.feeMode, session });
    // The payment was spread on the costs seen at the start; a cost changed since is refused
    packages.forEach((pkg, i) => {
      if (Math.abs(Number(pkg.cost) - Number(chunk[i].cost)) > 0.005) {
        throw new ErrorHandler(409, `تغيّرت تكلفة الطرد ${pkg.trackingNumber || pkg.id} بعد بدء التسليم (${chunk[i].cost} ← ${pkg.cost}). أوقف التسليم ثم سلّم الباقي من جديد.`);
      }
    });

    await claimPackagesForDelivery(customerId, packages, session);
    const settings = await require('../accounting/services/periodLock').lockPeriod(session);
    if (settings?.liveEnabled) {
      const affected = await Orders.find({ orderId: { $in: packages.map((pkg) => pkg.orderId) } }).select('_id').session(session);
      for (const order of affected) await require('../accounting/services/claims/sync').syncOrder(order._id, { session, user: req.user, date: new Date() });
    }
    const rate = Number(job.payment.rate || 0);
    await payAllocations(req, null, null, customerId, packages, chunk.map(({ usd, lyd }) => ({ usd, lyd })), rate, session);
    await payFeesLYD(req, null, null, customerId, feesLYD, session);
    await updateOrderStatuses(packages, session);

    // The delivery's one invoice: made by the first batch, each next batch adds its lines
    const batchUSD = round2(chunk.reduce((s, p) => s + p.usd, 0));
    const batchLYD = round2(chunk.reduce((s, p) => s + p.lyd, 0) + feesLYD.reduce((s, f) => s + f.amount, 0));
    const batchCost = round2(packages.reduce((s, p) => s + p.cost, 0));
    const invoiced = {
      total: round2(job.invoiced.total + batchCost),
      amountUSD: round2(job.invoiced.amountUSD + batchUSD),
      amountLYD: round2(job.invoiced.amountLYD + batchLYD),
    };
    let { invoiceId } = job;
    if (!invoiceId) {
      invoiceId = (await createInvoice(req.user, customerId, packages, { amountUSD: invoiced.amountUSD, amountLYD: invoiced.amountLYD, rate }, invoiced.total, session))._id;
    } else {
      await Invoices.updateOne({ _id: invoiceId }, { $push: { list: { $each: packages.map(invoiceItem) } }, $set: invoiced }, { session });
    }

    await cleanUpInventory(packages, session);
    await require('../accounting/services/events').emitOrdersByNumber(packages.map((pkg) => pkg.orderId), req.user, { session });

    const finished = batch + 1 >= job.batches;
    const ids = new Set(chunk.map((p) => p.id));
    return DeliveryJob.findOneAndUpdate({ _id: job._id, nextBatch: batch }, {
      $set: {
        nextBatch: batch + 1, invoiceId, invoiced, ...(finished && { status: 'done' }),
        packages: job.packages.map((p) => ({ ...p.toObject(), done: p.done || ids.has(p.id) })),
      },
    }, { new: true, session });
  });
  return summary(job);
}

async function stop(req, jobId) {
  if (!mongoose.isValidObjectId(jobId)) throw new ErrorHandler(404, 'Delivery not found');
  const job = await DeliveryJob.findOneAndUpdate({ _id: jobId, status: 'running' }, { $set: { status: 'stopped', stoppedBy: req.user?._id, stoppedAt: new Date() }, $inc: { version: 1 } }, { new: true });
  if (!job) throw new ErrorHandler(409, 'This delivery is not running');
  return summary(job);
}

// The customer's delivery left unfinished (a closed page or a cut connection), to resume it
async function open(customerId) {
  const job = await DeliveryJob.findOne({ customer: customerId, status: 'running' }).sort({ createdAt: -1 });
  return job ? summary(job) : null;
}

module.exports = { start, next, stop, open, DeliveryJob, BATCH_SIZE };
