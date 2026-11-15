// Complaints and suggestions: customers send and follow theirs, staff manage all of them.
// A complaint is a conversation; either side may attach screenshots to any message.
const Feedback = require('../models/feedback');
const Order = require('../models/order');
const ErrorHandler = require('../utils/errorHandler');
const { saveToGoogleCloud } = require('../utils/googleClould');

const { KINDS, STATUSES, PRIORITIES, TOPICS } = Feedback;

const MAX_IMAGES = 5;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only real images: the first bytes decide, not the name or the browser's word
function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
const isImage = (buffer) => !!imageType(buffer);

// Checks every file before uploading any, so a bad one does not leave the others stored
async function uploadImages(files = []) {
  if (files.length > MAX_IMAGES) throw new ErrorHandler(400, `يمكن إرفاق ${MAX_IMAGES} صور كحد أقصى`);
  if (files.some((f) => !isImage(f.buffer))) throw new ErrorHandler(400, 'الملفات المرفقة يجب أن تكون صوراً (PNG أو JPG أو WEBP)');
  const images = [];
  for (const file of files) {
    const safe = { ...file, mimetype: imageType(file.buffer), originalname: (file.originalname || 'image').replace(/[^\w.\-]+/g, '_').slice(-60) };
    let result;
    try { result = await saveToGoogleCloud(safe, 'exios-feedback'); } catch (error) { result = null; console.error('[feedback] image upload failed:', error.message); }
    if (!result?.publicUrl) throw new ErrorHandler(502, 'تعذر رفع الصور، حاول مرة أخرى');
    images.push({ url: result.publicUrl, name: file.originalname || '' });
  }
  return images;
}

const imagesOut = (list = []) => list.map((i) => ({ url: i.url, name: i.name }));

// The conversation as the customer sees it: staff names stay inside the office
const threadForCustomer = (f) => [
  { _id: `${f._id}-0`, from: 'customer', text: f.message, images: imagesOut(f.images), at: f.createdAt },
  ...(f.messages || []).map((m) => ({ _id: m._id, from: m.from, text: m.text, images: imagesOut(m.images), at: m.at })),
];

// What a customer may see of their own feedback: no internal notes, no staff history
const forCustomer = (f) => ({
  _id: f._id,
  number: f.number,
  kind: f.kind,
  topic: f.topic,
  subject: f.subject,
  orderRef: f.orderRef,
  status: f.status,
  resolvedAt: f.resolvedAt,
  unread: f.kind === 'complaint' && !!f.unreadByCustomer,
  canReply: f.kind === 'complaint' && f.status !== 'closed',
  messages: threadForCustomer(f),
  createdAt: f.createdAt,
  lastMessageAt: f.lastMessageAt || f.createdAt,
});

async function nextNumber() {
  const last = await Feedback.findOne({}, { number: 1 }).sort({ number: -1 }).lean();
  return (last?.number || 1000) + 1;
}

const fail = (next, error) => next(error instanceof ErrorHandler ? error : new ErrorHandler(500, error.message));

// POST /client/feedback (multipart: kind, topic, subject, message, order | orderRef, images[])
module.exports.create = async (req, res, next) => {
  try {
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : null;
    const subject = text(req.body.subject, 140);
    const message = text(req.body.message, 4000);
    if (!kind) return next(new ErrorHandler(400, 'اختر نوع الطلب: شكوى أو اقتراح'));
    if (subject.length < 3) return next(new ErrorHandler(400, 'اكتب عنواناً قصيراً للطلب'));
    if (message.length < 10) return next(new ErrorHandler(400, 'اكتب التفاصيل في 10 أحرف على الأقل'));

    // A customer may send at most 5 in an hour
    const recent = await Feedback.countDocuments({ user: req.user._id, createdAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) } });
    if (recent >= 5) return next(new ErrorHandler(429, 'أرسلت عدة طلبات خلال الساعة الأخيرة، حاول لاحقاً'));

    let orderRef = kind === 'complaint' ? text(req.body.orderRef, 40) : '';
    let order = null;
    if (kind === 'complaint') {
      // Picked from the customer's list: kept only when the order is theirs
      if (req.body.order && /^[a-f\d]{24}$/i.test(String(req.body.order))) {
        const picked = await Order.findOne({ _id: req.body.order, user: req.user._id }, { orderId: 1 }).lean();
        if (picked) { order = picked._id; orderRef = picked.orderId; }
      }
      if (!order && orderRef) {
        const found = await Order.findOne({ user: req.user._id, orderId: new RegExp(`^${escapeRegex(orderRef)}$`, 'i') }, { _id: 1 }).lean();
        order = found?._id || null;
      }
    }

    const images = await uploadImages(req.files);

    // Two customers sending at the same moment can draw the same number: retry on the unique index
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const doc = await Feedback.create({
          number: await nextNumber(),
          user: req.user._id,
          kind,
          topic: TOPICS.includes(req.body.topic) ? req.body.topic : 'other',
          subject,
          message,
          images,
          orderRef,
          order,
          priority: kind === 'complaint' ? 'normal' : 'low',
          history: [{ action: 'created', value: 'new', by: req.user._id }],
        });
        return res.status(201).json(forCustomer(doc));
      } catch (error) {
        if (error.code !== 11000 || attempt === 2) throw error;
      }
    }
  } catch (error) {
    return fail(next, error);
  }
};

// GET /client/feedback
module.exports.mine = async (req, res, next) => {
  try {
    const list = await Feedback.find({ user: req.user._id }).sort({ lastMessageAt: -1, createdAt: -1 }).limit(100).lean();
    res.json(list.map(forCustomer));
  } catch (error) {
    return fail(next, error);
  }
};

// POST /client/feedback/:id/messages (multipart: text, images[]): the customer answers the office
module.exports.customerReply = async (req, res, next) => {
  try {
    const doc = await Feedback.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) return next(new ErrorHandler(404, 'الطلب غير موجود'));
    if (doc.kind !== 'complaint') return next(new ErrorHandler(400, 'لا يمكن الرد على اقتراح'));
    if (doc.status === 'closed') return next(new ErrorHandler(400, 'هذه الشكوى مغلقة. أرسل شكوى جديدة إذا احتجت'));
    const body = text(req.body.text, 4000);
    if (!body && !req.files?.length) return next(new ErrorHandler(400, 'اكتب رسالة أو أرفق صورة'));
    const hourAgo = Date.now() - 60 * 60 * 1000;
    if (doc.messages.filter((m) => m.from === 'customer' && +m.at > hourAgo).length >= 10) {
      return next(new ErrorHandler(429, 'أرسلت عدة رسائل خلال الساعة الأخيرة، حاول لاحقاً'));
    }

    const images = await uploadImages(req.files);
    const now = new Date();
    doc.messages.push({ from: 'customer', text: body, images, by: req.user._id, at: now });
    doc.unreadByStaff = true;
    doc.unreadByCustomer = false;
    doc.lastMessageAt = now;
    doc.history.push({ action: 'message', value: 'customer', by: req.user._id, at: now });
    // The customer writing again after "resolved" means it is not resolved for them
    if (doc.status === 'resolved') {
      doc.status = 'in_progress';
      doc.resolvedAt = null;
      doc.history.push({ action: 'status', value: 'in_progress', by: req.user._id, at: now });
    }
    await doc.save();
    res.status(201).json(forCustomer(doc));
  } catch (error) {
    return fail(next, error);
  }
};

// GET /client/feedback/orders: the customer's recent orders, to pick the one a complaint is about
module.exports.myOrders = async (req, res, next) => {
  try {
    const orders = await Order.find(
      { user: req.user._id, isCanceled: { $ne: true } },
      { orderId: 1, productName: 1, createdAt: 1, isShipment: 1, isPayment: 1, isRemittance: 1, isFinished: 1, 'shipment.method': 1, 'shipment.fromWhere': 1 },
    ).sort({ createdAt: -1 }).limit(40).lean();
    res.json(orders.map((o) => ({
      _id: o._id,
      orderId: o.orderId,
      productName: o.productName || '',
      createdAt: o.createdAt,
      kind: o.isRemittance ? 'remittance' : o.isPayment ? 'purchase' : 'shipping',
      method: o.shipment?.method || '',
      from: o.shipment?.fromWhere || '',
      finished: !!o.isFinished,
    })));
  } catch (error) {
    return fail(next, error);
  }
};

// POST /client/feedback/:id/seen: the customer opened the office's answer
module.exports.seen = async (req, res, next) => {
  try {
    await Feedback.updateOne({ _id: req.params.id, user: req.user._id }, { unreadByCustomer: false });
    res.json({ ok: true });
  } catch (error) {
    return fail(next, error);
  }
};

const STAFF_POPULATE = [
  { path: 'user', select: 'firstName lastName customerId phone' },
  { path: 'order', select: 'orderId' },
  { path: 'assignedTo', select: 'firstName lastName' },
  { path: 'messages.by', select: 'firstName lastName' },
  { path: 'notes.by', select: 'firstName lastName' },
  { path: 'history.by', select: 'firstName lastName' },
];
const staffView = (id) => Feedback.findById(id).populate(STAFF_POPULATE).lean();

// GET /feedback
module.exports.list = async (req, res, next) => {
  try {
    const list = await Feedback.find({}).sort({ lastMessageAt: -1, createdAt: -1 }).limit(2000).populate(STAFF_POPULATE).lean();
    res.json(list);
  } catch (error) {
    return fail(next, error);
  }
};

// POST /feedback/:id/messages (multipart: text, images[]): the office answers the customer
module.exports.staffReply = async (req, res, next) => {
  try {
    const doc = await Feedback.findById(req.params.id);
    if (!doc) return next(new ErrorHandler(404, 'not-found'));
    if (doc.kind !== 'complaint') return next(new ErrorHandler(400, 'الاقتراحات لا تحتاج رداً'));
    const body = text(req.body.text, 4000);
    if (!body && !req.files?.length) return next(new ErrorHandler(400, 'اكتب رداً أو أرفق صورة'));

    const images = await uploadImages(req.files);
    const now = new Date();
    const by = req.user._id;
    doc.messages.push({ from: 'staff', text: body, images, by, at: now });
    doc.unreadByCustomer = true;
    doc.unreadByStaff = false;
    doc.lastMessageAt = now;
    doc.history.push({ action: 'message', value: 'staff', by, at: now });
    // Answering a new complaint means someone is on it
    if (doc.status === 'new') {
      doc.status = 'in_progress';
      doc.history.push({ action: 'status', value: 'in_progress', by, at: now });
    }
    await doc.save();
    res.status(201).json(await staffView(doc._id));
  } catch (error) {
    return fail(next, error);
  }
};

// PUT /feedback/:id  { status?, priority?, assignedTo?, note?, seen? }
module.exports.update = async (req, res, next) => {
  try {
    const doc = await Feedback.findById(req.params.id);
    if (!doc) return next(new ErrorHandler(404, 'not-found'));
    const by = req.user._id;
    const now = new Date();
    const { status, priority, assignedTo } = req.body;

    if (status !== undefined && status !== doc.status) {
      if (!STATUSES.includes(status)) return next(new ErrorHandler(400, 'invalid-status'));
      doc.status = status;
      doc.resolvedAt = status === 'resolved' || status === 'closed' ? now : null;
      if (doc.kind === 'complaint') doc.unreadByCustomer = true;
      doc.history.push({ action: 'status', value: status, by, at: now });
    }
    if (priority !== undefined && priority !== doc.priority) {
      if (!PRIORITIES.includes(priority)) return next(new ErrorHandler(400, 'invalid-priority'));
      doc.priority = priority;
      doc.history.push({ action: 'priority', value: priority, by, at: now });
    }
    if (assignedTo !== undefined && String(assignedTo || '') !== String(doc.assignedTo || '')) {
      doc.assignedTo = assignedTo || null;
      doc.history.push({ action: 'assign', value: assignedTo ? String(assignedTo) : '', by, at: now });
    }
    if (req.body.seen === true) doc.unreadByStaff = false;
    const note = text(req.body.note, 2000);
    if (note) doc.notes.push({ text: note, by, at: now });

    await doc.save();
    res.json(await staffView(doc._id));
  } catch (error) {
    return fail(next, error);
  }
};

// DELETE /feedback/:id
module.exports.remove = async (req, res, next) => {
  try {
    await Feedback.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (error) {
    return fail(next, error);
  }
};

module.exports.MAX_IMAGES = MAX_IMAGES;
