// A complaint or a suggestion a customer sends from the app, and how the office handled it.
// A complaint is a conversation: the customer's first message, then replies from both sides,
// each with optional screenshots. A suggestion is only delivered and read.
// Internal notes and the history stay with the staff.
const mongoose = require('mongoose');

const { Schema } = mongoose;

const KINDS = ['complaint', 'suggestion'];
const STATUSES = ['new', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high'];
const TOPICS = ['shipping', 'delay', 'damage', 'pricing', 'payment', 'staff', 'app', 'other'];

const imageSchema = new Schema({
  url: { type: String, required: true },
  name: { type: String, default: '' },
}, { _id: false });

const messageSchema = new Schema({
  from: { type: String, enum: ['customer', 'staff'], required: true },
  text: { type: String, trim: true, default: '', maxlength: 4000 },
  images: { type: [imageSchema], default: [] },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now },
});

const feedbackSchema = new Schema({
  // A short running number the customer can quote on WhatsApp ("#1042")
  number: { type: Number, unique: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: KINDS, required: true },
  topic: { type: String, enum: TOPICS, default: 'other' },
  subject: { type: String, trim: true, required: true, maxlength: 140 },
  // The first message, as the customer sent it
  message: { type: String, trim: true, required: true, maxlength: 4000 },
  images: { type: [imageSchema], default: [] },
  // The order number the customer typed or picked, and the order when it is theirs
  orderRef: { type: String, trim: true, default: '' },
  order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
  status: { type: String, enum: STATUSES, default: 'new', index: true },
  priority: { type: String, enum: PRIORITIES, default: 'normal' },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
  // The replies after the first message, both sides, oldest first
  messages: { type: [messageSchema], default: [] },
  // Who has something new to read
  unreadByCustomer: { type: Boolean, default: false },
  unreadByStaff: { type: Boolean, default: true },
  lastMessageAt: { type: Date, default: Date.now },
  // Staff only
  notes: [{
    text: { type: String, trim: true, maxlength: 2000 },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  }],
  history: [{
    action: String, // 'created' | 'status' | 'message' | 'priority' | 'assign'
    value: String,
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

feedbackSchema.index({ createdAt: -1 });

const Feedback = mongoose.model('Feedback', feedbackSchema);
module.exports = Feedback;
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
module.exports.TOPICS = TOPICS;
