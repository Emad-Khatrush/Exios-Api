const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const announcementSchema = new Schema({
  description: {
    type: String,
  },
  forwardLink: String,
  visibleToAll: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model("Announcement", announcementSchema);
