const express = require('express');

const tasks = require('../controllers/tasks');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const { allow, anyStaff } = require('../middleware/permissions');
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});
const router  = express.Router();

router.route('/mytasks')
      .get(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.getMyTasks)

router.route('/task/:id')
      .get(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.getTask)
      .put(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.updateTask)

router.route('/task/:id/readed')
      .post(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.markAsReaded)

router.route('/task/:id/status')
      .put(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.changeTaskStatus)

router.route('/create/task')
      .post(protect, allow(['tasks'], allowAdminsAndEmployee), upload.array('files'), tasks.createTask)

router.route('/task/uploadFiles')
      .post(protect, allow(['tasks'], allowAdminsAndEmployee), upload.array('files'), tasks.uploadFiles)
      .delete(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.deleteFile)

router.route('/task/:id/comments')
      .get(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.getComments)
      .post(protect, allow(['tasks'], allowAdminsAndEmployee), tasks.createComment)

module.exports = router;
