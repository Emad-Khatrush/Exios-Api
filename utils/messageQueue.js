const Queue = require('bull');

// Shared Bull queue instance - created once here so both app.js (which
// processes/adds jobs) and controllers (which need to cancel pending jobs,
// e.g. when a campaign is deleted) reference the exact same queue.
const sendMessageQueue = new Queue('send-message', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASS,
  }
});

module.exports = sendMessageQueue;
