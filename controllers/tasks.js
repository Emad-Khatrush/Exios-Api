const Task = require('../models/task');
const ErrorHandler = require('../utils/errorHandler');
const { errorMessages } = require('../constants/errorTypes');
const Order = require('../models/order');
const { uploadToGoogleCloud } = require('../utils/googleClould');
const Comment = require('../models/comment');
const Notifications = require('../models/notifications');
const { TaskCollection } = require('../utils/dbCollections');
const mongodb = require('mongodb');
const { ObjectId } = mongodb;

module.exports.getMyTasks = async (req, res, next) => {
  const { taskType } = req.query;
  try {
    const nowDate = new Date();
    nowDate.setDate(nowDate.getDate() - 2);
    let mongoQuery = {
      notifications: { $or: [ { reviewers: { $in: [req.user._id] } }, { createdBy: req.user._id } ], hasNotification: true },
      urgent: { $or: [ { reviewers: { $in: [req.user._id] } } ], status: 'processing', label: 'urgent' },
      myTasks: { $or: [ { reviewers: { $in: [req.user._id] } } ], status: 'processing' },
      requestedTasks: { createdBy: req.user._id, status: 'processing' },
      needsApproval: { createdBy: req.user._id, status: 'needsApproval' },
      waitingApproval: { createdBy: { $nin: [req.user._id] }, reviewers: { $in: [req.user._id] }, status: 'needsApproval' },
      finished: { $or: [ { reviewers: { $in: [req.user._id] } }, { createdBy: req.user._id } ], status: 'finished' }
    };
    let tasks = await Task.aggregate([
      {
        $lookup: {
          from: 'notifications',
          localField: '_id',
          foreignField: 'entityId',
          as: 'hasNotification'
        }
      },
      {
        $addFields: {
          hasNotificationFiltered: {
            $filter: {
              input: "$hasNotification",
              as: "notification",
              cond: { $eq: ["$$notification.user", ObjectId(req.user._id)] }
            }
          }
        }
      },
      {
        $addFields: {
          hasNotification: { $gt: [{ $size: "$hasNotificationFiltered" }, 0] }
        }
      },
      { $match: mongoQuery[taskType] },
      { $sort: { createdAt: -1 } },
    ]);
    tasks = await Task.populate(tasks, [{ path: 'reviewers' }, { path: 'order' }, { path: 'createdBy' }, { path: 'comments' }]);

    let tasksCountList = (await Task.aggregate([
      {
        $lookup: {
          from: 'notifications',
          localField: '_id',
          foreignField: 'entityId',
          as: 'hasNotification'
        }
      },
      {
        $addFields: {
          hasNotificationFiltered: {
            $filter: {
              input: "$hasNotification",
              as: "notification",
              cond: { $eq: ["$$notification.user", req.user._id] }
            }
          }
        }
      },
      {
        $addFields: {
          hasNotification: { $gt: [{ $size: "$hasNotificationFiltered" }, 0] }
        }
      },
      {
        $group: {
          _id: null,
          notificationsCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$hasNotification", true] },
                  {
                    $or: [
                      { $in: [req.user._id, "$reviewers"] }, // Check if req.user._id is in the "reviewers" array
                      { $eq: ["$createdBy", req.user._id] }, 
                    ]
                  }
                ]
              } ,
                1,
                0
              ]
            }
          },
          myTasksCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'processing'] }, 
                  { $in: [req.user._id, "$reviewers"] } // Check if req.user._id is in the "reviewers" array
                ]},
                1,
                0
              ]
            }
          },
          urgentCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'processing'] }, 
                  { $eq: ["$label", 'urgent'] }, 
                  { $in: [req.user._id, "$reviewers"] } // Check if req.user._id is in the "reviewers" array
                ]},
                1,
                0
              ]
            }
          },
          requestedTasksCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'processing'] }, 
                  { $eq: ["$createdBy", req.user._id] }, 
                ]},
                1,
                0
              ]
            }
          },
          needsApproval: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'needsApproval'] }, 
                  { $eq: ["$createdBy", req.user._id] }, 
                ]},
                1,
                0
              ]
            }
          },
          waitingApproval: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'needsApproval'] },
                  { $in: [req.user._id, "$reviewers"] }, // Check if req.user._id is in the "reviewers" array
                  { $ne: ["$createdBy", req.user._id] }     // Use $ne to check for inequality
                ]},
                1,
                0
              ]
            }
          },
          finishedCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ["$status", 'finished'] },
                  {
                    $or: [
                      { $in: [req.user._id, "$reviewers"] }, // Check if req.user._id is in the "reviewers" array
                      { $eq: ["$createdBy", req.user._id] }, 
                    ]
                  }
                ]},
                1,
                0
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 0
        }
      }
    ]))[0];

    const { notificationsCount, myTasksCount, urgentCount, requestedTasksCount, needsApproval, finishedCount, waitingApproval } = tasksCountList;

    // add count list
    res.status(200).json({
      results: tasks,
      countList: {
        notificationsCount,
        myTasksCount,
        urgentCount,
        finishedCount,
        requestedTasksCount,
        needsApproval,
        waitingApproval
      }
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.createTask = async (req, res, next) => {
  try {
    if (!req.body) {
      return next(new ErrorHandler(400, errorMessages.FIELDS_EMPTY));
    }
    const { orderId, title, description, label, limitedTime } = req.body;
    const order = await Order.findOne({ orderId });
    if (!order) {
      return next(new ErrorHandler(400, errorMessages.ORDER_NOT_FOUND));
    }

    const files = [];
    if (req.files) {
      for (let i = 0; i < req.files.length; i++) {
        const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-tasks");
        files.push({
          path: uploadedImg.publicUrl,
          filename: uploadedImg.filename,
          folder: uploadedImg.folder,
          bytes: uploadedImg.bytes,
          fileType: req.files[i].mimetype
        });
      }
    }
  
    const reviewers = JSON.parse(req.body.reviewers[1]);

    const task = await Task.create({
      order: order,
      createdBy: req.user,
      title,
      description,
      label,
      files,
      reviewers,
      limitedTime
    })

    reviewers.forEach(async (user) => {
      await Notifications.create({
        notificationType: TaskCollection,
        entityId: task._id,
        user: user
      })
    })

    res.status(200).json(task);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.getTask = async (req, res, next) => {
  try {
    const { id } = req.params
    const task = await Task.findOne({ _id: id }).populate(['order', 'createdBy', 'reviewers', 'comments']);
    
    if (!task) next(new ErrorHandler(404, errorMessages.TASK_NOT_FOUND));

    res.status(200).json(task);

  } catch (error) {
    return next(new ErrorHandler(404, errorMessages.SERVER_ERROR));
  }
}

module.exports.uploadFiles= async (req, res, next) => {
  const { id } = req.body;
  
  const images = [];
  const changedFields = [];

  if (req.files) {
    for (let i = 0; i < req.files.length; i++) {
      const uploadedImg = await uploadToGoogleCloud(req.files[i], "exios-admin-tasks");
      images.push({
        path: uploadedImg.publicUrl,
        filename: uploadedImg.filename,
        folder: uploadedImg.folder,
        bytes: uploadedImg.bytes,
        category: req.body.type,
        fileType: req.files[i].mimetype
      });
      changedFields.push({
        label: 'image',
        value: 'image',
        changedFrom: '',
        changedTo: uploadedImg.publicUrl
      })
    }
  }

  const task = await Task.findByIdAndUpdate(id, {
    $push: { "files": images },
  }, { safe: true, upsert: true, new: true });
  
  const reviewers = [ ...task.reviewers ];
  if (req.user._id !== task.createdBy) {
    reviewers.push(task.createdBy);
  }

  reviewers.forEach(async (user) => {
    if (!req.user._id.equals(user)) {
      await Notifications.create({
        notificationType: TaskCollection,
        entityId: id,
        user: user
      })
    }
  })

  res.status(200).json(task)
}

module.exports.updateTask = async (req, res, next) => {
  const id = req.params.id;
  if (!id) return next(new ErrorHandler(404, errorMessages.TASK_NOT_FOUND));

  try {
    const order = await Order.findOne({ orderId: req.body.orderId });
    if (!order) {
      return next(new ErrorHandler(400, errorMessages.ORDER_NOT_FOUND));
    }
    
    const updateQuery = {
      ...req.body,
      $set: { "reviewers": req.body.reviewers },
    }
    
    const task = await Task.findByIdAndUpdate(String(id), updateQuery, { safe: true, upsert: true, new: true }).populate(['order', 'createdBy', 'reviewers', 'comments']);
    if (!task) return next(new ErrorHandler(404, errorMessages.TASK_NOT_FOUND));

    const reviewers = [ ...task.reviewers ];
    if (req.user._id !== task.createdBy._id) {
      reviewers.push(task.createdBy);
    }

    reviewers.forEach(async (user) => {
      if (!req.user._id.equals(user._id)) {
        await Notifications.create({
          notificationType: TaskCollection,
          entityId: id,
          user: user._id
        })
      }
    })

    res.status(200).json(task);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}
module.exports.deleteFile = async (req, res, next) => {
  try {
    const task = await Task.findByIdAndUpdate(req.body.id, {
      $pull: {
        files: {
          filename: req.body.file.filename
        }
      }
    }, { safe: true, upsert: true, new: true });

    const reviewers = [ ...task.reviewers ];
    if (req.user._id !== task.createdBy) {
      reviewers.push(task.createdBy);
    }
    
    reviewers.forEach(async (user) => {
      if (!req.user._id.equals(user)) {
        await Notifications.create({
          notificationType: TaskCollection,
          entityId: req.body.id,
          user: user
        })
      }
    })

    res.status(200).json(task);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.changeTaskStatus = async (req, res, next) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, {
      status: req.body.status
    }, { safe: true, upsert: true, new: true });

    const reviewers = [ ...task.reviewers ];
    if (req.user._id !== task.createdBy) {
      reviewers.push(task.createdBy);
    }
    
    reviewers.forEach(async (user) => {
      if (!req.user._id.equals(user)) {
        await Notifications.create({
          notificationType: TaskCollection,
          entityId: req.params.id,
          user: user
        })
      }
    })

    res.status(200).json(task);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getComments = async (req, res, next) => {
  try {
    let task = await Task.findOne({ _id: req.params.id });
    if (!task) {
      return next(new ErrorHandler(400, errorMessages.TASK_NOT_FOUND));
    }

    const comments = await Comment.find({ task }).sort({ createdAt: -1 }).populate('createdBy');
    
    res.status(200).json(comments);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.createComment = async (req, res, next) => {
  try {
    let task = await Task.findOne({ _id: req.params.id });
    if (!task) {
      return next(new ErrorHandler(400, errorMessages.TASK_NOT_FOUND));
    }

    const comment = await Comment.create({
      createdBy: req.user,
      message: req.body.message,
      task
    });

    const updateQuery = {
      $push: { "comments": comment },
    }
    
    task = await Task.findByIdAndUpdate(String(req.params.id), updateQuery, { safe: true, upsert: true, new: true }).populate(['order', 'createdBy', 'reviewers']);

    const reviewers = [ ...task.reviewers ];
    if (req.user._id !== task.createdBy._id) {
      reviewers.push(task.createdBy);
    }
    
    reviewers.forEach(async (user) => {
      if (!req.user._id.equals(user._id)) {
        await Notifications.create({
          notificationType: TaskCollection,
          entityId: String(req.params.id),
          user: user._id
        })
      }
    })

    res.status(200).json(task);
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.markAsReaded = async (req, res, next) => {
  try {
    let task = await Task.exists({ _id: req.params.id });
    if (!task) {
      return next(new ErrorHandler(400, errorMessages.TASK_NOT_FOUND));
    }

    await Notifications.deleteMany({ entityId: ObjectId(task._id), user: ObjectId(req.user._id) });

    res.status(200).json({ isSuccess: true });
  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(404, error.message));
  }
}
