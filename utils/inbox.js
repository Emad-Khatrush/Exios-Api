// Saves a message to customers' notifications page (models/customerNotification.js). utils/push.js
// calls it for every message before trying the phones, so the page has them all, also for
// customers who never turned phone notifications on, and on QA where pushes are off.
// Never throws: a page entry that can't be saved never fails what the staff member did.
const CustomerNotification = require('../models/customerNotification');

const clean = ({ title, body = '', url = '/home', tag = '' }) => ({
  title: String(title || '').slice(0, 200),
  body: String(body || '').slice(0, 1000),
  url: String(url || '/home').slice(0, 300),
  tag: String(tag || '').slice(0, 100),
});

// To these customers, one entry each
async function saveForUsers(userIds, message) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
    if (!ids.length || !message?.title) return 0;
    const entry = clean(message);
    await CustomerNotification.insertMany(ids.map((user) => ({ ...entry, user })), { ordered: false });
    return ids.length;
  } catch (error) {
    console.error('[inbox] save failed:', error.message);
    return 0;
  }
}

// To every customer: one entry the page of each of them shows
async function saveForAll(message) {
  try {
    if (!message?.title) return 0;
    await CustomerNotification.create({ ...clean(message), user: null });
    return 1;
  } catch (error) {
    console.error('[inbox] save failed:', error.message);
    return 0;
  }
}

module.exports = { saveForUsers, saveForAll };
