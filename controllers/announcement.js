const Announcements = require('../models/announcement.js');
const Posts = require('../models/posts');
const ErrorHandler = require('../utils/errorHandler');

module.exports.getAnnouncements = async (req, res, next) => {
  try {
    const announcements = await Announcements.find({});
    res.status(200).json(announcements);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createAnnouncements = async (req, res, next) => {
  try {
    const { description } = req.body;
    const announcement = await Announcements.create({
      description
    })
    res.status(200).json(announcement);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.deleteAnnouncement = async (req, res, next) => {
  try {
    const { _id } = req.body;
    const announcement = await Announcements.deleteOne({
      _id
    })
    res.status(200).json(announcement);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateAnnouncements = async (req, res, next) => {
  try {
    const announcements = req.body;
    announcements.forEach(async (announcement) => {
      await Announcements.updateOne({ _id: announcement._id }, {
        $set: {
          description: announcement.description
        }
      })
    });
    res.status(200).json({ updatedAt: new Date() });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getActivePosts = async (req, res) => {
  try {
    const posts = await Posts.find({
      isActive: true
    }).sort({ publishedAt: -1 });

    res.json({ results: posts });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
};


// ✅ Create Post
module.exports.createPost = async (req, res) => {
  try {
    const { title, message, type, isActive, publishedAt } = req.body;

    const newPost = await Posts.create({
      title,
      message,
      type,
      isActive,
      publishedAt,
    });

    res.status(201).json({ message: "Post created successfully", post: newPost });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Update Post
module.exports.updatePost = async (req, res) => {
  try {
    const { id } = req.params;

    const updatedPost = await Posts.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    if (!updatedPost) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json({ message: "Post updated successfully", post: updatedPost });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

// ✅ Delete Post
module.exports.deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPost = await Posts.findByIdAndDelete(id);

    if (!deletedPost) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json({ message: "Post deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};