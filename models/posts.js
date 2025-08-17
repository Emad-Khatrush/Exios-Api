// models/Post.js
const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["info", "warning", "success", "error"],
      default: "info",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      default: null, // ممكن تخليه null لو الإعلان دائم
    },
    publishedAt: {
      type: Date,
      default: null, // ممكن تخليه null لو الإعلان دائم
    },
  },
  { timestamps: true }
);

postSchema.path("createdAt").immutable(false);

module.exports = mongoose.model("Post", postSchema);
