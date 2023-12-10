const express = require('express');

const tasks = require('../controllers/tasks');
const { protect, allowAdminsAndEmployee } = require('../middleware/check-auth');
const multer = require('multer');
const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
            fileSize: 10 * 1024 * 1024, // No larger than 5mb, change as you need
      },
});
const router  = express.Router();

router.route('/mytasks')
      .get(protect, allowAdminsAndEmployee, tasks.getMyTasks)

router.route('/task/:id')
      .get(protect, allowAdminsAndEmployee, tasks.getTask)
      .put(protect, allowAdminsAndEmployee, tasks.updateTask)

router.route('/task/:id/readed')
      .post(protect, allowAdminsAndEmployee, tasks.markAsReaded)

router.route('/task/:id/status')
      .put(protect, allowAdminsAndEmployee, tasks.changeTaskStatus)

router.route('/create/task')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), tasks.createTask)

router.route('/task/uploadFiles')
      .post(protect, allowAdminsAndEmployee, upload.array('files'), tasks.uploadFiles)
      .delete(protect, allowAdminsAndEmployee, tasks.deleteFile)

router.route('/task/:id/comments')
      .get(protect, allowAdminsAndEmployee, tasks.getComments)
      .post(protect, allowAdminsAndEmployee, tasks.createComment)

module.exports = router;
