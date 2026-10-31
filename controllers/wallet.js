const { errorMessages } = require("../constants/errorTypes");
const Order = require("../models/order");
const OrderPaymentHistory = require("../models/orderPaymentHistory");
const UserStatement = require("../models/userStatement");
const DeletedStatement = require("../models/deletedStatement");
const Wallet = require("../models/wallet");
const Inventory = require('../models/inventory');
const ErrorHandler = require('../utils/errorHandler');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types; // Import new ObjectId from mongoose
const { uploadToGoogleCloud } = require('../utils/googleClould');
const { emitAccountingEvent } = require('../accounting/services/events');
const { lydRateLimits } = require('../accounting/services/walletRate');
const { assertOpenPeriod } = require('../accounting/services/periodGuard');
const { moneyAccount, resolveDepositAccount, assertDepositPlace } = require('../accounting/services/moneyAccounts');
const { payOrderDebts, restoreOrderDebts } = require('../utils/debts');
const { deliveryInvoiceOf, refundWalletPayment } = require('../utils/helperApi');
const { runInTransaction } = require('../accounting/services/transaction');
const User = require('../models/user');

module.exports.getUserWallet = async (req, res, next) => {
  try {
    const { id } = req.params;

    const wallet = await Wallet.find({ user: new ObjectId(id) }).populate('user');
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: wallet
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

// The export sends plain dates picked in Libya (UTC+2, no DST) but the server runs in UTC,
// so without the offset the window was shifted 2 hours and dropped early-morning records.
const LIBYA_UTC_OFFSET = '+02:00';

const toLibyaDayBoundary = (value, endOfDay) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${LIBYA_UTC_OFFSET}`);
  }
  const date = new Date(value);
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
};

const SHIPPING_PAYMENT_PREFIX = /تم دفع قيمة الشحن\s+(.+)/;
// Invoice-cancellation shipping refunds (helperApi.js cancelInvoicePackages) are written as
// `... واسترجاع قيمة شحن ${trackingNumber} إلى المحفظة` with the orderId as the last word of
// `note` ("Invoice #0123 cancellation 9692-0957"), not the whole note like shipping payments.
const CANCELLATION_REFUND_TRACKING = /واسترجاع قيمة شحن\s+(.+?)\s+إلى المحفظة/;
const CANCELLATION_REFUND_ORDER_ID = /cancellation\s+(\S+)\s*$/;
const normalizeTracking = (value) => String(value ?? '').trim().toLowerCase();

// Shipping payments are written as `تم دفع قيمة الشحن ${trackingNumber}` with the orderId in
// `note`. Inventory.orders is a snapshot taken when the package joined the flight, so its
// tracking number can be stale or blank; resolve the package live from Orders instead, then
// join the flight by paymentList._id, which never changes.
const attachOdooCodes = async (statements) => {
  const parsed = statements
    .map(statement => {
      const shippingTracking = statement.description?.match(SHIPPING_PAYMENT_PREFIX)?.[1]?.trim();
      if (shippingTracking) {
        return { statement, tracking: shippingTracking, orderId: String(statement.note || '').trim() };
      }

      const cancellationTracking = statement.description?.match(CANCELLATION_REFUND_TRACKING)?.[1]?.trim();
      if (cancellationTracking) {
        const orderId = statement.note?.match(CANCELLATION_REFUND_ORDER_ID)?.[1]?.trim();
        if (orderId) return { statement, tracking: cancellationTracking, orderId };
      }

      return null;
    })
    .filter(Boolean);
  if (parsed.length === 0) return;

  const orderIds = [...new Set(parsed.map(p => p.orderId).filter(Boolean))];
  const trackings = [...new Set(parsed.map(p => p.tracking))];

  const orders = await Order.find({
    $or: [
      { orderId: { $in: orderIds } },
      { 'paymentList.deliveredPackages.trackingNumber': { $in: trackings } },
    ],
  })
    .select('orderId paymentList._id paymentList.deliveredPackages.trackingNumber')
    .lean();

  const orderById = new Map();
  const packageIdsByTracking = new Map();
  orders.forEach(order => {
    orderById.set(String(order.orderId).trim(), order);
    (order.paymentList || []).forEach(pkg => {
      const key = normalizeTracking(pkg?.deliveredPackages?.trackingNumber);
      if (!key) return;
      if (!packageIdsByTracking.has(key)) packageIdsByTracking.set(key, []);
      packageIdsByTracking.get(key).push(String(pkg._id));
    });
  });

  // For each payment: the package with the same tracking number (inside its own order first),
  // or, if the tracking number was changed after paying, any package of that order.
  const resolved = parsed.map(({ statement, tracking, orderId }) => {
    const key = normalizeTracking(tracking);
    const order = orderById.get(orderId);
    let packageIds = (order?.paymentList || [])
      .filter(pkg => normalizeTracking(pkg?.deliveredPackages?.trackingNumber) === key)
      .map(pkg => String(pkg._id));
    if (packageIds.length === 0) packageIds = packageIdsByTracking.get(key) || [];

    const isFallback = packageIds.length === 0;
    if (isFallback) packageIds = (order?.paymentList || []).map(pkg => String(pkg._id));
    return { statement, packageIds, isFallback };
  });

  const allIds = [...new Set(resolved.flatMap(r => r.packageIds))];
  if (allIds.length === 0) return;

  // Snapshots store paymentList._id as an ObjectId or as a string depending on how they were added
  const inventories = await Inventory.find({
    inventoryType: 'inventoryGoods',
    odoReferenceCode: { $nin: [null, ''] },
    'orders.paymentList._id': { $in: [...allIds, ...allIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id))] },
  })
    .sort({ createdAt: 1 }) // الأقدم أولاً
    .select('odoReferenceCode orders.paymentList._id')
    .lean();

  const odooCodeByPackageId = new Map();
  inventories.forEach(inv => {
    (inv.orders || []).forEach(order => {
      const id = order?.paymentList?._id && String(order.paymentList._id);
      if (id && !odooCodeByPackageId.has(id)) odooCodeByPackageId.set(id, inv.odoReferenceCode);
    });
  });

  resolved.forEach(({ statement, packageIds, isFallback }) => {
    if (statement.odoReferenceCode) return;
    const codes = [...new Set(packageIds.map(id => odooCodeByPackageId.get(id)).filter(Boolean))];
    // A fallback guess is only safe when every package of the order sits on the same flight
    if (codes.length === 1 || (!isFallback && codes.length > 0)) {
      statement.odoReferenceCode = codes[0];
    }
  });
};

module.exports.getLatestStatements = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit === '0' ? 0 : (parseInt(req.query.limit) || 15);
    const skip = (page - 1) * limit;

    // 1. Build dynamic query object based on optional filters
    const query = {};
    if (req.query.office) {
      if (typeof req.query.office !== 'string' || req.query.office.length > 100) return res.status(400).json({ message: 'المكتب غير صالح' });
      query.office = req.query.office === '__unassigned' ? { $in: [null, ''] } : req.query.office;
    }
    
    // Filter by calculationType (+ or -) if provided
    if (req.query.calculationType) {
      query.calculationType = req.query.calculationType === 'plus' ? '+' : req.query.calculationType === 'minus' ? '-' : undefined;
    }

    // Filter by Date Range (createdAt) if provided
    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      
      if (req.query.startDate) {
        query.createdAt.$gte = toLibyaDayBoundary(req.query.startDate, false);
      }

      if (req.query.endDate) {
        query.createdAt.$lte = toLibyaDayBoundary(req.query.endDate, true);
      }
    }

    // 2. Fetch paginated records using the constructed query filter
    const statements = await UserStatement.find(query)
      .sort({ createdAt: -1, _id: -1 }) // Stable newest-first order, including equal timestamps
      .skip(skip)
      .limit(limit)
      .populate('user', 'firstName lastName customerId')
      .populate('createdBy', 'firstName lastName')
      .lean()
      .exec();

    // Resolve the operation's purpose from its linked payments in one batch.
    const paymentStatementIds = statements.filter(s => s.calculationType === '-').map(s => s._id);
    if (paymentStatementIds.length) {
      const payments = await OrderPaymentHistory.find({ statementId: { $in: paymentStatementIds } })
        .select('statementId category').lean();
      const categories = new Map();
      for (const payment of payments) {
        const key = String(payment.statementId);
        if (!categories.has(key)) categories.set(key, new Set());
        categories.get(key).add(payment.category);
      }
      for (const statement of statements) statement.paymentCategories = [...(categories.get(String(statement._id)) || [])];
    }

    // 3. ربط كل عملية دفع شحن بكود أودو الخاص برحلتها
    if (req.query.includeOdoCode === 'true' && statements.length > 0) {
      await attachOdooCodes(statements);
    }

    // 4. Check if there are more records beyond this page
    const totalCount = await UserStatement.countDocuments(query);
    const hasMore = limit === 0 ? false : (skip + statements.length < totalCount);

    // 5. Optional totals for the whole filtered range (not just this page), per direction and currency
    let summary;
    if (req.query.withSummary === 'true') {
      const groups = await UserStatement.aggregate([
        { $match: query },
        { $group: {
            _id: { type: '$calculationType', actionType: '$actionType', paymentType: '$paymentType', currency: '$currency' },
            amount: { $sum: '$amount' },
            count: { $sum: 1 },
        } },
      ]);
      // Same rule as the customer statement: only cash/bank deposits and cash withdrawals
      // are real money. Refunds, compensation and cancellations only credit the wallet.
      const flowOf = ({ type, actionType, paymentType }) => {
        if (actionType === 'exchange') return type === '-' ? 'exchangeOut' : 'exchangeIn';
        if (type === '-') return actionType === 'withdrawal' || paymentType === 'withdrawal' ? 'cashOut' : 'spent';
        return ['refund', 'compensation', 'cancellation', 'wallet'].includes(actionType) ? 'credit' : 'cashIn';
      };
      const empty = () => ({ USD: 0, LYD: 0, count: 0 });
      summary = { count: totalCount, cashIn: empty(), credit: empty(), spent: empty(), cashOut: empty(), exchangeIn: empty(), exchangeOut: empty() };
      groups.forEach(({ _id, amount, count }) => {
        const bucket = summary[flowOf(_id)];
        if (_id.currency === 'USD' || _id.currency === 'LYD') bucket[_id.currency] += amount || 0;
        bucket.count += count;
      });
    }

    // Keep office attribution on the operation, never on the employee's current office.
    // Include offices present in old statements, even if no longer active in settings.
    let officeOptions;
    if (req.query.withSummary === 'true') {
      const [configured, recorded] = await Promise.all([
        require('../utils/offices').officeList(), UserStatement.distinct('office'),
      ]);
      const legacyNames = { tripoli: 'طرابلس', benghazi: 'بنغازي', misurata: 'مصراتة', turkey: 'تركيا', china: 'الصين', bank: 'بنك (تسجيل قديم)', almutahidaTrBank: 'بنك المتحدة (تسجيل قديم)' };
      const officesByCode = new Map(configured.map(o => [o.code, o.name !== o.code ? o.name : legacyNames[o.code] || o.code]));
      for (const code of recorded) if (code && !officesByCode.has(code)) officesByCode.set(code, legacyNames[code] || code);
      officeOptions = [...officesByCode].map(([code, name]) => ({ code, name }));
    }

    // 6. Send response
    res.status(200).json({
      statements,
      hasMore,
      total: totalCount,
      officeOptions,
      summary
    });

  } catch (error) {
    console.error("Error fetching statements:", error);
    res.status(500).json({ error: 'Internal Server Error fetching statements' });
  }
};

module.exports.addBalanceToWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, amount, currency, description, note, actionType, office } = req.body;
    if (actionType === 'exchange') throw new ErrorHandler(400, 'استخدم نافذة الصرافة لتسجيل طرفي التحويل معًا');
    const amountValue = positiveWalletAmount(amount);
    await assertOpenPeriod(req.user, createdAt || new Date());
    // The account the money went into, when chosen (a bank, or a partner's current account such as Wasl)
    let accountId;
    if (req.body.accountId) accountId = (await moneyAccount(req.body.accountId, { currency, what: 'الحساب' }))._id;
    else {
      await assertDepositPlace(office, currency, actionType);
      if (['cash', 'bank', undefined, null, ''].includes(actionType)) {
        accountId = (await resolveDepositAccount({ office, currency }))?._id;
      }
    }


    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-wallets");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    const userStatement = await runInTransaction(async (session) => {
      await assertOpenPeriod(req.user, req.body.createdAt || new Date(), { session });
    // A customer row exists even before the first wallet. Lock it so two first deposits
    // cannot both decide to create a wallet for the same currency.
    const customerLock = await User.updateOne({ _id: id }, { $inc: { walletPostingVersion: 1 } }, { session });
    if (customerLock.matchedCount !== 1) throw new ErrorHandler(404, 'Customer not found');
    const existWallet = await Wallet.findOne({ user: id, currency }).session(session);
    if (existWallet) {
      await Wallet.findOneAndUpdate(
        {
          user: id,
          currency,
        },
        {
          $inc: { balance: amountValue }
        },
        {
          new: true, session,
        }
      );
    } else {
      await Wallet.create([{
        user: id,
        balance: amountValue,
        currency,
        createdAt
      }], { session });
    }
    
    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1).session(session);
    const total = (lastUserStatement[0]?.total || 0) + amountValue;
    const [userStatement] = await UserStatement.create([{
      user: id,
      createdBy: req.user,
      calculationType: '+',
      paymentType: 'wallet',
      createdAt,
      description,
      amount: amountValue,
      currency,
      total,
      note,
      attachments: files,
      office,
      accountId,
      actionType
    }], { session });
    const event = await emitAccountingEvent('statement', userStatement._id, {}, req.user, { session });
    // A deposit into a partner's current account is money held for the company,
    // not cash received in the office. Post it now so an existing statement row
    // can match it immediately; shipping deductions keep their usual workflow.
    if (accountId && ['cash', 'bank'].includes(actionType)) {
      const { settings, accountsById } = await require('../accounting/services/config').getConfig();
      const source = accountsById.get(String(accountId));
      if (source?.cashKind === 'current' && settings.liveEnabled
        && !(await require('../accounting/services/posting/common').isBeforeCashCount(require('../accounting/services/dates').toDay(createdAt || new Date())))) {
        if (!event) throw new ErrorHandler(500, 'تعذر حفظ حدث الإيداع');
        const result = await require('../accounting/services/posting/operations').postStatement(userStatement._id, { session, user: req.user });
        event.status = result?.skipped ? 'skipped' : 'done';
        event.result = result;
        event.processedAt = new Date();
        await event.save({ session });
        await require('../accounting/services/posting/bank').autoMatch(accountId, { session, req });
      }
    }
    return userStatement;
    });

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

module.exports.cancelPayment = async (req, res, next) => {
  const { id } = req.params;
  const paymentId = req.body.payment?._id;

  try {
    const outcome = await runInTransaction(async (session) => {
    const savedPayment = await OrderPaymentHistory.findById(paymentId).session(session).lean();
    if (!savedPayment || String(savedPayment.customer) !== String(id)) throw new ErrorHandler(404, 'Payment not found');
    await assertOpenPeriod(req.user, savedPayment?.createdAt, { session });
    // A delivery payment is given back by cancelling its invoice, once, with the package status
    const orderOfPayment = await Order.findById(savedPayment.order).select('orderId').session(session).lean();
    const invoice = await deliveryInvoiceOf(savedPayment, orderOfPayment?.orderId, session);
    if (invoice) {
      throw new ErrorHandler(400, `هذه دفعة فاتورة التسليم رقم #0${invoice.referenceId}. ألغِ الفاتورة نفسها من صفحة الفواتير، فترجع القيمة للمحفظة مرة واحدة ويعود الطرد غير مستلم.`);
    }
    // Serialize cancellations on this payment and trust only its persisted monetary fields.
    await OrderPaymentHistory.deleteOne({ _id: savedPayment._id }, { session });
    if (savedPayment.paymentType !== 'wallet') {
      await emitAccountingEvent('cashPaymentDeleted', savedPayment._id, {}, req.user, { session });
    } else {
      await refundWalletPayment(req.user, savedPayment,
        `الغاء عملية الدفع كود ${orderOfPayment?.orderId || ''} واسترجاع القيمة الى المحفظة`,
        `${savedPayment.category || ''} Cancellation Refund`, session);
    }
    await restoreOrderDebts(savedPayment.debtPayments, { session });
    return { createdAt: new Date() };
    });
    res.status(200).json(outcome);
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

module.exports.getUserStatement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { currency } = req.query;

    // With the account the money went to (a partner's current account such as Wasl), shown instead of the office
    const userStatement = await UserStatement.find({ user: new ObjectId(id), currency }).sort({ _id: -1 }).populate('user').populate('accountId', 'code name');
    if (!userStatement) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatement
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

module.exports.verifyStatement = async (req, res, next) => {
  try {
    const { statementId, id } = req.params;
    const { receivedDate } = req.body;

    const review = { receivedDate, isAdminConfirmed: true }
    const userStatement = await UserStatement.updateMany({ _id: statementId, user: id }, { $set: { review } });
    if (!userStatement) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatement
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

const roundToTwo = (num) => Math.round(num * 100) / 100;
const positiveWalletAmount = (value) => {
  if (value === undefined || value === null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) {
    throw new ErrorHandler(400, 'Amount must be greater than 0');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new ErrorHandler(400, 'Amount must be greater than 0');
  return amount;
};
const signedAmount = (statement) => (statement.calculationType === '-' ? -1 : 1) * Number(statement.amount || 0);

// Balance before the first inserted statement (usually 0)
const getOpeningBalance = (statementsAsc) => (
  statementsAsc.length ? Number(statementsAsc[0].total || 0) - signedAmount(statementsAsc[0]) : 0
);

// New statements are appended to the last stored total, so keep the stored running totals in insert order
const rebuildStatementTotals = async (statementsAsc, openingBalance, session) => {
  let runningTotal = openingBalance;
  const updates = [];
  statementsAsc.forEach((item) => {
    runningTotal = roundToTwo(runningTotal + signedAmount(item));
    if (item.total !== runningTotal) {
      updates.push({ updateOne: { filter: { _id: item._id }, update: { $set: { total: runningTotal } } } });
    }
  });
  if (updates.length) await UserStatement.bulkWrite(updates, { session });
}

const adjustWalletBalance = async (userId, currency, delta, session, errorMessage) => {
  const filter = { user: userId, currency };
  if (delta < 0) filter.balance = { $gte: -delta };
  const wallet = await Wallet.findOneAndUpdate(filter, { $inc: { balance: delta } }, { new: true, session });
  if (!wallet) throw new ErrorHandler(400, errorMessage || 'Wallet missing or deposit money already spent. Cancel the payments made from it first.');

  const after = roundToTwo(wallet.balance);
  await Wallet.updateOne({ _id: wallet._id, balance: wallet.balance }, { balance: after }, { session });
  return { before: roundToTwo(after - delta), after };
}

// Incoming lines whose journal entry is not a plain deposit, so this screen cannot re-post them:
// a payment given back to the wallet (its entry reverses that exact payment) and a line the
// accounting wrote itself (a refund or netting made from its own document). Changing them here
// would leave the wallet and the books apart.
const PAYMENT_RETURN = /الغاء عملية الدفع كود|واسترجاع قيمة شحن\s+.+?\s+إلى المحفظة/;
const RETURN_ACTIONS = ['cancellation', 'wallet'];
const protectedStatement = (statement) => {
  if (statement.accountingSource?.model) {
    return 'This line was written by Accounting (for example a refund on the order page). Cancel it where it was made.';
  }
  if (RETURN_ACTIONS.includes(statement.actionType) || (!statement.actionType && PAYMENT_RETURN.test(String(statement.description || '')))) {
    return 'This line gives a cancelled payment back to the wallet. Its amount, date, office and type cannot be changed, and it cannot be deleted.';
  }
  return null;
};
// The fields the journal entry is made from: changing only the text does not re-post it
const POSTED_STATEMENT_FIELDS = ['createdAt', 'amount', 'office', 'actionType', 'accountId'];
const isWithdrawal = statement => statement.calculationType === '-' && (statement.actionType === 'withdrawal' || statement.paymentType === 'withdrawal');
function assertWithdrawalRevision(statement, body) {
  if (body.expectedEditCount === undefined) return;
  if (!Number.isSafeInteger(body.expectedEditCount) || body.expectedEditCount < 0) throw new ErrorHandler(400, 'Invalid withdrawal revision. Reload the customer statement.');
  if (body.expectedEditCount !== (statement.editHistory || []).length) throw new ErrorHandler(409, 'This cash withdrawal has changed since you opened it. Reload the customer statement before editing or deleting it.');
}
async function assertEditableWithdrawal(statement, req, session) {
  if (!req.user.roles?.isAdmin) throw new ErrorHandler(403, 'تعديل وحذف السحب النقدي متاح للأدمن فقط');
  assertWithdrawalRevision(statement, req.body || {});
  const locked = protectedStatement(statement);
  if (locked) throw new ErrorHandler(400, locked);
  if (await OrderPaymentHistory.exists({ statementId: statement._id }).session(session)) throw new ErrorHandler(400, 'السحب مرتبط بدفعة طلبية؛ صحح الدفعة من مصدرها أولًا');
  await require('../accounting/services/periodLock').lockPeriod(session);
}
async function finishWithdrawalEvents(statementId, event, result, session, req) {
  const { AccountingEvent, JournalEntry } = require('../accounting/models');
  const reversed = await JournalEntry.find({ 'source.model': 'UserStatement', 'source.id': statementId, status: 'reversed', reversalOf: null }).select('_id').session(session).lean();
  await require('../accounting/services/posting/bankMatchLifecycle').releaseReversedMatches(reversed.map(entry => entry._id), { session, req, canceledModel: 'UserStatement', canceledId: statementId, reason: 'تصحيح أو حذف سحب نقدي' });
  await AccountingEvent.updateMany({ refId: statementId, type: { $in: ['statement', 'statementUpdated', 'statementDeleted'] }, status: { $in: ['pending', 'failed'] }, ...(event && { _id: { $ne: event._id } }) },
    { $set: { status: 'skipped', processedAt: new Date(), result: { reason: 'Superseded by synchronous admin withdrawal correction' } }, $unset: { lastError: 1 } }, { session });
  if (event) { event.status = 'done'; event.result = result; event.processedAt = new Date(); event.lastError = undefined; await event.save({ session }); }
}
async function updateWithdrawal(statement, body, req, session) {
  await assertEditableWithdrawal(statement, req, session);
  if (body.actionType !== undefined && body.actionType !== 'withdrawal') throw new ErrorHandler(400, 'لا يمكن تحويل السحب النقدي إلى نوع آخر');
  if (body.currency !== undefined && body.currency !== statement.currency) throw new ErrorHandler(400, 'عملة السحب لا تتغير؛ احذف العملية وأنشئها بالعملة الصحيحة');
  await assertOpenPeriod(req.user, statement.createdAt, { session });
  if (body.createdAt !== undefined && (body.createdAt === null || typeof body.createdAt === 'boolean' || (typeof body.createdAt === 'string' && !body.createdAt.trim()))) throw new ErrorHandler(400, 'Choose a valid withdrawal date.');
  const day = body.createdAt === undefined ? statement.createdAt : new Date(body.createdAt);
  if (!day || isNaN(new Date(day).getTime())) throw new ErrorHandler(400, 'اختر تاريخًا صحيحًا');
  await assertOpenPeriod(req.user, day, { session });
  const amount = body.amount === undefined ? statement.amount : roundToTwo(positiveWalletAmount(body.amount));
  if (!(amount > 0)) throw new ErrorHandler(400, 'المبلغ يجب ألا يقل عن 0.01');
  const description = String(body.description ?? statement.description).trim();
  if (!description) throw new ErrorHandler(400, 'اكتب بيان السحب');
  const source = body.withdrawalSource ?? statement.withdrawalSource ?? 'box';
  const office = body.office ?? statement.office;
  const operations = require('../accounting/services/posting/operations');
  const actor = source === 'custody' ? { _id: statement.createdBy } : req.user;
  let funding;
  // An unchanged office/source keeps its explicitly recorded cash account. Changing
  // the office mapping later must not silently move an edited withdrawal to another box.
  if (source === 'box' && (statement.withdrawalSource || 'box') === 'box' && String(office || '') === String(statement.office || '') && statement.accountId) {
    const account = await require('../accounting/models').Account.findById(statement.accountId).session(session).lean();
    if (!account?.isActive || account.isGroup || !account.isCash || (account.currency || 'USD') !== statement.currency) throw new ErrorHandler(400, 'The original withdrawal account is unavailable. Choose a valid withdrawal source before saving.');
    funding = { account, office };
  } else {
    funding = await operations.resolveWithdrawalAccount(actor, office, statement.currency, source, session);
  }
  const { AccountingSettings, JournalEntry } = require('../accounting/models');
  const settings = await AccountingSettings.findOne({ key: 'main' }).session(session).lean();
  const hasEntry = await JournalEntry.exists({ 'source.model': 'UserStatement', 'source.id': statement._id, status: 'posted', reversalOf: null }).session(session);
  if (source === 'custody' && !settings?.liveEnabled && !hasEntry) throw new ErrorHandler(400, 'فعّل الترحيل المباشر قبل الصرف من العهدة');
  const allStatements = await UserStatement.find({ user: statement.user, currency: statement.currency }).sort({ _id: 1 }).session(session);
  const opening = getOpeningBalance(allStatements);
  const before = statement.toObject();
  const oldSigned = signedAmount(statement);
  statement.amount = amount; statement.createdAt = day; statement.description = description;
  statement.note = body.note === undefined ? statement.note : String(body.note);
  statement.actionType = 'withdrawal'; statement.withdrawalSource = source;
  statement.office = funding.office || office;
  statement.accountId = source === 'box' ? funding.account._id : undefined;
  statement.custodyEmployeeId = source === 'custody' ? statement.createdBy : undefined;
  if (body.rate !== undefined) {
    if (body.rate !== '' && body.rate !== null && (!Number.isFinite(Number(body.rate)) || Number(body.rate) <= 0)) throw new ErrorHandler(400, 'سعر الصرف يجب أن يكون موجبًا');
    statement.rate = body.rate === '' || body.rate === null ? undefined : Number(body.rate);
  }
  const editedFields = ['amount', 'createdAt', 'description', 'note', 'actionType', 'withdrawalSource', 'office', 'accountId', 'custodyEmployeeId', 'rate'];
  const sameValue = (field, left, right) => field === 'createdAt'
    ? new Date(left).getTime() === new Date(right).getTime()
    : field === 'amount' || field === 'rate' ? Number(left || 0) === Number(right || 0)
      : String(left?._id || left || '') === String(right?._id || right || '');
  if (editedFields.every(field => sameValue(field, before[field], statement[field]))) return statement.populate('user');
  statement.editHistory.push({ editedBy: req.user._id, editedAt: new Date(), before: Object.fromEntries(editedFields.map(field => [field, before[field]])) });
  await statement.save({ session });
  const delta = roundToTwo(signedAmount(statement) - oldSigned);
  if (delta) await adjustWalletBalance(statement.user, statement.currency, delta, session, 'The available customer wallet balance does not cover the additional withdrawal amount.');
  await rebuildStatementTotals(allStatements.map(item => String(item._id) === String(statement._id) ? statement : item), opening, session);
  const event = await emitAccountingEvent('statementUpdated', statement._id, {}, req.user, { session });
  if (settings?.liveEnabled || hasEntry) {
    const result = await operations.repostStatement(statement._id, { session, user: req.user });
    await finishWithdrawalEvents(statement._id, event, result, session, req);
  }
  await require('../accounting/services/audit').logAudit({ req, action: 'withdrawal.update', model: 'UserStatement', docId: statement._id, before, after: statement }, session);
  return UserStatement.findById(statement._id).session(session).populate('user');
}

module.exports.deleteStatement = async (req, res, next) => {
  try {
    const { statementId, id } = req.params;
    const result = await runInTransaction(async (session) => {

      const statement = await UserStatement.findOne({ _id: statementId, user: id }).session(session).populate('createdBy', 'firstName lastName');
      if (!statement) throw new ErrorHandler(404, 'Statement not found');
      if (statement.walletExchangeId || statement.actionType === 'exchange') throw new ErrorHandler(400, 'لا يمكن حذف طرف منفرد من عملية صرافة');
      if (statement.linkedCustomerRefundId || statement.linkedBankRefundLineId) throw new ErrorHandler(400, 'هذه الحركة مرتبطة باسترداد مورد؛ فك الربط قبل حذفها');
      // Outgoing payments are linked to orders and debts, only incoming ones can be changed here
      const withdrawal = isWithdrawal(statement);
      if (withdrawal) await assertEditableWithdrawal(statement, req, session);
      else if (statement.calculationType === '-') throw new ErrorHandler(400, 'Outgoing payments cannot be edited or deleted');
      const locked = protectedStatement(statement);
      if (locked) throw new ErrorHandler(400, locked);
      await assertOpenPeriod(req.user, statement.createdAt, { session });
      // A deposit whose money was already spent cannot be taken back from the wallet
      if (statement.calculationType === '+') {
        const current = await Wallet.findOne({ user: id, currency: statement.currency }).session(session).lean();
        if ((current?.balance || 0) - Number(statement.amount) < -0.001) throw new ErrorHandler(400, 'The money of this deposit was already spent from the wallet. Cancel the payments made from it first.');
      }

      const { currency } = statement;
      const allStatements = await UserStatement.find({ user: id, currency }).sort({ _id: 1 }).session(session);
      const openingBalance = getOpeningBalance(allStatements);

      // Archive first, so nothing is removed or changed if the archive cannot be written
      const snapshot = statement.toObject();
      const [archived] = await DeletedStatement.create([{
        originalId: statement._id,
        user: statement.user,
        currency,
        statement: {
          ...snapshot,
          createdBy: statement.createdBy?._id || snapshot.createdBy,
          createdByName: statement.createdBy?.firstName ? `${statement.createdBy.firstName} ${statement.createdBy.lastName || ''}`.trim() : undefined,
        },
        deletedBy: req.user._id,
        deletedAt: new Date(),
      }], { session });

      await UserStatement.deleteOne({ _id: statement._id }, { session });
      const deletionEvent = await emitAccountingEvent('statementDeleted', statement._id, {}, req.user, { session });
      if (withdrawal) {
        const reversed = await require('../accounting/services/posting/operations').reverseStatement(statement._id, { session, user: req.user });
        await finishWithdrawalEvents(statement._id, deletionEvent, reversed, session, req);
        await require('../accounting/services/audit').logAudit({ req, action: 'withdrawal.delete', model: 'UserStatement', docId: statement._id, before: snapshot, after: { archivedId: archived._id } }, session);
      }

      // Reverse the statement effect on the wallet: removing a deposit takes money out, removing a payment gives it back
      const wallet = await adjustWalletBalance(id, currency, -signedAmount(statement), session);
      await DeletedStatement.updateOne(
        { _id: archived._id },
        { $set: { walletBalanceBefore: wallet.before, walletBalanceAfter: wallet.after } },
        { session }
      );

      await rebuildStatementTotals(
        allStatements.filter((item) => String(item._id) !== String(statement._id)),
        openingBalance, session
      );

      return { deletedId: statement._id, walletBalance: wallet.after };
    });
    res.status(200).json({ results: result });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

const EDITABLE_STATEMENT_FIELDS = ['createdAt', 'description', 'note', 'amount', 'office', 'actionType'];

module.exports.updateStatement = async (req, res, next) => {
  try {
    const { statementId, id } = req.params;
    const result = await runInTransaction(async (session) => {

      const statement = await UserStatement.findOne({ _id: statementId, user: id }).session(session);
      if (!statement) throw new ErrorHandler(404, 'Statement not found');
      if (statement.walletExchangeId || statement.actionType === 'exchange' || req.body.actionType === 'exchange') throw new ErrorHandler(400, 'لا يمكن تعديل طرف منفرد من عملية صرافة');
      if (statement.linkedCustomerRefundId || statement.linkedBankRefundLineId) throw new ErrorHandler(400, 'هذه الحركة مرتبطة باسترداد مورد؛ فك الربط قبل تعديلها');
      if (isWithdrawal(statement)) return updateWithdrawal(statement, req.body, req, session);
      // Outgoing payments are linked to orders and debts, only incoming ones can be changed here
      if (statement.calculationType === '-') throw new ErrorHandler(400, 'Outgoing payments cannot be edited or deleted');

      const changes = {};
      EDITABLE_STATEMENT_FIELDS.forEach((field) => {
        if (req.body[field] === undefined) return;
        let value = req.body[field];

        if (field === 'amount') {
          value = roundToTwo(Number(value));
          if (!Number.isFinite(value) || value <= 0) throw new ErrorHandler(400, 'Amount must be greater than 0');
        }
        if (field === 'createdAt') {
          value = new Date(value);
          if (isNaN(value.getTime())) throw new ErrorHandler(400, 'Invalid date');
        }
        if ((field === 'office' || field === 'actionType') && value === '') value = undefined;

        const current = statement[field];
        const isSame = field === 'createdAt'
          ? new Date(current).getTime() === value.getTime()
          : String(current ?? '') === String(value ?? '');
        if (!isSame) changes[field] = value;
      });

      // Where the money went: a box of the office (no account) or a chosen account, such as a
      // partner's current account (Wasl), checked like a new deposit
      if (req.body.accountId !== undefined) {
        const next = req.body.accountId ? String((await moneyAccount(req.body.accountId, { currency: statement.currency, what: 'الحساب' }))._id) : null;
        if (String(statement.accountId || '') !== String(next || '')) changes.accountId = next;
      }
      let accountAfter = 'accountId' in changes ? changes.accountId : statement.accountId;
      // A date/amount edit must not reinterpret a bank deposit as branch cash.
      // Also pin the account of legacy alias-only deposits when they are reposted.
      if (POSTED_STATEMENT_FIELDS.some(field => field in changes)
        && statement.calculationType === '+'
        && ['cash', 'bank', undefined, null, ''].includes(changes.actionType ?? statement.actionType)) {
        const chosen = await resolveDepositAccount({ accountId: accountAfter,
          office: changes.office ?? statement.office, currency: statement.currency });
        if (chosen && String(accountAfter || '') !== String(chosen._id)) {
          changes.accountId = chosen._id;
          accountAfter = chosen._id;
        }
      }
      if (accountAfter && !['cash', 'bank', undefined, null, ''].includes(changes.actionType ?? statement.actionType)) {
        throw new ErrorHandler(400, 'A deposit into an account is cash or bank. Change the action type first.');
      }

      if (!Object.keys(changes).length) {
        return statement;
      }
      const postedChanged = POSTED_STATEMENT_FIELDS.some((field) => field in changes);
      const locked = protectedStatement(statement);
      if (locked && postedChanged) throw new ErrorHandler(400, locked);
      // A deposit cannot be turned into a payment given back: that kind reverses a payment
      if (RETURN_ACTIONS.includes(changes.actionType) || changes.actionType === 'withdrawal') {
        throw new ErrorHandler(400, 'An incoming line can only be cash, bank, refund or compensation. A payment given back or a withdrawal is made by its own action.');
      }
      // Neither the old date nor a new one may be in a closed period (owner excepted)
      await assertOpenPeriod(req.user, statement.createdAt, { session });
      // A deposit lowered below what was already spent from it would leave the wallet below zero
      if (changes.amount !== undefined && statement.calculationType === '+') {
        const current = await Wallet.findOne({ user: id, currency: statement.currency }).session(session).lean();
        if ((current?.balance || 0) + (Number(changes.amount) - Number(statement.amount)) < -0.001) throw new ErrorHandler(400, 'The money of this deposit was already spent from the wallet. Cancel the payments made from it first.');
      }
      if (changes.createdAt) await assertOpenPeriod(req.user, changes.createdAt, { session });
      if (('office' in changes || 'actionType' in changes || 'accountId' in changes) && !accountAfter) {
        await assertDepositPlace(changes.office ?? statement.office, statement.currency, changes.actionType ?? statement.actionType);
      }

      if (!String(changes.description ?? statement.description).trim()) {
        throw new ErrorHandler(400, 'Description is required');
      }

      const before = {};
      Object.keys(changes).forEach((field) => { before[field] = statement[field]; });

      const { currency } = statement;
      const allStatements = await UserStatement.find({ user: id, currency }).sort({ _id: 1 }).session(session);
      const openingBalance = getOpeningBalance(allStatements);
      const previousSigned = signedAmount(statement);

      Object.keys(changes).forEach((field) => { statement[field] = changes[field]; });
      statement.editHistory.push({ editedBy: req.user._id, editedAt: new Date(), before });
      await statement.save({ session });

      // Only an amount change moves money in the wallet
      const walletDelta = roundToTwo(signedAmount(statement) - previousSigned);
      if (walletDelta !== 0) {
        await adjustWalletBalance(id, currency, walletDelta, session);
      }

      await rebuildStatementTotals(
        allStatements.map((item) => (String(item._id) === String(statement._id) ? statement : item)),
        openingBalance, session
      );

      // Re-posted (old entry reversed, new one posted) only when something it is made from changed
      const event = postedChanged ? await emitAccountingEvent('statementUpdated', statement._id, {}, req.user, { session }) : null;
      // Moved to a partner's current account (Wasl): re-posted now, like a new deposit there, so the
      // partner's statement line already imported matches it at once
      if (event && 'accountId' in changes && changes.accountId) {
        const { settings, accountsById } = await require('../accounting/services/config').getConfig();
        const target = accountsById.get(String(changes.accountId));
        if (target?.cashKind === 'current' && settings.liveEnabled
          && !(await require('../accounting/services/posting/common').isBeforeCashCount(require('../accounting/services/dates').toDay(statement.createdAt)))) {
          const result = await require('../accounting/services/posting/operations').repostStatement(statement._id, { session, user: req.user });
          event.status = result?.skipped ? 'skipped' : 'done';
          event.result = result;
          event.processedAt = new Date();
          await event.save({ session });
          await require('../accounting/services/posting/bank').autoMatch(changes.accountId, { session, req });
        }
      }
      const updated = await UserStatement.findById(statement._id).session(session).populate('user');
      return updated;
    });
    res.status(200).json({ results: result });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getDeletedStatements = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.currency) query.currency = req.query.currency;

    const [results, totalCount] = await Promise.all([
      DeletedStatement.find(query)
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'firstName lastName customerId')
        .populate('deletedBy', 'firstName lastName')
        .lean(),
      DeletedStatement.countDocuments(query),
    ]);

    res.status(200).json({
      results,
      totalCount,
      hasMore: skip + results.length < totalCount,
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
}

module.exports.getUnverifiedUsersStatement = async (req, res, next) => {
  try {
    const { tab } = req.query;

    let userStatements;
    let query = [
      {
        $match: { review: { $exists: false } }  // Match documents where review does not exist
      },
      {
        $group: {
          _id: "$user",                          // Group by user field
        }
      },
      {
        $lookup: {
          from: "users",                        // Specify the 'users' collection to join with
          localField: "_id",                    // Use the _id field (which is user) in the current pipeline
          foreignField: "_id",                  // Match with the _id field in the 'users' collection
          as: "userDetails"                     // Name the new array field to add the user details
        }
      },
      {
        $unwind: "$userDetails"                 // Unwind the array to deconstruct it
      },
      {
        $replaceRoot: {                         // Replace the root with the userDetails document
          newRoot: "$userDetails"
        }
      }
    ]

    if (tab === 'openedWallet') {
      query = [
        {
          $group: {
            _id: "$user",                          // Group by user field
          }
        },
        {
          $lookup: {
            from: "users",                        // Specify the 'users' collection to join with
            localField: "_id",                    // Use the _id field (which is user) in the current pipeline
            foreignField: "_id",                  // Match with the _id field in the 'users' collection
            as: "userDetails"                     // Name the new array field to add the user details
          }
        },
        {
          $unwind: "$userDetails"                 // Unwind the array to deconstruct it
        },
        {
          $replaceRoot: {                         // Replace the root with the userDetails document
            newRoot: "$userDetails"
          }
        }
      ]
    }

    userStatements = await UserStatement.aggregate(query);

    if (!userStatements) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    res.status(200).json({
      results: userStatements
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 404, error.message));
  }
}

module.exports.getAllActiveWallets = async (req, res, next) => {
  try {
    const wallets = await Wallet.aggregate([
      {
        $group: {
          _id: "$user",
          // Sum up LYD specifically
          lydBalance: {
            $sum: { $cond: [{ $eq: ["$currency", "LYD"] }, "$balance", 0] }
          },
          // Sum up USD specifically
          usdBalance: {
            $sum: { $cond: [{ $eq: ["$currency", "USD"] }, "$balance", 0] }
          }
        }
      },
      // THIS IS THE FILTER YOU ASKED ABOUT:
      {
        $match: {
          $or: [
            { lydBalance: { $ne: 0 } },
            { usdBalance: { $ne: 0 } }
          ]
        }
      },
      {
        $lookup: {
          from: "users", 
          localField: "_id",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: "$user" },
      // Only what the wallet lists show - never the password hash.
      { $project: {
          lydBalance: 1,
          usdBalance: 1,
          'user._id': 1,
          'user.firstName': 1,
          'user.lastName': 1,
          'user.customerId': 1,
          'user.phone': 1,
          'user.imgUrl': 1,
          'user.city': 1,
      } },
    ]);

    res.status(200).json({ results: wallets });
  } catch (error) {
    next(error);
  }
};

// The accountant's dinar rate and the lowest rate a payment may use, for the wallet dialog
module.exports.getPaymentRate = async (req, res, next) => {
  try {
    res.status(200).json({ limits: await lydRateLimits(req.query.date) });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};

module.exports.useBalanceOfWallet = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { createdAt, amount, currency, description, note, orderId, category, rate, actionType, office } = req.body;
    if (actionType === 'exchange') throw new ErrorHandler(400, 'استخدم نافذة الصرافة لتسجيل طرفي التحويل معًا');
    const withdrawalSource = req.body.withdrawalSource || 'box';
    if (actionType === 'withdrawal' && !['box', 'custody'].includes(withdrawalSource)) throw new ErrorHandler(400, 'اختر مصدر السحب النقدي');
    if (actionType === 'withdrawal' && withdrawalSource === 'custody') {
      const { settings } = await require('../accounting/services/config').getConfig();
      if (!settings?.liveEnabled) throw new ErrorHandler(400, 'السحب من العهدة يحتاج إلى تفعيل الترحيل المحاسبي المباشر');
      if (!(req.user?.roles?.isEmployee || req.user?.roles?.isAccountant || req.user?.roles?.isAdmin)) throw new ErrorHandler(403, 'السحب من العهدة متاح للموظفين فقط');
    }
    const amountValue = roundToTwo(positiveWalletAmount(amount));
    if (amountValue <= 0) throw new ErrorHandler(400, 'Amount must be at least 0.01');

    // Dinars paid on an order are counted at a rate that may not be lower than the accountant's
    // rate by more than the tolerance
    if (category && currency === 'LYD') {
      if (!(Number(rate) > 0)) return next(new ErrorHandler(400, 'Enter the exchange rate the dinars are counted at.'));
      const limits = await lydRateLimits(createdAt);
      if (limits && Number(rate) < limits.minimum - 1e-9) {
        return next(new ErrorHandler(400, `The rate ${Number(rate)} is too low. The accountant's rate is ${limits.rate}, so the lowest allowed is ${limits.minimum}.`));
      }
    }

    const wallet = await Wallet.findOne({
      user: id,
      currency,
    });
    if (!wallet) return next(new ErrorHandler(404, errorMessages.WALLET_NOT_FOUND));

    if (wallet.balance < amountValue) {
      return next(new ErrorHandler(400, 'Insufficient wallet balance'));
    }

    if (actionType === 'withdrawal') {
      await require('../accounting/services/posting/operations').resolveWithdrawalAccount(req.user, office, currency, withdrawalSource);
    }

    let list = [];
    if (req.body.list && typeof req.body.list === 'string') {
      list = JSON.parse(req.body.list);
    }

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-wallets");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }

    const userStatement = await runInTransaction(async (session) => {
    const withdrawalSettings = actionType === 'withdrawal' ? await require('../accounting/services/periodLock').lockPeriod(session) : null;
    const funding = actionType === 'withdrawal'
      ? await require('../accounting/services/posting/operations').resolveWithdrawalAccount(req.user, office, currency, withdrawalSource, session)
      : null;
    if (withdrawalSource === 'custody' && actionType === 'withdrawal' && !withdrawalSettings?.liveEnabled) throw new ErrorHandler(400, 'السحب من العهدة يحتاج إلى تفعيل الترحيل المحاسبي المباشر');
    // Deducted atomically and only if the balance still covers it: two payments at the same moment
    // (a double click, two employees) cannot both spend the same money. It used to read the
    // balance, subtract, and write the result, so the second payment overwrote the first.
    const deducted = await Wallet.findOneAndUpdate(
      { user: id, currency, balance: { $gte: amountValue - 0.001 } },
      { $inc: { balance: -amountValue } },
      { new: true, session },
    );
    if (!deducted) throw new ErrorHandler(400, 'Insufficient wallet balance');
    await Wallet.updateOne({ _id: deducted._id, balance: deducted.balance }, { balance: Math.max(0, Math.round(deducted.balance * 100) / 100) }, { session });

    const lastUserStatement = await UserStatement.find({ user: id, currency }).sort({ _id: -1 }).limit(1).session(session);
    const previousTotal = Number(lastUserStatement[0]?.total || 0);

    // Calculate the running total in cents
    const total = roundToTwo(previousTotal - amountValue);

    const [userStatement] = await UserStatement.create([{
      user: id,
      createdBy: req.user,
      calculationType: '-',
      paymentType: 'wallet',
      createdAt,
      description,
      amount: amountValue,
      currency,
      total,
      note,
      actionType,
      office,
      ...(actionType === 'withdrawal' && { withdrawalSource, office: funding.office || office,
        ...(withdrawalSource === 'custody' ? { custodyEmployeeId: req.user._id } : { accountId: funding.account._id }) }),
      attachments: files,
      ...(currency === 'LYD' && Number(rate) > 0 && { rate: Number(rate) }),
    }], { session });

    const order = await Order.findOne({ orderId }).session(session).populate('user');
    if (order) {
      const data = {
        createdBy: req.user,
        customer: order.user._id,
        order: order._id,
        paymentType: 'wallet',
        receivedAmount: amountValue,
        currency,
        createdAt,
        rate: Number(rate) || 0,
        note: `(Wallet was ${roundToTwo(previousTotal)} ${currency})`
      };

      if (category) {
        data.category = category;
        if (category === 'receivedGoods') {
          data.list = list || [];
        }
      }

      data.statementId = userStatement._id;
      // A debt opened on this order for the same thing is paid down by this payment too
      if (category) {
        data.debtPayments = await payOrderDebts({ orderId: order._id, category, amount: data.receivedAmount, currency, rate: data.rate, createdAt, orderNumber: order.orderId }, { session });
      }
      await OrderPaymentHistory.create([data], { session });
    }
    await emitAccountingEvent('statement', userStatement._id, {
      target: { orderId: order?._id, category, packageIds: (list || []).map((p) => p?._id || p?.id).filter(Boolean) },
    }, req.user, { session });
    // Post every live withdrawal in the same transaction as the wallet deduction.
    // The queued event finds this entry and skips it, so it cannot post twice.
    if (actionType === 'withdrawal' && withdrawalSettings?.liveEnabled) {
      await require('../accounting/services/posting/operations').postStatement(userStatement._id, { session, user: req.user });
    }
    return userStatement;
    });

    res.status(200).json({
      createdAt: userStatement.createdAt
    });
  } catch (error) {
    return next(new ErrorHandler(error.statusCode || 500, error.message));
  }
};
