const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const taskSchema = new Schema({
  order: { type: Schema.Types.ObjectId, ref: 'Order' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  status: {
    type: String,
    required: true,
    default: 'processing',
    enum: ['processing', 'needsApproval', 'finished']
  },
  label: {
    type: String,
    default: 'normal',
    enum: ['urgent', 'limitedTime', 'normal']
  },
  limitedTime: String,
  reviewers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  comments: [{ type: Schema.Types.ObjectId, ref: 'Comment' }],
  files: [{
    filename: String,
    path: String,
    folder: String,
    bytes: Number,
    fileType: {
      type: String,
    }
  }]

}, { timestamps: true });

module.exports = mongoose.model("Task", taskSchema);
